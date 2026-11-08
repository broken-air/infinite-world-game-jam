/**
 * 营业区场景：接待扫码 → 咖啡制作交付 → 图纸 → 小票动态密码 → 仓库解锁。
 * 游戏逻辑全部委托 store-logic.js；本模块只负责呈现、交互路由与生命周期。
 */

import {
  PRODUCTS,
  createStoreState,
  scanProduct,
  prepareCoffee,
  serveCoffee,
  tryWarehouseCode,
} from './store-logic.js';

const PRODUCT_NAMES = {
  onigiri: '饭团',
  coffee_capsule: '咖啡胶囊',
  battery: '电池',
};

const DIGIT_KEYS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const CUSTOMER_PORTRAIT = new URL('../assets/customer.jpg', import.meta.url).href;

/**
 * Mount the store scene.
 * @param {HTMLElement} container
 * @param {import('./contracts.js').StoreSceneApi} api
 * @returns {import('./contracts.js').StoreSceneHandle}
 */
export function mountStoreScene(container, api) {
  /** @type {import('./store-logic.js').StoreState} */
  const state = createStoreState();
  const listeners = [];

  /** @type {{kind: 'product'|'bag'|'cup', id?: string}|null} */
  let selected = null;
  /** @type {{kind: 'product'|'bag'|'cup', id?: string}|null} */
  let dragging = null;
  let cupPlaced = false;
  let capsuleInserted = false;
  let enteredWarehouse = false;
  let enteredDigits = [];
  let doorTimer = null;

  const root = document.createElement('section');
  root.className = 'scene scene--store store-scene';
  root.dataset.scene = 'store';
  root.innerHTML = buildMarkup();
  container.append(root);

  const qs = (selector) => root.querySelector(selector);
  const narrationText = qs('[data-testid="narration-text"]');
  const customerLine = qs('[data-testid="customer-line"]');
  const bagItems = qs('[data-testid="product-bag"]');
  const receiptPreview = qs('[data-testid="receipt-preview"]');
  const scannerEl = qs('[data-testid="scanner"]');
  const machineEl = qs('[data-testid="coffee-machine"]');
  const machineStatus = qs('[data-testid="machine-status"]');
  const machineSlotCup = qs('[data-slot="cup"]');
  const machineSlotCapsule = qs('[data-slot="capsule"]');
  const cupEl = qs('[data-testid="cup"]');
  const brewButton = qs('[data-testid="brew-start"]');
  const serveButton = qs('[data-testid="serve-coffee"]');
  const blueprintButton = qs('[data-testid="blueprint"]');
  const doorEl = qs('[data-testid="warehouse-door"]');
  const doorHint = qs('[data-door-hint]');
  const lockPanel = qs('[data-testid="warehouse-lock"]');
  const lockTiles = Array.from(root.querySelectorAll('[data-testid="lock-input"] i'));
  const lockNote = qs('[data-testid="lock-note"]');
  const feedbackEl = qs('[data-testid="store-feedback"]');
  const closeupEl = qs('[data-testid="store-closeup"]');
  const closeupCard = qs('[data-testid="closeup-card"]');

  /** 追踪式监听绑定：destroy 时逐一解绑。 */
  function bind(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    listeners.push([target, type, handler, options]);
  }

  function say(text) {
    feedbackEl.textContent = text;
  }

  // ---------------------------------------------------------------- 渲染
  function renderContext(exitHook) {
    narrationText.textContent = exitHook || '（本局尚未写入承接旁白）';
  }

  function renderSelection() {
    for (const el of root.querySelectorAll('[data-product]')) {
      const isSelected = selected?.kind === 'product' && selected.id === el.dataset.product;
      el.classList.toggle('is-selected', isSelected);
    }
    for (const el of root.querySelectorAll('[data-bag]')) {
      const isSelected = selected?.kind === 'bag' && selected.id === el.dataset.bag;
      el.classList.toggle('is-selected', isSelected);
    }
    cupEl.classList.toggle('is-selected', selected?.kind === 'cup');
  }

  function renderBag() {
    bagItems.replaceChildren(...state.receiptOrder.map((id) => {
      const chip = document.createElement('div');
      chip.className = 'bag-chip';
      chip.dataset.testid = `bag-${id}`;
      chip.dataset.action = 'select-bag';
      chip.dataset.bag = id;
      chip.draggable = true;
      chip.textContent = PRODUCT_NAMES[id];
      bind(chip, 'click', () => selectBag(id));
      bind(chip, 'dragstart', (event) => startDrag(event, 'bag', id));
      bind(chip, 'dragend', stopDrag);
      return chip;
    }));
  }

  function renderReceiptPreview() {
    receiptPreview.textContent = state.receiptOrder.length
      ? state.receiptOrder.map((id) => `${PRODUCT_NAMES[id]} ¥${PRODUCTS[id]}`).join('\n')
      : '（还没有商品）';
  }

  function renderDigits() {
    lockTiles.forEach((tile, index) => {
      tile.textContent = enteredDigits[index] ?? '';
    });
  }

  // ---------------------------------------------------------------- 选择
  function selectProduct(id) {
    if (selected?.kind === 'product' && selected.id === id) {
      selected = null;
      say('把商品放回了货架。');
    } else {
      selected = { kind: 'product', id };
      say(`拿起了${PRODUCT_NAMES[id]}：放到扫码器上结账（点扫码器或拖过去）。`);
    }
    api.playSound('ui.click');
    renderSelection();
  }

  function selectBag(id) {
    if (selected?.kind === 'bag' && selected.id === id) {
      selected = null;
      say('收回了手。');
    } else {
      selected = { kind: 'bag', id };
      say(`拿起了扫过码的${PRODUCT_NAMES[id]}。`);
    }
    api.playSound('ui.click');
    renderSelection();
  }

  function selectCup() {
    if (cupPlaced) {
      api.playSound('ui.click');
      say('纸杯已经在咖啡机里了。');
      return;
    }
    if (selected?.kind === 'cup') {
      selected = null;
      say('把纸杯放了回去。');
    } else {
      selected = { kind: 'cup' };
      say('拿起了纸杯：放到咖啡机上（点咖啡机或拖过去）。');
    }
    api.playSound('ui.click');
    renderSelection();
  }

  // ---------------------------------------------------------------- 营业动作
  function attemptScan(id) {
    if (scanProduct(state, id)) {
      api.registerInteraction();
      api.playSound('store.scan');
      renderBag();
      renderReceiptPreview();
      root.querySelector(`[data-product='${id}']`)?.classList.add('is-scanned');
      say(`已扫码：${PRODUCT_NAMES[id]} ¥${PRODUCTS[id]}。`);
      if (state.receiptOrder.length === Object.keys(PRODUCTS).length) {
        customerLine.textContent = '都齐了。再给我杯热咖啡，谢谢。';
      }
    } else {
      api.playSound('ui.click');
      say(`重复扫码：${PRODUCT_NAMES[id]}已经扫过，小票不重复记账。`);
    }
    selected = null;
    renderSelection();
  }

  function placeCup() {
    if (cupPlaced) {
      api.playSound('ui.click');
      say('纸杯已经放好了。');
      return;
    }
    cupPlaced = true;
    machineSlotCup.classList.add('is-filled');
    cupEl.classList.add('is-used');
    selected = null;
    renderSelection();
    api.registerInteraction();
    api.playSound('store.coffee');
    say('纸杯卡进了咖啡机。');
  }

  function insertCapsule() {
    if (capsuleInserted) {
      api.playSound('ui.click');
      say('胶囊已经放进去了。');
      return;
    }
    if (!state.receiptOrder.includes('coffee_capsule')) {
      api.playSound('ui.click');
      say('这颗胶囊还没扫码结账，不能拆。');
      return;
    }
    capsuleInserted = true;
    machineSlotCapsule.classList.add('is-filled');
    selected = null;
    renderSelection();
    api.registerInteraction();
    api.playSound('store.coffee');
    say('胶囊卡进去了，可以启动冲泡。');
  }

  function brew() {
    if (state.coffeePrepared) {
      api.playSound('ui.click');
      say('咖啡已经在杯子里了。');
      return;
    }
    if (!cupPlaced) {
      api.playSound('ui.click');
      say('咖啡机嘀了两声：先放个纸杯。');
      return;
    }
    if (!capsuleInserted) {
      api.playSound('ui.click');
      say('咖啡机没有反应：还差一颗已扫码的胶囊。');
      return;
    }
    if (!prepareCoffee(state)) {
      api.playSound('ui.click');
      say('咖啡机没有反应。');
      return;
    }
    machineStatus.textContent = '咖啡好了';
    serveButton.hidden = false;
    api.registerInteraction();
    api.playSound('store.coffee');
    say('咖啡好了，热气从杯口冒出来。');
  }

  function serve() {
    if (serveCoffee(state)) {
      machineStatus.textContent = '已交付';
      serveButton.hidden = true;
      blueprintButton.hidden = false;
      lockPanel.hidden = false;
      customerLine.textContent = '咖啡不错。这张值班图纸你拿着——去天台要先过仓库，门锁数字的顺序，都写在你的小票上。';
      api.registerInteraction();
      api.playSound('store.coffee');
      say('客人把一张值班图纸推了过来，还朝仓库的方向抬了抬下巴。');
      openCloseup('payment');
    } else if (!state.coffeePrepared) {
      api.playSound('ui.click');
      say('手里还没有做好的咖啡。');
    } else {
      api.playSound('ui.click');
      say('客人指了指货架：还有商品没结账。');
    }
  }

  // ---------------------------------------------------------------- 近景
  function openCloseup(kind, id) {
    closeupCard.replaceChildren(buildCloseup(kind, id));
    closeupEl.hidden = false;
    closeupEl.dataset.closeup = kind;
    api.registerInteraction();
    api.playSound(kind === 'blueprint' ? 'ui.click' : 'store.receipt');
  }

  function closeCloseup() {
    closeupEl.hidden = true;
    closeupCard.replaceChildren();
    api.playSound('ui.click');
  }

  function buildCloseup(kind, id) {
    if (kind === 'receipt') return buildReceiptCloseup();
    if (kind === 'tag') return buildTagCloseup(id);
    if (kind === 'payment') return buildPaymentCloseup();
    return buildBlueprintCloseup();
  }

  function buildReceiptCloseup() {
    const wrap = document.createElement('div');
    wrap.className = 'closeup-receipt';
    wrap.innerHTML = '<h3>天台便利店 · 收银小票</h3>';
    const list = document.createElement('ol');
    for (const id of state.receiptOrder) {
      const line = document.createElement('li');
      line.dataset.testid = `receipt-line-${id}`;
      line.dataset.lineId = id;
      const price = String(PRODUCTS[id]);
      line.innerHTML = `<span>${PRODUCT_NAMES[id]}</span><span class="receipt-leader" aria-hidden="true"></span><span class="receipt-price">¥${price.slice(0, -1)}<strong class="receipt-code-digit">${price.at(-1)}</strong></span>`;
      list.append(line);
    }
    wrap.append(list);
    const total = document.createElement('p');
    total.className = 'receipt-total';
    total.dataset.testid = 'receipt-total';
    total.textContent = `合计 ¥${state.receiptOrder.reduce((sum, id) => sum + PRODUCTS[id], 0)}`;
    wrap.append(total);
    const hint = document.createElement('p');
    hint.className = 'receipt-hint';
    hint.textContent = '商品按扫码先后顺序排列。';
    wrap.append(hint);
    return wrap;
  }

  function buildPaymentCloseup() {
    const wrap = document.createElement('div');
    wrap.className = 'payment-closeup';
    wrap.dataset.testid = 'payment-closeup';
    wrap.innerHTML = `
      <div class="payment-copy">
        <span class="closeup-kicker">客人留下的东西</span>
        <h3>一枚硬币，一张图纸</h3>
        <p>硬币中央刻着陌生的印记；图纸上画着传送门的导管走向。</p>
        <p class="payment-note">他没有找零，也没有再看你。</p>
      </div>
      <div class="payment-objects">
      <div class="coin-stage" aria-label="刻有陌生印记的金属硬币">
        <svg class="payment-coin" viewBox="0 0 240 240" role="img" aria-label="硬币上的空眼印记">
          <circle class="coin-shadow" cx="120" cy="126" r="91"></circle>
          <circle class="coin-edge" cx="120" cy="120" r="91"></circle>
          <circle class="coin-face" cx="120" cy="120" r="82"></circle>
          <circle class="coin-groove" cx="120" cy="120" r="72"></circle>
          <path class="coin-scratch" d="M72 76L91 88M158 70L148 91M69 151L94 143M154 158L169 145M104 49L109 64"></path>
          <g class="coin-world-mark" data-testid="payment-world-mark" data-world-mark="hollow-eye">
            <path d="M82 120 Q120 85 158 120 Q120 155 82 120Z"></path>
            <circle cx="120" cy="120" r="13"></circle>
            <path d="M120 94V105M120 135V146M94 120H103M137 120H146"></path>
          </g>
        </svg>
      </div>
      <div class="payment-blueprint" data-testid="payment-blueprint">
        <span class="payment-blueprint-title">值班图纸</span>
        <span class="payment-blueprint-subtitle">导管连接顺序</span>
        <p>能源接口 → 稳定器 → 聚焦环 → 门框</p>
        <i aria-hidden="true"></i>
      </div>
      </div>`;
    return wrap;
  }

  function buildTagCloseup(id) {
    const wrap = document.createElement('div');
    wrap.className = 'closeup-tag';
    wrap.dataset.testid = `tag-closeup-${id}`;
    const name = document.createElement('span');
    name.textContent = PRODUCT_NAMES[id];
    const price = document.createElement('strong');
    price.textContent = `¥${PRODUCTS[id]}`;
    const note = document.createElement('span');
    note.textContent = '原价签 · 未调价';
    wrap.append(name, price, note);
    return wrap;
  }

  function buildBlueprintCloseup() {
    const wrap = document.createElement('div');
    wrap.className = 'closeup-blueprint';
    wrap.dataset.testid = 'blueprint-closeup';
    wrap.innerHTML = `
      <h3>值班图纸（客人手绘）</h3>
      <div class="blueprint-plan" aria-hidden="true"><span>营业区</span><i></i><span>仓库内门</span><i></i><span>天台出口</span></div>
      <div class="blueprint-cables">
        <h4>导管连接顺序</h4>
        <p>能源接口 → 稳定器 → 聚焦环 → 门框</p>
      </div>
      <p>图角有一行小字：“去天台，先开仓库。门锁是三位数字——按小票上价格的先后顺序读。”</p>`;
    return wrap;
  }

  // ---------------------------------------------------------------- 门锁
  function pressDigit(digit) {
    if (state.warehouseUnlocked) return;
    if (enteredDigits.length >= 3) {
      api.playSound('ui.click');
      say('已经按了三位，按“开锁”试试。');
      return;
    }
    enteredDigits.push(digit);
    renderDigits();
    api.playSound('ui.click');
  }

  function clearDigits() {
    enteredDigits = [];
    renderDigits();
    api.playSound('ui.click');
  }

  function submitLock() {
    if (state.warehouseUnlocked) {
      say('仓库门已经开了。');
      return;
    }
    if (enteredDigits.length !== 3) {
      api.playSound('ui.click');
      say('门锁需要三位数字。');
      return;
    }
    api.registerInteraction();
    const code = enteredDigits.join('');
    if (tryWarehouseCode(state, code)) {
      api.playSound('store.unlock');
      enteredDigits = [];
      renderDigits();
      lockPanel.classList.add('is-unlocked');
      lockNote.textContent = '已解锁 · 门开了';
      doorEl.classList.add('is-opening', 'is-open');
      doorEl.dataset.state = 'opening';
      doorHint.textContent = '内门 · 正在开启';
      say('咔——锁舌缩了回去，门缝里的光慢慢亮了。');
      if (!enteredWarehouse) {
        enteredWarehouse = true;
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        doorTimer = window.setTimeout(() => {
          doorTimer = null;
          api.enterWarehouse();
        }, reducedMotion ? 100 : 1400);
      }
    } else {
      api.playSound('store.lock');
      enteredDigits = [];
      renderDigits();
      say('密码不对，锁没有动。按小票价格的先后顺序读三位数字。');
    }
  }

  function knockDoor() {
    api.playSound('ui.click');
    if (state.warehouseUnlocked) {
      say('仓库门已经开了。');
    } else if (lockPanel.hidden) {
      say('仓库门锁着，锁孔需要三位数字——现在还没有头绪。');
    } else {
      say('门锁是三位数字，顺序就藏在小票里。');
    }
  }

  // ---------------------------------------------------------------- 拖放
  function startDrag(event, kind, id) {
    dragging = { kind, id };
    if (event.dataTransfer) {
      event.dataTransfer.setData('text/plain', JSON.stringify({ kind, id }));
      event.dataTransfer.effectAllowed = 'copy';
    }
  }

  function stopDrag() {
    dragging = null;
  }

  function resolveDragPayload(event) {
    if (dragging) return dragging;
    try {
      const raw = event.dataTransfer ? event.dataTransfer.getData('text/plain') : '';
      if (raw) return JSON.parse(raw);
    } catch {
      // 非 JSON 负载一律视为空手
    }
    return null;
  }

  function allowDrop(event) {
    event.preventDefault();
  }

  function dropOnScanner(event) {
    event.preventDefault();
    const payload = resolveDragPayload(event);
    dragging = null;
    if (!payload || payload.kind !== 'product' || !Object.hasOwn(PRODUCTS, payload.id)) {
      say('把货架上的商品拖到扫码器上。');
      return;
    }
    attemptScan(payload.id);
  }

  function dropOnMachine(event) {
    event.preventDefault();
    const payload = resolveDragPayload(event);
    dragging = null;
    if (!payload) return;
    if (payload.kind === 'cup') {
      placeCup();
    } else if (payload.kind === 'bag' && payload.id === 'coffee_capsule') {
      insertCapsule();
    } else if (payload.kind === 'product' && payload.id === 'coffee_capsule') {
      api.playSound('ui.click');
      say('胶囊还没扫码结账，不能拆。');
    } else {
      api.playSound('ui.click');
      say('咖啡机只收纸杯和已扫码的胶囊。');
    }
  }

  // ---------------------------------------------------------------- 点击目标动作
  function actOnScanner() {
    if (!selected) {
      api.playSound('ui.click');
      say('扫码器亮着红点：先拿起一件商品。');
      return;
    }
    if (selected.kind === 'product') {
      attemptScan(selected.id);
      return;
    }
    api.playSound('ui.click');
    say('这个已经在小票上了。');
  }

  function actOnMachine() {
    if (!selected) {
      api.playSound('ui.click');
      say('把纸杯或已扫码的胶囊放到咖啡机上（点击或拖放）。');
      return;
    }
    if (selected.kind === 'cup') {
      placeCup();
      return;
    }
    if (selected.kind === 'bag' && selected.id === 'coffee_capsule') {
      insertCapsule();
      return;
    }
    if (selected.kind === 'product' && selected.id === 'coffee_capsule') {
      api.playSound('ui.click');
      say('胶囊还没扫码结账，不能拆。');
      return;
    }
    api.playSound('ui.click');
    say('咖啡机只收纸杯和已扫码的胶囊。');
  }

  // ---------------------------------------------------------------- 标记
  function buildMarkup() {
    const productCards = Object.entries(PRODUCTS).map(([id, price]) => `
      <div class="product" data-testid="product-${id}" data-action="select-product" data-product="${id}"
        draggable="true" role="button" aria-label="${PRODUCT_NAMES[id]}，价签 ${price} 元">
        <span class="product-art product-art--${id}" aria-hidden="true"></span>
        <span class="product-name">${PRODUCT_NAMES[id]}</span>
        <button class="price-tag" type="button" data-testid="price-tag-${id}" data-action="view-tag">¥${price}</button>
      </div>`).join('');
    const keys = DIGIT_KEYS.map((digit) => `
      <button class="lock-key" type="button" data-testid="lock-key-${digit}" data-action="lock-key">${digit}</button>`).join('');
    return `
      <div class="store-narration" data-testid="store-narration">
        <span class="narration-time">23:47 · 一层营业区</span>
        <span data-testid="narration-text"></span>
      </div>
      <div class="store-layout">
        <div class="store-zone store-zone--shelf">
          <div class="store-glass" aria-hidden="true"><span>天台方向 · 雨</span></div>
          <div class="store-shelf" aria-label="货架与价签">${productCards}</div>
          <div class="store-bag">
            <span class="bag-title">已扫商品（咖啡机只认这里的东西）</span>
            <div class="bag-items" data-testid="product-bag"></div>
          </div>
        </div>
        <div class="store-zone store-zone--counter">
          <div class="customer">
            <div class="customer-bubble" data-testid="customer-line">夜班员，麻烦结账。</div>
            <div class="customer-figure">
              <img src="${CUSTOMER_PORTRAIT}" alt="站在柜台前、微微移开视线的神秘夜班客人" data-testid="customer-portrait" draggable="false">
            </div>
          </div>
          <div class="counter-desk">
            <div class="scanner" data-testid="scanner" data-action="scan" role="button" aria-label="扫码器">
              <span class="scanner-lamp" aria-hidden="true"></span>
              <span>扫码器</span>
            </div>
            <div class="receipt" data-testid="receipt" data-action="view-receipt" role="button" aria-label="查看小票近景">
              <span class="receipt-title">小票</span>
              <span class="receipt-preview" data-testid="receipt-preview"></span>
            </div>
          </div>
          <div class="coffee-station">
            <div class="coffee-machine" data-testid="coffee-machine" data-action="coffee-target"
              role="button" aria-label="咖啡机：接收纸杯与已扫码的胶囊">
              <span class="machine-title">咖啡机</span>
              <div class="machine-slots" aria-hidden="true">
                <i class="machine-slot" data-slot="cup"></i>
                <i class="machine-slot" data-slot="capsule"></i>
              </div>
              <span class="machine-status" data-testid="machine-status">待机</span>
              <button class="machine-brew" type="button" data-testid="brew-start" data-action="brew">启动冲泡</button>
            </div>
            <div class="coffee-side">
              <div class="cup" data-testid="cup" data-action="select-cup" draggable="true" role="button" aria-label="纸杯">纸杯</div>
              <button class="serve-button" type="button" data-testid="serve-coffee" data-action="serve" hidden>递给客人</button>
            </div>
          </div>
        </div>
        <div class="store-zone store-zone--door">
          <div class="warehouse-door" data-testid="warehouse-door" data-action="door" data-state="closed" role="button" aria-label="仓库门">
            <div class="door-interior" aria-hidden="true"><i></i><i></i><i></i></div>
            <div class="door-leaf">
              <span class="door-name">仓库</span>
              <span class="door-hint" data-door-hint>内门 · 上锁</span>
              <span class="door-handle" aria-hidden="true"></span>
            </div>
          </div>
          <button class="blueprint-button" type="button" data-testid="blueprint" data-action="view-blueprint" hidden>查看值班图纸</button>
          <div class="warehouse-lock" data-testid="warehouse-lock" hidden>
            <span class="lock-title">仓库门锁</span>
            <div class="lock-input" data-testid="lock-input" aria-label="已输入的门锁数字"><i></i><i></i><i></i></div>
            <div class="lock-keys">${keys}</div>
            <div class="lock-actions">
              <button class="lock-clear" type="button" data-testid="lock-clear" data-action="lock-clear">清除</button>
              <button class="lock-submit" type="button" data-testid="lock-submit" data-action="lock-submit">开锁</button>
            </div>
            <span class="lock-note" data-testid="lock-note">三位数字 · 可反复尝试</span>
          </div>
        </div>
      </div>
      <p class="store-feedback" data-testid="store-feedback" role="status"></p>
      <div class="store-closeup" data-testid="store-closeup" hidden>
        <div class="closeup-card" data-testid="closeup-card"></div>
        <button class="closeup-close" type="button" data-testid="closeup-close" data-action="closeup-close">合上</button>
      </div>`;
  }

  // ---------------------------------------------------------------- 事件接线
  for (const el of root.querySelectorAll('[data-product]')) {
    const id = el.dataset.product;
    bind(el, 'click', () => selectProduct(id));
    bind(el, 'dragstart', (event) => startDrag(event, 'product', id));
    bind(el, 'dragend', stopDrag);
  }
  for (const el of root.querySelectorAll('[data-action="view-tag"]')) {
    const id = el.closest('[data-product]')?.dataset.product;
    bind(el, 'click', (event) => {
      event.stopPropagation();
      openCloseup('tag', id);
    });
  }
  bind(scannerEl, 'click', actOnScanner);
  bind(scannerEl, 'dragover', allowDrop);
  bind(scannerEl, 'drop', dropOnScanner);
  bind(machineEl, 'click', actOnMachine);
  bind(machineEl, 'dragover', allowDrop);
  bind(machineEl, 'drop', dropOnMachine);
  bind(brewButton, 'click', (event) => {
    event.stopPropagation();
    brew();
  });
  bind(cupEl, 'click', selectCup);
  bind(cupEl, 'dragstart', (event) => startDrag(event, 'cup', 'cup'));
  bind(cupEl, 'dragend', stopDrag);
  bind(serveButton, 'click', serve);
  bind(qs('[data-testid="receipt"]'), 'click', () => openCloseup('receipt'));
  bind(blueprintButton, 'click', () => openCloseup('blueprint'));
  bind(doorEl, 'click', knockDoor);
  for (const digit of DIGIT_KEYS) {
    bind(qs(`[data-testid="lock-key-${digit}"]`), 'click', () => pressDigit(digit));
  }
  bind(qs('[data-testid="lock-clear"]'), 'click', clearDigits);
  bind(qs('[data-testid="lock-submit"]'), 'click', submitLock);
  bind(qs('[data-testid="closeup-close"]'), 'click', closeCloseup);

  renderContext(api.exitHook);
  renderBag();
  renderReceiptPreview();
  renderDigits();

  return {
    destroy() {
      if (doorTimer !== null) {
        window.clearTimeout(doorTimer);
        doorTimer = null;
      }
      for (const [target, type, handler, options] of listeners) {
        target.removeEventListener(type, handler, options);
      }
      listeners.length = 0;
      root.remove();
    },
    updateContext(context) {
      renderContext(context.exitHook);
    },
  };
}
