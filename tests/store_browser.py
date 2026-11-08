"""Playwright 浏览器验证：营业区场景（Task 4）。

覆盖：扫码（拖放/点击）→ 咖啡制作与交付 → 图纸 → 小票动态密码 →
仓库解锁（enterWarehouse 恰好一次）；重复扫码反馈、错误密码不清进度、
updateContext 不丢接待进度、destroy 后重挂载无监听器泄漏、
全程零原生弹窗 / 控制台错误 / 资源 404。

运行方式（项目内环境，禁止全局安装）：
  $env:PLAYWRIGHT_BROWSERS_PATH="d:\\无限世界大赛\\.playwright-browsers"
  d:\\无限世界大赛\\.venv\\Scripts\\python.exe tests\\store_browser.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from browser_harness import BrowserHarness, PROJECT_ROOT

FIXTURE_PATH = "tests/fixtures/store.html"
SCENE_SELECTOR = "[data-scene='store']"

# contracts.js 声明的全部 SoundId（营业区只应使用 store.* 与 ui.click）
SOUND_WHITELIST = {
    "ui.click",
    "store.scan",
    "store.coffee",
    "store.receipt",
    "store.lock",
    "store.unlock",
    "warehouse.place",
    "warehouse.cable",
    "warehouse.dial",
    "warehouse.portal",
}

INITIAL_EXIT_HOOK = "存档承接：你从员工通道走进了营业区。"


def tid(name):
    return f"[data-testid='{name}']"


class StoreFixturePage:
    """fixture 页面封装：API 调用计数 + 弹窗/控制台/网络错误跟踪。"""

    def __init__(self, harness):
        self.harness = harness
        self.page = harness.page
        self.page.set_default_timeout(6000)
        self.dialogs = []
        self.console_errors = []
        self.page_errors = []
        self.bad_responses = []
        self.page.on("dialog", self._on_dialog)
        self.page.on("console", self._on_console)
        self.page.on("pageerror", self._on_pageerror)
        self.page.on("response", self._on_response)

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
        if response.status >= 400:
            self.bad_responses.append(f"{response.status} {response.url}")

    def reset_tracking(self):
        for bucket in (self.dialogs, self.console_errors, self.page_errors, self.bad_responses):
            bucket.clear()

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

    # ---- fixture 控制 ---------------------------------------------------
    def open(self):
        self.page.goto(f"{self.harness.base_url}/{FIXTURE_PATH}")
        self.page.wait_for_function("window.__storeHarness && window.__storeHarness.isMounted()")
        self.page.wait_for_selector(SCENE_SELECTOR)
        return self

    def state(self):
        return self.page.evaluate("window.__storeHarness.state")

    def call(self, expression):
        return self.page.evaluate(f"window.__storeHarness.{expression}")

    # ---- 断言辅助 --------------------------------------------------------
    def assert_sounds_legal(self):
        sounds = self.state()["sounds"]
        illegal = [s for s in sounds if s not in SOUND_WHITELIST]
        assert not illegal, f"出现未声明的 SoundId: {illegal}"

    def bag_count(self):
        return self.page.locator(".bag-chip").count()

    def lock_display(self):
        return self.page.eval_on_selector_all(
            f"{tid('lock-input')} i", "els => els.map(e => e.textContent).join('')"
        )

    def receipt_line_ids(self):
        self.page.click(tid("receipt"))
        self.page.wait_for_selector("[data-testid^='receipt-line-']")
        line_ids = self.page.eval_on_selector_all(
            "[data-testid^='receipt-line-']", "els => els.map(e => e.dataset.lineId)"
        )
        receipt_text = self.page.inner_text("[data-testid='closeup-card']")
        self.last_receipt_red_digits = self.page.eval_on_selector_all(
            ".receipt-code-digit", "els => els.map(e => e.textContent).join('')"
        )
        self.page.click(tid("closeup-close"))
        self.page.wait_for_selector(tid("store-closeup"), state="hidden")
        return line_ids, receipt_text

    # ---- 交互原语 --------------------------------------------------------
    def scan_drag(self, product_id):
        self.page.drag_and_drop(tid(f"product-{product_id}"), tid("scanner"))

    def scan_click(self, product_id):
        self.page.click(tid(f"product-{product_id}"))
        self.page.click(tid("scanner"))

    def scan(self, product_id, mode):
        if mode == "drag":
            self.scan_drag(product_id)
        else:
            self.scan_click(product_id)

    def coffee_cup(self, mode):
        if mode == "drag":
            self.page.drag_and_drop(tid("cup"), tid("coffee-machine"))
        else:
            self.page.click(tid("cup"))
            self.page.click(tid("coffee-machine"))

    def coffee_capsule(self, mode):
        if mode == "drag":
            self.page.drag_and_drop(tid("bag-coffee_capsule"), tid("coffee-machine"))
        else:
            self.page.click(tid("bag-coffee_capsule"))
            self.page.click(tid("coffee-machine"))

    def run_scan_phase(self, order, mode):
        for product_id in order:
            self.scan(product_id, mode)
        assert self.bag_count() == 3, f"扫码后商品袋应有 3 件，实际 {self.bag_count()}"

    def run_coffee_phase(self, mode):
        self.coffee_cup(mode)
        self.coffee_capsule(mode)
        self.page.click(tid("brew-start"))
        self.page.wait_for_selector(tid("serve-coffee"), state="visible")
        self.page.click(tid("serve-coffee"))
        self.page.wait_for_selector(tid("payment-closeup"), state="visible")
        assert self.page.get_attribute(
            tid("payment-world-mark"), "data-world-mark"
        ) == "hollow-eye"
        payment_blueprint = self.page.inner_text(tid("payment-blueprint"))
        assert "导管连接顺序" in payment_blueprint
        assert "能源接口 → 稳定器 → 聚焦环 → 门框" in payment_blueprint
        self.page.click(tid("closeup-close"))
        self.page.wait_for_selector(tid("store-closeup"), state="hidden")
        self.page.wait_for_selector(tid("blueprint"), state="visible")
        self.page.wait_for_selector(tid("warehouse-lock"), state="visible")

    def press_lock(self, digits):
        for digit in digits:
            self.page.click(tid(f"lock-key-{digit}"))
        assert self.lock_display() == digits, f"锁屏应显示 {digits}，实际 {self.lock_display()}"

    def wait_for_warehouse(self):
        self.page.wait_for_function(
            "window.__storeHarness.state.enterWarehouseCalls === 1", timeout=4000
        )


# ---------------------------------------------------------------------------
# 测试用例
# ---------------------------------------------------------------------------

def test_main_path_drag_scan_to_unlock(store):
    """主路径：拖放扫码（battery→onigiri→capsule）→ 咖啡 → 图纸 → 密码 864 → 解锁。"""
    page = store.page
    # 开场旁白来自 api.exitHook；密码输入区在图纸到手前不可见
    assert page.inner_text(tid("narration-text")) == INITIAL_EXIT_HOOK
    assert page.is_hidden(tid("warehouse-lock"))
    assert page.is_hidden(tid("blueprint"))
    # 价签可读
    assert page.inner_text(tid("price-tag-onigiri")) == "¥16"
    assert page.inner_text(tid("price-tag-coffee_capsule")) == "¥24"
    assert page.inner_text(tid("price-tag-battery")) == "¥38"

    order = ["battery", "onigiri", "coffee_capsule"]
    interactions_before = store.state()["interactions"]
    store.run_scan_phase(order, mode="drag")
    assert store.state()["interactions"] - interactions_before == 3, "每次有效扫码应恰好记录一次交互"

    store.run_coffee_phase(mode="drag")

    # 图纸近景
    page.click(tid("blueprint"))
    page.wait_for_selector(tid("blueprint-closeup"))
    blueprint_text = page.inner_text(tid("blueprint-closeup"))
    assert "仓库" in blueprint_text
    assert "导管连接顺序" in blueprint_text
    assert "能源接口 → 稳定器 → 聚焦环 → 门框" in blueprint_text
    page.click(tid("closeup-close"))
    page.wait_for_selector(tid("store-closeup"), state="hidden")

    # 小票近景：价格序列 = 扫码顺序 → 864
    line_ids, receipt_text = store.receipt_line_ids()
    assert line_ids == order, f"小票顺序应等于扫码顺序 {order}，实际 {line_ids}"
    for price in ("¥38", "¥16", "¥24"):
        assert price in receipt_text, f"小票近景应含 {price}"
    assert store.last_receipt_red_digits == "864", "小票应按扫码顺序用红字标出价格个位"
    assert "红字即门锁顺序" not in receipt_text, "不得直接揭示红字与门锁的关系"

    store.press_lock("864")
    page.click(tid("lock-submit"))
    store.wait_for_warehouse()

    state = store.state()
    assert state["enterWarehouseCalls"] == 1, f"enterWarehouse 应恰好调用一次，实际 {state['enterWarehouseCalls']}"
    assert "is-open" in (page.get_attribute(tid("warehouse-door"), "class") or ""), "解锁后仓库门应为开启态"

    # 解锁后重复提交不得再次进入仓库
    page.click(tid("lock-submit"))
    assert store.state()["enterWarehouseCalls"] == 1

    sounds = state["sounds"]
    for expected in ("store.scan", "store.coffee", "store.receipt", "store.unlock"):
        assert expected in sounds, f"音效记录缺少 {expected}"
    assert state["interactions"] >= 9, "主路径有效交互次数偏少"
    store.assert_sounds_legal()
    store.assert_clean("主路径")


def test_click_only_path_alternative_order(store):
    """点击替代拖放：onigiri(6)→capsule(4)→battery(8) → 密码 648；纸杯/胶囊均走点击路径。"""
    page = store.page
    order = ["onigiri", "coffee_capsule", "battery"]
    store.run_scan_phase(order, mode="click")
    store.run_coffee_phase(mode="click")

    line_ids, _ = store.receipt_line_ids()
    assert line_ids == order, f"小票顺序应等于扫码顺序 {order}，实际 {line_ids}"

    store.press_lock("648")
    page.click(tid("lock-submit"))
    store.wait_for_warehouse()
    assert store.state()["enterWarehouseCalls"] == 1, "点击路径完整流程后应恰好解锁一次"
    store.assert_clean("点击路径")


def test_duplicate_scan_inline_feedback(store):
    """重复扫码被逻辑层拒绝：行内反馈出现、不计有效交互、小票不变。"""
    store.scan_drag("onigiri")
    assert store.bag_count() == 1
    interactions_after_first = store.state()["interactions"]

    store.scan_drag("onigiri")  # 重复拖放同一商品
    feedback = store.page.inner_text(tid("store-feedback"))
    assert "重复扫码" in feedback, f"重复扫码应给行内反馈，实际：{feedback}"
    assert store.state()["interactions"] == interactions_after_first, "被拒绝的扫码不应计为有效交互"
    assert store.bag_count() == 1, "重复扫码不应改变小票"

    store.scan_click("onigiri")  # 点击路径重复扫码同样被拒
    assert "重复扫码" in store.page.inner_text(tid("store-feedback"))
    assert store.bag_count() == 1
    store.assert_clean("重复扫码")


def test_wrong_password_keeps_progress(store):
    """错误密码：只清空本次输入并给行内反馈；接待/图纸/小票进度全部保留。"""
    page = store.page
    order = ["battery", "onigiri", "coffee_capsule"]
    store.run_scan_phase(order, mode="drag")
    store.run_coffee_phase(mode="drag")
    interactions_before = store.state()["interactions"]

    store.press_lock("123")
    page.click(tid("lock-submit"))
    feedback = page.inner_text(tid("store-feedback"))
    assert "密码不对" in feedback, f"错误密码应有行内反馈，实际：{feedback}"
    assert store.lock_display() == "", "错误密码应清空本次输入"
    assert store.state()["enterWarehouseCalls"] == 0
    assert store.state()["interactions"] - interactions_before == 1, "一次开锁尝试应记录一次交互"
    # 进度保留
    assert page.is_visible(tid("warehouse-lock"))
    assert page.is_visible(tid("blueprint"))
    assert store.bag_count() == 3
    line_ids, _ = store.receipt_line_ids()
    assert line_ids == order, "错误密码后小票进度不变"

    store.press_lock("864")
    page.click(tid("lock-submit"))
    store.wait_for_warehouse()
    assert store.state()["enterWarehouseCalls"] == 1, "错误后输入正确密码应解锁"
    assert "store.lock" in store.state()["sounds"], "错误开锁应播放 store.lock"
    store.assert_clean("错误密码")


def test_update_context_keeps_progress(store):
    """updateContext 只更新承接旁白，不重建场景、不清接待进度。"""
    store.scan_drag("battery")
    assert store.bag_count() == 1

    new_hook = "新承接：仓库方向传来敲击声。"
    assert store.call(f"updateContext({new_hook!r})")
    assert store.page.inner_text(tid("narration-text")) == new_hook
    assert store.bag_count() == 1, "承接文案更新不应清空已扫商品"

    store.scan_drag("onigiri")
    store.scan_drag("coffee_capsule")
    assert store.bag_count() == 3, "updateContext 后接待流程应继续可用"
    assert store.page.inner_text(tid("narration-text")) == new_hook
    store.assert_clean("updateContext")


def test_destroy_then_remount_no_listener_leak(store):
    """destroy 解绑监听：重挂载后同样操作只产生一次计数，且无页面异常。"""
    page = store.page
    store.scan_click("onigiri")
    assert store.state()["interactions"] == 1
    assert store.call("destroy()")
    assert page.eval_on_selector("#scene-container", "el => el.childElementCount") == 0

    store.call("remount()")
    page.wait_for_selector(SCENE_SELECTOR)
    assert page.evaluate("document.querySelectorAll(\"[data-scene='store']\").length") == 1

    store.scan_click("battery")
    assert store.state()["interactions"] == 2, "重挂载后监听器应恰好一套（泄漏时会双倍计数）"
    store.scan_click("coffee_capsule")
    store.scan_click("battery")  # 重复扫码在新场景内同样被拒
    assert "重复扫码" in page.inner_text(tid("store-feedback"))
    assert store.state()["enterWarehouseCalls"] == 0
    assert not store.page_errors, f"destroy/重挂载后不应有页面异常: {store.page_errors}"
    store.assert_clean("destroy/重挂载")


def test_customer_and_door_animation(store):
    """顾客有真实人物图；解锁先播放开门动画，再恰好切场一次。"""
    page = store.page
    portrait = page.locator(tid("customer-portrait"))
    assert portrait.is_visible(), "营业区应显示顾客人物图"
    assert portrait.evaluate("img => img.complete && img.naturalWidth > 0"), "顾客图片应成功加载"

    store.run_scan_phase(["onigiri", "coffee_capsule", "battery"], mode="click")
    store.run_coffee_phase(mode="click")
    store.press_lock("648")
    page.click(tid("lock-submit"))
    assert store.state()["enterWarehouseCalls"] == 0, "开门动画期间不得立即切场"
    assert page.get_attribute(tid("warehouse-door"), "data-state") == "opening"
    store.wait_for_warehouse()
    assert store.state()["enterWarehouseCalls"] == 1
    store.assert_clean("顾客与开门动画")


def test_destroy_cancels_door_transition(store):
    """开门途中销毁场景后，计时器不得再进入仓库。"""
    store.run_scan_phase(["onigiri", "coffee_capsule", "battery"], mode="click")
    store.run_coffee_phase(mode="click")
    store.press_lock("648")
    store.page.click(tid("lock-submit"))
    assert store.call("destroy()")
    store.page.wait_for_timeout(1550)
    assert store.state()["enterWarehouseCalls"] == 0
    store.assert_clean("开门途中销毁")


TESTS = [
    test_main_path_drag_scan_to_unlock,
    test_click_only_path_alternative_order,
    test_duplicate_scan_inline_feedback,
    test_wrong_password_keeps_progress,
    test_update_context_keeps_progress,
    test_destroy_then_remount_no_listener_leak,
    test_customer_and_door_animation,
    test_destroy_cancels_door_transition,
]


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    failures = []
    with BrowserHarness(game_dir=PROJECT_ROOT) as harness:
        store = StoreFixturePage(harness)
        for test_fn in TESTS:
            store.reset_tracking()
            try:
                store.open()
                test_fn(store)
            except Exception as exc:  # noqa: BLE001 - 逐用例收集失败原因
                failures.append((test_fn.__name__, repr(exc)))
                print(f"FAIL  {test_fn.__name__}\n      {exc!r}")
            else:
                print(f"PASS  {test_fn.__name__}")
    print()
    print(f"浏览器验证结果：{len(TESTS) - len(failures)}/{len(TESTS)} 通过")
    if failures:
        for name, err in failures:
            print(f"  - {name}: {err}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
