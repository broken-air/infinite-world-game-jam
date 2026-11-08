"""Playwright 全流程浏览器验证（Task 7 · 预写版，待 B 的仓库模块合并后运行）。

覆盖计划 Task 7 Step 1 的全部场景：
  1. 残血空背包完整通关：成功只交档一次，密码按当局扫码顺序计算，存档不被满血覆盖
  2. 携带其他理智道具：不触发捷径，仍需手动调频
  3. 背包含待替换遗物 ID 字面量：不得误触发捷径（Review Focus 4）
  4. 携带真实目标遗物：免调频捷径（仅当 handoff.js 已替换真实 ID 时运行，否则 SKIP）
  5. 内嵌模式：首次 iw-save-ready 到达前不挂载玩法（等待态）
  6. 内嵌模式：挂载后收到更新存档走 updateContext，不丢接待进度
  7. 放弃流程：失败交接只提交一次，原因固定
  8. 官方协议 standalone 完整实跑：记录协议校验行为（standalone 无 nextUrl，
     官方 completeLevel 按设计返回 null 并显示交接错误框，恰好尝试一次）
  9. 官方协议内嵌 + itemManifest（真实大厅路径）：IW_INIT_SAVE 握手 → 完整通关 →
     IW_COMPLETE 恰好一次、acquiredItemIds 为空、CONFIG.exitHook 差异不引发崩溃

测试桥策略（与计划一致）：
  桥接用例通过 Playwright route 拦截 shared/save-protocol.js 注入可控 WL 测试桥；
  官方用例（5/6/8/9）完全不改官方协议库，内嵌用例用 IW_INIT_SAVE /
  IW_ADMIN_COMMAND 真实握手消息驱动。所有用例监听 dialog，出现原生弹窗即失败。

运行前提（B 的 PR 合并后）：
  $env:PLAYWRIGHT_BROWSERS_PATH="d:\\无限世界大赛\\.playwright-browsers"
  d:\\无限世界大赛\\.venv\\Scripts\\python.exe tests\\e2e.py
"""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from browser_harness import BrowserHarness, PROJECT_ROOT

GAME_DIR = PROJECT_ROOT / "game"
HANDOFF_SRC = (GAME_DIR / "js" / "handoff.js").read_text(encoding="utf-8")


def _extract_const(name):
    match = re.search(rf"export const {name}\s*=\s*'([^']+)'", HANDOFF_SRC)
    assert match, f"handoff.js 缺少常量 {name}"
    return match.group(1)


EXIT_HOOK = _extract_const("EXIT_HOOK")
SANITY_RELIC_ID = _extract_const("SANITY_RELIC_ID")
RELIC_CONFIGURED = SANITY_RELIC_ID != "PENDING_UPSTREAM_SANITY_RELIC_ID"
FAIL_REASON = re.search(r"const FAIL_REASON = '([^']+)'", HANDOFF_SRC).group(1)

PRICES = {"onigiri": 16, "coffee_capsule": 24, "battery": 38}
PARTS = ("energy", "stabilizer", "focus")
CABLE_ROUTE = (("energy", "stabilizer"), ("stabilizer", "focus"), ("focus", "frame"))
DIAL_TARGETS = (("amplitude", 2), ("frequency", 3), ("phase", 1))
SDK_PROTOCOL = 1  # save-protocol.js 内 SDK_PROTOCOL 常量

BRIDGE_JS = """
(function () {
  var boot = (window.__IW_BOOT && window.__IW_BOOT.save) || null;
  window.__BRIDGE_CALLS = { complete: [], fail: [] };
  window.WL = {
    version: 'v3',
    readSave: function () { return JSON.parse(JSON.stringify(boot)); },
    completeLevel: function (config, save, opts) {
      var record = { config: config, save: save, opts: opts, result: save };
      window.__BRIDGE_CALLS.complete.push(record);
      return save;
    },
    failLevel: function (reason, save, config) {
      var record = { reason: reason, save: save, config: config };
      window.__BRIDGE_CALLS.fail.push(record);
      return save;
    },
  };
})();
"""

HOST_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><title>e2e host</title></head>
<body style="margin:0">
<iframe src="/game/index.html" id="game" style="width:1280px;height:720px;border:0"></iframe>
<script>
  window.__IW_COMPLETE = [];
  window.addEventListener('message', function (event) {
    if (event.data && event.data.type === 'IW_COMPLETE') window.__IW_COMPLETE.push(event.data);
  });
  window.sendToGame = function (message) {
    document.getElementById('game').contentWindow.postMessage(message, '*');
  };
