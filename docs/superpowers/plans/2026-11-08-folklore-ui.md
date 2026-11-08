# B 稿民俗密室 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏现有未提交修改与玩法的前提下，将 B 稿顾客、民俗场景、真实组件、顺序导管和仓库开门动画接入正式游戏。

**Architecture:** 沿用现有场景挂载、状态逻辑和测试 testid，只增量修改呈现层与解锁成功后的场景切换时机。顾客使用本地原创图片；物件使用 CSS/inline SVG；开门结束仍调用原有 `api.enterWarehouse()`。

**Tech Stack:** 原生 HTML、CSS、JavaScript ES Modules、SVG、Python Playwright、Node 内置测试。

**Spec:** `docs/superpowers/specs/2026-11-08-rooftop-night-shift-folklore-ui-design.md`

## Global Constraints

- 保留当前未提交修改，不整文件覆盖、不回退、不删除无关内容。
- 保留当前商品价格 16/24/38、动态密码逻辑、付钱特写、空眼印记、音效、交接协议和测试选择器。
- 不新增全局依赖或全局配置；所有资源仅在项目目录内。
- 不改变扫码、咖啡、遗物、组件、导管、旋钮及通关判定。
- 动画不阻塞菜单，支持 `prefers-reduced-motion`，场景销毁必须清理计时器。

## Review Focus

- 解锁后快速手动切换场景：计时器不得销毁新场景，由 Task 2 的 destroy 测试覆盖。
- 任意扫码顺序与最新价格：不得写死 648 或旧价格，由 Task 2 现有动态密码测试覆盖。
- 有/无遗物两条仓库路线：布局变更不得影响校准可见性，由 Task 3 现有仓库测试覆盖。
- 组件已安装与未安装状态：真实轮廓不得损失按钮语义和禁用状态，由 Task 3 结构测试覆盖。
- 窄视口与底部状态栏：人物、反馈和传送门不得被裁切，由 Task 4 浏览器截图与边界检查覆盖。

---

### Task 1: 顾客与营业区 B 稿构图

**Files:**
- Create: `game/assets/customer.jpg`（复制已确认原创人物，不重新生成）
- Modify: `game/js/store-scene.js` 的顾客与场景物件标记
- Modify: `game/css/store.css`、`game/css/base.css`
- Test: `tests/store_browser.py`

**Interfaces:**
- Consumes: 现有 `buildMarkup()`、`data-testid="customer-line"`、全部商品/咖啡 testid。
- Produces: `data-testid="customer-portrait"` 人物图片；现有交互签名不变。

- [ ] **Step 1: 写失败测试**：新增顾客图片可见且 `naturalWidth > 0`、商品名不竖排、主要场景区域边界不溢出断言；保留现有付钱、价格和交互测试。
- [ ] **Step 2: 运行确认失败**：`$env:PLAYWRIGHT_BROWSERS_PATH='d:\无限世界大赛\.playwright-browsers'; .\.venv\Scripts\python.exe tests\store_browser.py`，预期人物资源/布局断言失败。
- [ ] **Step 3: 增量实现**：复制人物图；把双色 `.customer-figure` 改为含 `<img>` 的人物容器，保留对话框和现有流程；按 B 稿调整三栏比例、旧木/纸张/暗红门、商品排列与底部留白，不删除后来添加的 receipt/payment 样式。
- [ ] **Step 4: 运行确认通过**：重复 Step 2，预期全部营业区测试通过且人物无 404。

### Task 2: 仓库开门动画与延迟切场

**Files:**
- Modify: `game/js/store-scene.js` 的 `submitLock()`、门标记、`destroy()`
- Modify: `game/css/store.css`
- Test: `tests/store_browser.py`

**Interfaces:**
- Consumes: 现有 `tryWarehouseCode(state, code)`、`api.enterWarehouse()`。
- Produces: 门 `data-state="closed|opening"` 与 `.door-leaf`、`.door-interior`；动画完成仍只调用一次 `api.enterWarehouse()`。

- [ ] **Step 1: 写失败测试**：正确密码后先断言门为 opening 且 `enterWarehouseCalls === 0`，等待动画后断言恰好为 1；增加动画中 destroy 后等待仍不得调用切场的测试。将现有成功路径改为显式等待动画完成，不删原断言。
- [ ] **Step 2: 运行确认失败**：执行营业区浏览器测试，预期 opening/延迟切换断言失败。
- [ ] **Step 3: 增量实现**：在现有门内加入门内暗部、门板与把手；成功分支设置 opening 并保存计时器，常规约 1400ms、减少动态效果约 100ms 后进入仓库；`destroy()` 先清理计时器。CSS 依次表现锁舌、把手、门缝和 `rotateY` 开门，保留现有 `is-open` 状态兼容。
- [ ] **Step 4: 运行确认通过**：重复营业区测试，预期动态密码 864/648、重复提交与 destroy 全部通过。

### Task 3: 仓库真实轮廓与顺序导管

**Files:**
- Modify: `game/js/warehouse-scene.js`
- Modify: `game/css/warehouse.css`
- Test: `tests/warehouse_browser.py`

**Interfaces:**
- Consumes: 现有 `PARTS`、`CABLE_ROUTE`、组件/节点/旋钮 testid。
- Produces: 共用的 `partVisual(partId, outline)` SVG 呈现；节点顺序 `energy → stabilizer → focus → frame`；逻辑状态结构不变。

- [ ] **Step 1: 写失败测试**：断言三个组件与插槽均有对应形状 SVG、插槽不是空文字矩形；读取节点横坐标并验证严格递增；断言传送门完整位于场景边界内。
- [ ] **Step 2: 运行确认失败**：`$env:PLAYWRIGHT_BROWSERS_PATH='d:\无限世界大赛\.playwright-browsers'; .\.venv\Scripts\python.exe tests\warehouse_browser.py`，预期视觉结构断言失败。
- [ ] **Step 3: 增量实现**：为能源接口绘制插座/铜端子，为稳定器绘制线圈/配重，为聚焦环绘制同心环/镜片；同一形状用于实物和虚线轮廓。用单一顺序数组和位置表驱动节点与连线，所有节点同一水平线。按 B 稿将传送门置于右侧完整区域，左侧安排组件、导管和波形，保留空眼印记与遗物隐藏逻辑。
- [ ] **Step 4: 运行确认通过**：重复仓库浏览器测试并执行 `npm test`，预期有/无遗物、错误接线、重置、完成交接均通过。

### Task 4: 整体验证与视觉复核

**Files:**
- Create: `.screenshots/ui-b-store.png`、`.screenshots/ui-b-store-unlocked.png`、`.screenshots/ui-b-warehouse.png`
- Modify: 仅在证据暴露问题时回到上述对应文件做最小修正

**Interfaces:**
- Consumes: Task 1–3 的正式场景与测试夹具。
- Produces: 可交付的 B 稿实际运行截图和验证结果。

- [ ] **Step 1: 全量回归**：执行 `npm test`、营业区/仓库浏览器测试及项目现有 `tests/e2e.py`，预期全部通过。
- [ ] **Step 2: 截图与布局检查**：用项目 Playwright 记录营业区、开门中间态和仓库；检查人物脸部、商品名、组件、顺序节点、传送门和底部反馈，无遮挡/溢出/控制台错误。
- [ ] **Step 3: 减少动态效果复核**：模拟 `reduced_motion='reduce'`，确认开门快速完成且只切场一次；最终核对 `git diff --stat`，确认没有无关文件被删除或回退。
