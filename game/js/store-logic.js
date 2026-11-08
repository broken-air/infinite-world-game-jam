/**
 * 营业区纯逻辑：小票动态密码与接待流程。
 * 状态只由本模块创建与修改；除 getWarehouseCode 外，操作函数返回 boolean 表示是否接受。
 */

/**
 * 柜台商品固定价格表（单位：元）。
 * @type {Readonly<{onigiri: 16, coffee_capsule: 24, battery: 38}>}
 */
export const PRODUCTS = Object.freeze({
  onigiri: 16,
  coffee_capsule: 24,
  battery: 38,
});

const PRODUCT_COUNT = Object.keys(PRODUCTS).length;

/**
 * @typedef {object} StoreState
 * @property {string[]} receiptOrder 按实际扫码先后记录的商品 ID
 * @property {boolean} coffeePrepared 咖啡是否已制作完成（放杯、放入已扫码胶囊并启动）
 * @property {boolean} coffeeServed 咖啡是否已交付给客人
 * @property {boolean} blueprintReceived 图纸是否已到手（三件商品扫完且咖啡交付）
 * @property {boolean} warehouseUnlocked 仓库密码锁是否已解开
 */

/**
 * 创建干净的初始营业区状态。
 * @returns {StoreState}
 */
export function createStoreState() {
  return {
    receiptOrder: [],
    coffeePrepared: false,
    coffeeServed: false,
    blueprintReceived: false,
    warehouseUnlocked: false,
  };
}

/**
 * 扫描商品并记录到小票。重复或未知商品返回 false 且不改变状态。
 * @param {StoreState} state
 * @param {string} id
 * @returns {boolean}
 */
export function scanProduct(state, id) {
  if (typeof id !== 'string' || !Object.hasOwn(PRODUCTS, id)) {
    return false;
  }
  if (state.receiptOrder.includes(id)) {
    return false;
  }
  state.receiptOrder.push(id);
  return true;
}

/**
 * 制作咖啡：需要咖啡胶囊已扫码；重复制作返回 false。
 * @param {StoreState} state
 * @returns {boolean}
 */
export function prepareCoffee(state) {
  if (state.coffeePrepared) {
    return false;
  }
  if (!state.receiptOrder.includes('coffee_capsule')) {
    return false;
  }
  state.coffeePrepared = true;
  return true;
}

/**
 * 交付咖啡：需要咖啡已就绪且三件商品均已扫码；成功后图纸到手。重复交付返回 false。
 * @param {StoreState} state
 * @returns {boolean}
 */
export function serveCoffee(state) {
  if (state.coffeeServed || !state.coffeePrepared) {
    return false;
  }
  if (state.receiptOrder.length !== PRODUCT_COUNT) {
    return false;
  }
  state.coffeeServed = true;
  state.blueprintReceived = true;
  return true;
}

/**
 * 读取小票动态密码：按扫码顺序拼接商品价格个位（小票红字）；未扫满三件时返回 null。
 * @param {StoreState} state
 * @returns {string|null}
 */
export function getWarehouseCode(state) {
  if (state.receiptOrder.length !== PRODUCT_COUNT) {
    return null;
  }
  return state.receiptOrder.map((id) => String(PRODUCTS[id] % 10)).join('');
}

/**
 * 尝试仓库密码锁。错误密码只返回 false，不清空任何进度；
 * 正确密码返回 true，重复提交同样返回 true 且不重复改变已服务状态。
 * @param {StoreState} state
 * @param {string} code
 * @returns {boolean}
 */
export function tryWarehouseCode(state, code) {
  const expected = getWarehouseCode(state);
  if (expected === null || code !== expected) {
    return false;
  }
  state.warehouseUnlocked = true;
  return true;
}