</script>
</body></html>"""


def tid(name):
    return f"[data-testid='{name}']"


def make_save(exit_hook, items=None, hp=3):
    """构造 SAVE_STATE v3 存档（协议 normalize 宽容，缺字段自动补默认）。"""
    return {
        "level": 2,
        "exit_hook": exit_hook,
        "items": items if items is not None else [],
        "player": {"hp": hp, "max_hp": 3, "sanity": 2, "status": "normal", "curses": []},
    }


class GameFrameNotFound(AssertionError):
    pass


class E2EPage:
    """单用例页面封装：独立 page + 弹窗/控制台/网络错误跟踪。"""

    def __init__(self, harness, use_bridge, boot_save=None):
        self.harness = harness
        self.page = harness.context.new_page()
        self._frame = None  # 内嵌模式下指向游戏 iframe，调用计数走 frame 作用域
        self.page.set_default_timeout(8000)
        self.dialogs = []
        self.console_errors = []
        self.page_errors = []
        self.bad_responses = []
        self.page.on("dialog", self._on_dialog)
        self.page.on("console", self._on_console)
        self.page.on("pageerror", self._on_pageerror)
        self.page.on("response", self._on_response)
        if use_bridge:
            self.page.route("**/shared/save-protocol.js", self._fulfill_bridge)
        if boot_save is not None:
            payload = json.dumps(boot_save, ensure_ascii=False)
            self.page.add_init_script(f"window.__IW_BOOT = {{ save: {payload} }};")

    # ---- 跟踪 ---------------------------------------------------------
    def _on_dialog(self, dialog):
        self.dialogs.append(f"{dialog.type}: {dialog.message}")
        dialog.dismiss()

    def _on_console(self, message):
        if message.type == "error":
            self.console_errors.append(message.text)

    def _on_pageerror(self, error):
        self.page_errors.append(str(error))

    def _on_response(self, response):
        if response.status >= 400 and "favicon" not in response.url:
            self.bad_responses.append(f"{response.status} {response.url}")

    def assert_clean(self, label):
        problems = []
        if self.dialogs:
            problems.append(f"出现原生弹窗: {self.dialogs}")
        if self.console_errors:
            problems.append(f"控制台错误: {self.console_errors}")
        if self.page_errors:
            problems.append(f"页面异常: {self.page_errors}")
        if self.bad_responses:
            problems.append(f"资源加载失败(>=400): {self.bad_responses}")
        assert not problems, f"{label}: {problems}"

    # ---- 桥接与打开 -----------------------------------------------------
    def _fulfill_bridge(self, route):
        route.fulfill(content_type="text/javascript", body=BRIDGE_JS)

    def open_standalone(self):
        # harness 以仓库根为 web 根（与 store_browser 一致），游戏入口在 /game/
        self.page.goto(f"{self.harness.base_url}/game/index.html")
        self.page.wait_for_function("typeof window.WL === 'object' && window.WL !== null")
        return self.page

    def open_embedded(self):
        self.page.route(
            "**/e2e-host.html",
            lambda route: route.fulfill(content_type="text/html", body=HOST_HTML),
        )
        self.page.goto(f"{self.harness.base_url}/e2e-host.html")
        self.page.wait_for_selector("#game")
        self._frame = self.game_frame()
        return self._frame

    def game_frame(self):
        for _ in range(50):
            for frame in self.page.frames:
                if frame.url.rstrip("/").endswith("/index.html"):
                    return frame
            self.page.wait_for_timeout(100)
        raise GameFrameNotFound("未找到游戏 iframe")

    @property
    def target(self):
        """调用计数/求值的作用域：内嵌用游戏 iframe，独立用页面本身。"""
        return self._frame or self.page

    # ---- 官方协议调用计数 -------------------------------------------------
    def install_official_counter(self):
        assert self.target.evaluate(
            """() => {
              if (!window.WL || !window.WL.completeLevel) return false;
              const origC = window.WL.completeLevel.bind(window.WL);
              const origF = window.WL.failLevel.bind(window.WL);
              window.__calls = { complete: [], fail: [] };
              window.WL.completeLevel = (c, s, o) => {
                const r = origC(c, s, o);
                window.__calls.complete.push({ config: c, save: s, opts: o, result: r });
                return r;
              };
              window.WL.failLevel = (reason, s, c) => {
                const r = origF(reason, s, c);
                window.__calls.fail.push({ reason, save: s, result: r });
                return r;
              };
              return true;
            }"""
        ), "官方 WL 包装失败"

    def complete_calls(self):
        return self.target.evaluate(
            "window.__BRIDGE_CALLS ? window.__BRIDGE_CALLS.complete : window.__calls.complete"
        )

    def fail_calls(self):
        return self.target.evaluate(
            "window.__BRIDGE_CALLS ? window.__BRIDGE_CALLS.fail : window.__calls.fail"
        )

    def wait_complete(self, count=1):
        self.target.wait_for_function(
            """n => {
              const c = window.__BRIDGE_CALLS ? window.__BRIDGE_CALLS.complete : window.__calls;
              return (c.complete || c).length === n;
            }""",
            arg=count,
        )

    def close(self):
        self.page.close()


# ---- 宿主握手消息 ---------------------------------------------------------
def init_save_message(session_id, save, config=None):
    return {
        "type": "IW_INIT_SAVE",
        "protocolVersion": SDK_PROTOCOL,
        "sessionId": session_id,
        "save": save,
        "config": config or {},
    }


# ---- 玩法流程（点击路径；拖放路径已由 Task 4/5 场景测试覆盖）----------------
def play_store(page, order, expected_hook):
    page.wait_for_selector("[data-scene='store']")
    assert page.inner_text(tid("narration-text")) == expected_hook, "承接旁白应取自真实存档 exit_hook"
    for product_id in order:
        page.click(tid(f"product-{product_id}"))
        page.click(tid("scanner"))
    assert page.locator(".bag-chip").count() == 3, "扫码后应有 3 件商品"
    page.click(tid("cup"))
    page.click(tid("coffee-machine"))
    page.click(tid("bag-coffee_capsule"))
    page.click(tid("coffee-machine"))
    page.click(tid("brew-start"))
    page.wait_for_selector(tid("serve-coffee"), state="visible")
    page.click(tid("serve-coffee"))
    page.wait_for_selector(tid("payment-closeup"), state="visible")
    page.click(tid("closeup-close"))
    page.wait_for_selector(tid("blueprint"), state="visible")
    page.wait_for_selector(tid("warehouse-lock"), state="visible")
    code = "".join(str(PRICES[p] % 10) for p in order)
    for digit in code:
        page.click(tid(f"lock-key-{digit}"))
    page.click(tid("lock-submit"))
    page.wait_for_selector("[data-scene='warehouse']")
    return code


def play_warehouse(page, relic=False):
    page.wait_for_selector("[data-scene='warehouse']")
    dial_up = page.locator(tid("dial-amplitude-up"))
    if relic:
        assert dial_up.count() == 0, "遗物捷径路线不应出现手动调频旋钮"
    else:
        assert dial_up.count() > 0, "无遗物路线应出现手动调频旋钮"
    for part_id in PARTS:
        page.click(tid(f"part-{part_id}"))
        page.click(tid(f"slot-{part_id}"))
    for from_id, to_id in CABLE_ROUTE:
        page.click(tid(f"node-{from_id}"))
        page.click(tid(f"node-{to_id}"))
    if not relic:
        for dial_id, target in DIAL_TARGETS:
            for _ in range(target):
                page.click(tid(f"dial-{dial_id}-up"))
    page.click(tid("start-portal"))


# ---------------------------------------------------------------------------
# 测试用例
# ---------------------------------------------------------------------------

def test_success_low_hp_empty_bag_once(harness):
    """场景 1：残血空背包完整通关；成功恰好交档一次；存档不被满血覆盖。"""
    save = make_save(exit_hook="存档承接：你浑身湿透地推开了天台便店的门。", hp=1)
    e2e = E2EPage(harness, use_bridge=True, boot_save=save)
    try:
        page = e2e.open_standalone()
        play_store(page, ["battery", "onigiri", "coffee_capsule"], save["exit_hook"])
        play_warehouse(page, relic=False)
        e2e.wait_complete(1)

        calls = e2e.complete_calls()
        assert len(calls) == 1, f"成功交档应恰好一次，实际 {len(calls)}"
        opts = calls[0]["opts"]
        assert opts["acquiredItemIds"] == [], "本关零新增道具：acquiredItemIds 必须为空"
        assert opts["exitHook"] == EXIT_HOOK, "结束语必须是 handoff.js 固定文案"
        assert calls[0]["config"]["exitHook"] == EXIT_HOOK, "CONFIG.exitHook 应携带同一结束语"
        assert calls[0]["save"]["player"]["hp"] == 1, "残血入档不得被默认满血覆盖"
        assert calls[0]["save"]["items"] == [], "空背包入档不得被添加道具"

        # 重复点击启动不得再次交档（主控结束锁）
        page.click(tid("start-portal"))
        e2e.wait_complete(1)
        assert len(e2e.complete_calls()) == 1, "重复结束请求只能提交一次"
        e2e.assert_clean("残血空背包完整通关")
    finally:
        e2e.close()


def test_other_sanity_item_manual_route(harness):
    """场景 2：携带其他理智道具不得触发捷径，仍走手动调频；换扫码顺序验证动态密码。"""
    save = make_save(
        exit_hook="存档承接：口袋里的薄荷糖让你勉强清醒。",
        items=[{"id": "calm_tea", "type": "sanity"}],
        hp=2,
    )
    e2e = E2EPage(harness, use_bridge=True, boot_save=save)
    try:
        page = e2e.open_standalone()
        play_store(page, ["onigiri", "coffee_capsule", "battery"], save["exit_hook"])
        play_warehouse(page, relic=False)
        e2e.wait_complete(1)
        assert len(e2e.complete_calls()) == 1
        e2e.assert_clean("其他理智道具手动路线")
    finally:
        e2e.close()


def test_pending_relic_id_no_false_shortcut(harness):
    """场景 3：背包含待替换 ID 字面量不得误触发捷径（Review Focus 4）。"""
    save = make_save(
        exit_hook="存档承接：有人把一枚陌生硬币留在了柜台上。",
        items=[{"id": "PENDING_UPSTREAM_SANITY_RELIC_ID", "type": "sanity"}],
    )
    e2e = E2EPage(harness, use_bridge=True, boot_save=save)
    try:
        page = e2e.open_standalone()
        play_store(page, ["battery", "coffee_capsule", "onigiri"], save["exit_hook"])
        play_warehouse(page, relic=False)  # 必须手动调频
        e2e.wait_complete(1)
        assert len(e2e.complete_calls()) == 1
        e2e.assert_clean("待替换 ID 防误触")
    finally:
        e2e.close()


def test_real_relic_shortcut(harness):
    """场景 4：携带真实目标遗物免调频；仅在 handoff.js 替换真实 ID 后运行。"""
    if not RELIC_CONFIGURED:
        print("SKIP  test_real_relic_shortcut（SANITY_RELIC_ID 仍为待替换常量，按无遗物路线验收）")
        return
    save = make_save(
        exit_hook="存档承接：上一世界的遗物在口袋里微微发烫。",
        items=[{"id": SANITY_RELIC_ID, "type": "sanity"}],
    )
    e2e = E2EPage(harness, use_bridge=True, boot_save=save)
    try:
        page = e2e.open_standalone()
        play_store(page, ["onigiri", "battery", "coffee_capsule"], save["exit_hook"])
        play_warehouse(page, relic=True)  # 不点任何旋钮
        e2e.wait_complete(1)
        assert len(e2e.complete_calls()) == 1
        e2e.assert_clean("真实遗物捷径")
    finally:
        e2e.close()


def test_embedded_waiting_then_first_save(harness):
    """场景 5：内嵌模式首次 iw-save-ready 到达前只显示等待态，不挂载玩法。"""
    e2e = E2EPage(harness, use_bridge=False)
    try:
        frame = e2e.open_embedded()
        frame.wait_for_selector("[data-scene='waiting']")
        assert frame.locator("[data-scene='store']").count() == 0, "未接档不得挂载营业区"
        assert frame.locator("[data-scene='warehouse']").count() == 0, "未接档不得挂载仓库"

        save = make_save(exit_hook="存档承接：大厅把上一世界的夜色递了过来。", hp=2)
        e2e.page.evaluate(
            "msg => window.sendToGame(msg)",
            init_save_message("session-1", save, {"exitHook": EXIT_HOOK}),
        )
        frame.wait_for_selector("[data-scene='store']")
        assert frame.inner_text(tid("narration-text")) == save["exit_hook"]
        e2e.assert_clean("内嵌等待态与首档")
    finally:
        e2e.close()


def test_embedded_updated_save_keeps_progress(harness):
    """场景 6：挂载后收到更新存档走 updateContext：承接旁白更新、接待进度保留。"""
    e2e = E2EPage(harness, use_bridge=False)
    try:
        frame = e2e.open_embedded()
        frame.wait_for_selector("[data-scene='waiting']")
        save1 = make_save(exit_hook="首档承接：营业区的灯一盏盏亮起。", hp=2)
        e2e.page.evaluate(
            "msg => window.sendToGame(msg)",
            init_save_message("session-1", save1, {"exitHook": EXIT_HOOK}),
        )
        frame.wait_for_selector("[data-scene='store']")
        frame.click(tid("product-battery"))
        frame.click(tid("scanner"))
        assert frame.locator(".bag-chip").count() == 1, "接档后应可正常接待"

        # 延迟存档：换 sessionId 重发 IW_INIT_SAVE，main.js 必须走 updateContext 不重挂载
        save2 = make_save(exit_hook="更新承接：仓库方向传来敲击声。", hp=2)
        e2e.page.evaluate(
            "msg => window.sendToGame(msg)",
            init_save_message("session-2", save2, {"exitHook": EXIT_HOOK}),
        )
        frame.wait_for_function(
            f"document.querySelector(\"{tid('narration-text')}\").textContent === {json.dumps(save2['exit_hook'])}"
        )
        assert frame.locator(".bag-chip").count() == 1, "更新存档不得清空接待进度"

        # 用 save2 的 exit_hook 继续走完营业区并进入仓库
        for product_id in ("onigiri", "coffee_capsule"):
            frame.click(tid(f"product-{product_id}"))
            frame.click(tid("scanner"))
        frame.click(tid("cup"))
        frame.click(tid("coffee-machine"))
        frame.click(tid("bag-coffee_capsule"))
        frame.click(tid("coffee-machine"))
        frame.click(tid("brew-start"))
        frame.wait_for_selector(tid("serve-coffee"), state="visible")
        frame.click(tid("serve-coffee"))
        frame.wait_for_selector(tid("payment-closeup"), state="visible")
        frame.click(tid("closeup-close"))
        for digit in "864":  # battery(38)→onigiri(16)→coffee_capsule(24)，取红字个位
            frame.click(tid(f"lock-key-{digit}"))
        frame.click(tid("lock-submit"))
        frame.wait_for_selector("[data-scene='warehouse']")
        e2e.assert_clean("内嵌更新存档保进度")
    finally:
        e2e.close()


def test_abandon_fail_once(harness):
    """场景 7：放弃夜班只提交一次失败交接，原因固定，重复操作不得再次提交。"""
    save = make_save(exit_hook="存档承接：你还没准备好面对这个夜班。", hp=3)
    e2e = E2EPage(harness, use_bridge=True, boot_save=save)
    try:
        page = e2e.open_standalone()
        page.wait_for_selector("[data-scene='store']")
        page.click(tid("product-battery"))
        page.click(tid("scanner"))

        # 菜单/放弃控件是 index.html 上的静态 ID（非 data-testid）
        page.click("#menu-toggle")
        page.wait_for_selector("#abandon-confirm", state="hidden")
        page.click("#abandon-toggle")
        page.wait_for_selector("#abandon-confirm", state="visible")
        page.click("#abandon-confirm-button")
        page.wait_for_function("window.__BRIDGE_CALLS.fail.length === 1")

        fails = e2e.fail_calls()
        assert fails[0]["reason"] == FAIL_REASON, f"放弃原因应固定为「{FAIL_REASON}」"
        assert fails[0]["save"]["player"]["hp"] == 3

        # 重新打开菜单再试：结束锁保证仍只有一次
        page.click("#menu-toggle")
        page.click("#abandon-toggle")
        page.click("#abandon-confirm-button")
        page.wait_for_timeout(500)
        assert len(e2e.fail_calls()) == 1, "放弃交接只能提交一次"
        assert len(e2e.complete_calls()) == 0, "放弃后不得再触发成功交接"
        e2e.assert_clean("放弃流程")
    finally:
        e2e.close()


def test_official_standalone_documents_validation(harness):
    """场景 8：官方协议 standalone 完整实跑——协议按设计拒绝（无 nextUrl），
    恰好尝试一次且无崩溃；此行为仅作记录，正式验收走真实大厅内嵌路径。"""
    save = make_save(exit_hook="存档承接：standalone 模式下的夜班。", hp=1)
    e2e = E2EPage(harness, use_bridge=False, boot_save=save)
    try:
        page = e2e.open_standalone()
        e2e.install_official_counter()
        play_store(page, ["battery", "onigiri", "coffee_capsule"], save["exit_hook"])
        play_warehouse(page, relic=False)
        e2e.wait_complete(1)

        calls = e2e.complete_calls()
        assert len(calls) == 1, "standalone 下也应恰好尝试交档一次"
        assert calls[0]["result"] is None, "官方协议 standalone（无 nextUrl）应返回 null"
        assert calls[0]["opts"]["acquiredItemIds"] == []
        assert calls[0]["opts"]["exitHook"] == EXIT_HOOK
        assert page.locator("#wl-exit-errors .wl-warn").count() == 1, "协议应显示交接错误提示"
        assert len(e2e.fail_calls()) == 0, "成功路径不得触发失败交接"
        e2e.assert_clean("官方协议 standalone 行为记录")
    finally:
        e2e.close()


def test_official_embedded_real_hall_handoff(harness):
    """场景 9：官方协议 + 真实大厅路径（IW_INIT_SAVE 握手 + itemManifest）：
    完整通关后 IW_COMPLETE 恰好一次、acquiredItemIds 为空、残血存档原样透传；
    CONFIG.exitHook 故意用不同文案，确认交接流程不受差异影响、无崩溃。"""
    hall_exit_hook = "（大厅配置的结束语，与 handoff.js 固定文案故意不同）"
    hall_config = {
        "exitHook": hall_exit_hook,
        "world": "天台夜班",
        "nextWorld": "下一个世界",
        "nextUrl": "/next.html",
        "itemManifest": {"schema": "iw-global-items-v1", "items": []},
    }
    save = make_save(exit_hook="存档承接：真实大厅送来的存档。", hp=1)
    e2e = E2EPage(harness, use_bridge=False)
    try:
        frame = e2e.open_embedded()
        frame.wait_for_selector("[data-scene='waiting']")
        e2e.page.evaluate(
            "msg => window.sendToGame(msg)",
            init_save_message("session-1", save, hall_config),
        )
        frame.wait_for_selector("[data-scene='store']")
        e2e.install_official_counter()

        play_store(frame, ["coffee_capsule", "battery", "onigiri"], save["exit_hook"])
        play_warehouse(frame, relic=False)
        e2e.wait_complete(1)
        # postMessage 是异步投递，轮询等待宿主收到回执
        e2e.page.wait_for_function("window.__IW_COMPLETE.length === 1")

        completes = e2e.page.evaluate("window.__IW_COMPLETE")
        assert len(completes) == 1, f"IW_COMPLETE 应恰好一次，实际 {len(completes)}"
        assert completes[0]["acquiredItemIds"] == [], "真实大厅路径同样必须零新增道具"
        assert completes[0]["save"]["player"]["hp"] == 1, "残血存档应原样透传给大厅"

        calls = e2e.complete_calls()
        assert len(calls) == 1 and calls[0]["result"] is not None, "官方内嵌交接应成功返回"
        e2e.assert_clean("官方内嵌真实大厅路径")
    finally:
        e2e.close()


TESTS = [
    test_success_low_hp_empty_bag_once,
    test_other_sanity_item_manual_route,
    test_pending_relic_id_no_false_shortcut,
    test_real_relic_shortcut,
    test_embedded_waiting_then_first_save,
    test_embedded_updated_save_keeps_progress,
    test_abandon_fail_once,
    test_official_standalone_documents_validation,
    test_official_embedded_real_hall_handoff,
]


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    failures = []
    with BrowserHarness(game_dir=PROJECT_ROOT) as harness:
        for test_fn in TESTS:
            try:
                test_fn(harness)
            except Exception as exc:  # noqa: BLE001 - 逐用例收集失败原因
                failures.append((test_fn.__name__, repr(exc)))
                print(f"FAIL  {test_fn.__name__}\n      {exc!r}")
            else:
                print(f"PASS  {test_fn.__name__}")
    print()
    print(f"全流程验证结果：{len(TESTS) - len(failures)}/{len(TESTS)} 通过（SKIP 计入通过）")
    if failures:
        for name, err in failures:
            print(f"  - {name}: {err}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
