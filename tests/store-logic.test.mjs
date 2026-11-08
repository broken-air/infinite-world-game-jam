import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRODUCTS,
  createStoreState,
  scanProduct,
  prepareCoffee,
  serveCoffee,
  getWarehouseCode,
  tryWarehouseCode,
} from '../game/js/store-logic.js';

function snapshot(state) {
  return structuredClone(state);
}

test('PRODUCTS 固定价格表：饭团 16、咖啡胶囊 24、电池 38', () => {
  assert.deepEqual({ ...PRODUCTS }, { onigiri: 16, coffee_capsule: 24, battery: 38 });
});

test('createStoreState 返回干净的初始状态', () => {
  const state = createStoreState();
  assert.deepEqual(state.receiptOrder, []);
  assert.equal(state.blueprintReceived, false);
});

test('固定场景：battery→onigiri→coffee_capsule 得到密码 864，重复扫码与错误密码被拒绝', () => {
  const state = createStoreState();
  assert.equal(scanProduct(state, 'battery'), true);
  assert.equal(scanProduct(state, 'onigiri'), true);
  assert.equal(scanProduct(state, 'coffee_capsule'), true);
  assert.deepEqual(state.receiptOrder, ['battery', 'onigiri', 'coffee_capsule']);
  assert.equal(getWarehouseCode(state), '864');
  assert.equal(scanProduct(state, 'battery'), false);
  assert.equal(tryWarehouseCode(state, '123'), false);
  assert.equal(tryWarehouseCode(state, '864'), true);
});

test('重复扫码返回 false 且不改变状态', () => {
  const state = createStoreState();
  assert.equal(scanProduct(state, 'onigiri'), true);
  const before = snapshot(state);
  assert.equal(scanProduct(state, 'onigiri'), false);
  assert.deepEqual(state, before);
});

test('未知商品返回 false 且不改变状态', () => {
  const state = createStoreState();
  assert.equal(scanProduct(state, 'sandwich'), false);
  const before = snapshot(state);
  assert.equal(scanProduct(state, 'toString'), false);
  assert.equal(scanProduct(state, ''), false);
  assert.deepEqual(state, before);
});

test('胶囊未扫码时 prepareCoffee 返回 false', () => {
  const empty = createStoreState();
  assert.equal(prepareCoffee(empty), false);

  const state = createStoreState();
  assert.equal(scanProduct(state, 'battery'), true);
  assert.equal(scanProduct(state, 'onigiri'), true);
  assert.equal(prepareCoffee(state), false);
  assert.equal(state.coffeePrepared, false);
});

test('咖啡未就绪时 serveCoffee 返回 false（即使三件商品已扫完）', () => {
  const state = createStoreState();
  for (const id of ['battery', 'onigiri', 'coffee_capsule']) {
    assert.equal(scanProduct(state, id), true);
  }
  assert.equal(serveCoffee(state), false);
  assert.equal(state.coffeeServed, false);
  assert.equal(state.blueprintReceived, false);
});

test('商品未扫完时 serveCoffee 返回 false（即使咖啡已就绪）', () => {
  const state = createStoreState();
  assert.equal(scanProduct(state, 'coffee_capsule'), true);
  assert.equal(prepareCoffee(state), true);
  assert.equal(serveCoffee(state), false);
  assert.equal(state.blueprintReceived, false);
});

test('完整接待流程：扫满三件并交付咖啡后 blueprintReceived 为 true，重复 serveCoffee 幂等', () => {
  const state = createStoreState();
  for (const id of ['onigiri', 'coffee_capsule', 'battery']) {
    assert.equal(scanProduct(state, id), true);
  }
  assert.equal(prepareCoffee(state), true);
  assert.equal(prepareCoffee(state), false, '咖啡已就绪时重复制作返回 false');
  assert.equal(serveCoffee(state), true);
  assert.equal(state.blueprintReceived, true);
  const before = snapshot(state);
  assert.equal(serveCoffee(state), false, '重复交付返回 false');
  assert.deepEqual(state, before, '重复交付不改变状态');
});

test('不同扫码顺序一：onigiri→battery→coffee_capsule 生成密码 684', () => {
  const state = createStoreState();
  for (const id of ['onigiri', 'battery', 'coffee_capsule']) {
    assert.equal(scanProduct(state, id), true);
  }
  assert.deepEqual(state.receiptOrder, ['onigiri', 'battery', 'coffee_capsule']);
  assert.equal(getWarehouseCode(state), '684');
});

test('不同扫码顺序二：coffee_capsule→battery→onigiri 生成密码 486', () => {
  const state = createStoreState();
  for (const id of ['coffee_capsule', 'battery', 'onigiri']) {
    assert.equal(scanProduct(state, id), true);
  }
  assert.deepEqual(state.receiptOrder, ['coffee_capsule', 'battery', 'onigiri']);
  assert.equal(getWarehouseCode(state), '486');
});

test('部分扫码时 getWarehouseCode 返回 null（密码尚不可用）', () => {
  const empty = createStoreState();
  assert.equal(getWarehouseCode(empty), null);

  const one = createStoreState();
  assert.equal(scanProduct(one, 'onigiri'), true);
  assert.equal(getWarehouseCode(one), null);

  const two = createStoreState();
  assert.equal(scanProduct(two, 'coffee_capsule'), true);
  assert.equal(scanProduct(two, 'battery'), true);
  assert.equal(getWarehouseCode(two), null);
});

test('部分扫码时 tryWarehouseCode 恒为 false，任何密码都不被接受', () => {
  const state = createStoreState();
  assert.equal(scanProduct(state, 'battery'), true);
  assert.equal(scanProduct(state, 'onigiri'), true);
  assert.equal(tryWarehouseCode(state, '68'), false);
  assert.equal(tryWarehouseCode(state, '864'), false);
  assert.equal(tryWarehouseCode(state, ''), false);
  assert.equal(state.warehouseUnlocked, false);
});

test('正确密码重复提交返回 true 且不改变已服务状态；错误密码不清空进度', () => {
  const state = createStoreState();
  for (const id of ['battery', 'onigiri', 'coffee_capsule']) {
    assert.equal(scanProduct(state, id), true);
  }
  assert.equal(prepareCoffee(state), true);
  assert.equal(serveCoffee(state), true);
  assert.equal(tryWarehouseCode(state, '864'), true);

  const unlocked = snapshot(state);
  assert.equal(tryWarehouseCode(state, '864'), true, '重复提交正确密码仍返回 true');
  assert.deepEqual(state, unlocked, '重复提交不改变状态');

  assert.equal(tryWarehouseCode(state, '123'), false, '解锁后再输错误密码只返回 false');
  assert.deepEqual(state, unlocked, '错误密码不清空已服务进度');
  assert.equal(state.blueprintReceived, true);
  assert.equal(state.warehouseUnlocked, true);
});
