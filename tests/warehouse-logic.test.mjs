import test from "node:test";
import assert from "node:assert/strict";

import {
  createWarehouseState,
  setSanityRelic,
  placePart,
  connectCable,
  adjustDial,
  resetWiring,
  resetDials,
  canStartPortal,
  startPortal,
} from "../game/js/warehouse-logic.js";

function completeAssembly(state) {
  assert.equal(placePart(state, "focus", "focus"), true);
  assert.equal(placePart(state, "energy", "energy"), true);
  assert.equal(placePart(state, "stabilizer", "stabilizer"), true);
  assert.equal(connectCable(state, "energy", "stabilizer"), true);
  assert.equal(connectCable(state, "stabilizer", "focus"), true);
  assert.equal(connectCable(state, "focus", "frame"), true);
}

function completeDials(state) {
  assert.equal(adjustDial(state, "amplitude", 2), true);
  assert.equal(adjustDial(state, "frequency", 3), true);
  assert.equal(adjustDial(state, "phase", 1), true);
}

test("无遗物时必须完成装配、导管和全部调频才能启动", () => {
  const state = createWarehouseState({ hasSanityRelic: false });

  assert.equal(canStartPortal(state), false);
  completeAssembly(state);
  assert.equal(canStartPortal(state), false);
  assert.equal(startPortal(state), false);

  completeDials(state);
  assert.equal(canStartPortal(state), true);
  assert.equal(startPortal(state), true);
  assert.equal(state.portalStarted, true);
  assert.equal(startPortal(state), false);
});

test("组件允许任意顺序安装，错误组件和槽位不会清除正确进度", () => {
  const state = createWarehouseState();

  assert.equal(placePart(state, "energy", "energy"), true);
  assert.equal(placePart(state, "stabilizer", "energy"), false);
  assert.equal(placePart(state, "unknown", "stabilizer"), false);
  assert.equal(placePart(state, "stabilizer", "unknown"), false);
  assert.equal(placePart(state, "energy", "energy"), false);
  assert.deepEqual(state.parts, {
    energy: "energy",
    stabilizer: null,
    focus: null,
  });
});

test("只接受三条正确的有向导管，错误和重复连接不影响已有连接", () => {
  const state = createWarehouseState();

  assert.equal(connectCable(state, "energy", "focus"), false);
  assert.equal(connectCable(state, "stabilizer", "energy"), false);
  assert.equal(connectCable(state, "energy", "stabilizer"), true);
  assert.equal(connectCable(state, "energy", "stabilizer"), false);
  assert.equal(connectCable(state, "focus", "frame"), true);
  assert.equal(connectCable(state, "stabilizer", "focus"), true);
  assert.deepEqual(state.cables, [
    "energy->stabilizer",
    "focus->frame",
    "stabilizer->focus",
  ]);
});

test("调频只接受 0 到 4 的整数，单项调对后锁定", () => {
  const state = createWarehouseState();

  assert.equal(adjustDial(state, "amplitude", -1), false);
  assert.equal(adjustDial(state, "amplitude", 5), false);
  assert.equal(adjustDial(state, "amplitude", 1.5), false);
  assert.equal(adjustDial(state, "unknown", 2), false);
  assert.equal(adjustDial(state, "amplitude", 1), true);
  assert.equal(state.lockedDials.includes("amplitude"), false);

  assert.equal(adjustDial(state, "amplitude", 2), true);
  assert.equal(state.lockedDials.includes("amplitude"), true);
  assert.equal(adjustDial(state, "amplitude", 0), false);
  assert.equal(state.dials.amplitude, 2);
});

test("局部重置只影响对应系统", () => {
  const state = createWarehouseState();
  completeAssembly(state);
  completeDials(state);

  resetWiring(state);
  assert.deepEqual(state.cables, []);
  assert.deepEqual(state.parts, {
    energy: "energy",
    stabilizer: "stabilizer",
    focus: "focus",
  });
  assert.deepEqual(state.dials, { amplitude: 2, frequency: 3, phase: 1 });
  assert.deepEqual(state.lockedDials, ["amplitude", "frequency", "phase"]);

  assert.equal(connectCable(state, "energy", "stabilizer"), true);
  assert.equal(connectCable(state, "stabilizer", "focus"), true);
  assert.equal(connectCable(state, "focus", "frame"), true);
  resetDials(state);
  assert.deepEqual(state.dials, { amplitude: 0, frequency: 0, phase: 0 });
  assert.deepEqual(state.lockedDials, []);
  assert.deepEqual(state.cables, [
    "energy->stabilizer",
    "stabilizer->focus",
    "focus->frame",
  ]);
  assert.deepEqual(state.parts, {
    energy: "energy",
    stabilizer: "stabilizer",
    focus: "focus",
  });
});

test("理智遗物只跳过调频，不消耗也不改变装配进度", () => {
  const state = createWarehouseState({ hasSanityRelic: false });
  completeAssembly(state);
  assert.equal(adjustDial(state, "amplitude", 2), true);

  const progress = {
    parts: structuredClone(state.parts),
    cables: structuredClone(state.cables),
    dials: structuredClone(state.dials),
    lockedDials: structuredClone(state.lockedDials),
  };
  setSanityRelic(state, true);

  assert.equal(state.hasSanityRelic, true);
  assert.deepEqual(state.parts, progress.parts);
  assert.deepEqual(state.cables, progress.cables);
  assert.deepEqual(state.dials, progress.dials);
  assert.deepEqual(state.lockedDials, progress.lockedDials);
  assert.equal(canStartPortal(state), true);

  setSanityRelic(state, false);
  assert.equal(canStartPortal(state), false);
  assert.deepEqual(state.parts, progress.parts);
  assert.deepEqual(state.cables, progress.cables);
  assert.deepEqual(state.dials, progress.dials);
  assert.deepEqual(state.lockedDials, progress.lockedDials);
});
