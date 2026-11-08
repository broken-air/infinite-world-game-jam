import {
  adjustDial,
  canStartPortal,
  connectCable,
  createWarehouseState,
  placePart,
  resetDials,
  resetWiring,
  setSanityRelic,
  startPortal,
} from './warehouse-logic.js';

const PARTS = [
  { id: 'energy', label: '能源接口' },
  { id: 'stabilizer', label: '稳定器' },
  { id: 'focus', label: '聚焦环' },
];

const DIALS = [
  { id: 'amplitude', label: '振幅', target: 2 },
  { id: 'frequency', label: '频率', target: 3 },
  { id: 'phase', label: '相位', target: 1 },
];

const DIAL_MAX = 4;

// 接线板固定坐标（百分比），与图纸上的能量方向一致：frame → energy → stabilizer → focus
const NODE_POS = {
  frame: { x: 10, y: 52 },
  energy: { x: 36, y: 30 },
  stabilizer: { x: 62, y: 52 },
  focus: { x: 88, y: 30 },
};

const CABLE_ROUTE = [
  ['energy', 'stabilizer'],
  ['stabilizer', 'focus'],
  ['focus', 'frame'],
];

// 仓库样式由模块自行注入，保持 index.html 所有权归 A
let stylesheetInjected = false;

function ensureStylesheet() {
  if (stylesheetInjected) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../css/warehouse.css', import.meta.url).href;
  document.head.append(link);
  stylesheetInjected = true;
}

function waveformPoints(amplitude, frequency, phase, width, height) {
  const points = [];
  for (let step = 0; step <= 32; step += 1) {
    const x = (step / 32) * width;
    const y = height / 2 - Math.sin((step / 32) * frequency * Math.PI * 2 + phase) * amplitude * (height / 5);
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return points.join(' ');
}

/**
 * 挂载仓库场景：只依赖冻结接口与仓库纯逻辑，不读取背包和官方交接 API。
 * @param {HTMLElement} container
 * @param {import('./contracts.js').WarehouseSceneApi} api
 * @returns {import('./contracts.js').WarehouseSceneHandle}
 */
export function mountWarehouseScene(container, api) {
  ensureStylesheet();

  const state = createWarehouseState({ hasSanityRelic: api.hasSanityRelic });
  let completed = false;
  let selectedPart = null;
  let pendingNode = null;

  const root = document.createElement('section');
  root.className = 'scene scene--warehouse';
  root.dataset.scene = 'warehouse';
  root.innerHTML = `
    <div class="warehouse-layout">
      <div class="warehouse-board" aria-label="传送门装配台">
        <div class="assembly-area">
          <h3 class="area-title">组件安装</h3>
          <div class="part-tray"></div>
          <div class="slot-row"></div>
        </div>
        <div class="wiring-area">
          <h3 class="area-title">导管连接</h3>
          <div class="wiring-board">
            <svg class="cable-svg" viewBox="0 0 100 80" preserveAspectRatio="none" aria-hidden="true"></svg>
          </div>
          <div class="wiring-actions">
            <button class="scene-action" type="button" data-testid="reset-wiring" data-action="reset-wiring">重置导管</button>
            <button class="scene-action" type="button" data-testid="reset-dials" data-action="reset-dials">重置旋钮</button>
          </div>
        </div>
        <div class="calibration-area">
          <h3 class="area-title">波形校准</h3>
          <div class="dial-panel" data-testid="dial-panel"></div>
        </div>
        <div class="portal-area">
          <div class="portal" data-testid="portal" data-state="closed" aria-hidden="true">
            <svg viewBox="0 0 120 120">
              <circle class="portal-ring portal-ring--outer" cx="60" cy="60" r="52"></circle>
              <circle class="portal-ring portal-ring--mid" cx="60" cy="60" r="38"></circle>
              <circle class="portal-ring portal-ring--inner" cx="60" cy="60" r="24"></circle>
              <circle class="portal-core" cx="60" cy="60" r="12"></circle>
            </svg>
          </div>
          <button class="scene-action portal-start" type="button" data-testid="start-portal" data-action="start-portal">启动传送门</button>
        </div>
      </div>
      <p class="scene-feedback" data-testid="warehouse-feedback" role="status">按图纸安装组件、连接导管，再对照背面的目标波形校准旋钮。</p>
    </div>`;

  const feedback = root.querySelector('[data-testid="warehouse-feedback"]');
  const partTray = root.querySelector('.part-tray');
  const slotRow = root.querySelector('.slot-row');
  const wiringBoard = root.querySelector('.wiring-board');
  const cableSvg = root.querySelector('.cable-svg');
  const dialPanel = root.querySelector('[data-testid="dial-panel"]');
  const portal = root.querySelector('[data-testid="portal"]');
  const startButton = root.querySelector('[data-testid="start-portal"]');

  function setFeedback(message) {
    feedback.textContent = message;
  }

  function renderParts() {
    partTray.replaceChildren();
    for (const part of PARTS) {
      const installed = state.parts[part.id] !== null;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'part-chip';
      button.dataset.testid = `part-${part.id}`;
      button.dataset.partId = part.id;
      button.dataset.action = 'select-part';
      button.dataset.installed = String(installed);
      button.setAttribute('aria-pressed', String(selectedPart === part.id));
      button.textContent = part.label;
      if (installed) button.disabled = true;
      button.addEventListener('click', onSelectPart);
      partTray.append(button);
    }
  }

  function renderSlots() {
    slotRow.replaceChildren();
    for (const part of PARTS) {
      const slot = document.createElement('button');
      slot.type = 'button';
      slot.className = 'part-slot';
      slot.dataset.testid = `slot-${part.id}`;
      slot.dataset.slotId = part.id;
      slot.dataset.action = 'install-part';
      slot.dataset.filled = String(state.parts[part.id] !== null);
      slot.textContent = state.parts[part.id] !== null ? PARTS.find((p) => p.id === part.id).label : '轮廓';
      slot.addEventListener('click', () => onInstallPart(part.id));
      slotRow.append(slot);
    }
  }

  function renderCables() {
    cableSvg.replaceChildren();
    for (const cable of state.cables) {
      const [from, to] = cable.split('->');
      const fromPos = NODE_POS[from];
      const toPos = NODE_POS[to];
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String((fromPos.x / 100) * 100));
      line.setAttribute('y1', String((fromPos.y / 80) * 80));
      line.setAttribute('x2', String((toPos.x / 100) * 100));
      line.setAttribute('y2', String((toPos.y / 80) * 80));
      line.setAttribute('class', 'cable-line');
      line.dataset.cableId = cable;
      cableSvg.append(line);
    }

    // 节点按钮固定坐标摆放
    for (const existing of wiringBoard.querySelectorAll('[data-testid^="node-"]')) {
      existing.remove();
    }
    for (const [nodeId, pos] of Object.entries(NODE_POS)) {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'wiring-node';
      node.dataset.testid = `node-${nodeId}`;
      node.dataset.nodeId = nodeId;
      node.dataset.action = 'connect-node';
      node.style.left = `${pos.x}%`;
      node.style.top = `${(pos.y / 80) * 100}%`;
      node.setAttribute('aria-pressed', String(pendingNode === nodeId));
      node.textContent = nodeId === 'frame' ? '门框' : PARTS.find((p) => p.id === nodeId)?.label ?? nodeId;
      node.addEventListener('click', () => onNodeClick(nodeId));
      wiringBoard.append(node);
    }
  }

  function renderDials() {
    dialPanel.replaceChildren();
    if (state.hasSanityRelic) {
      // 遗物路线：手动校准面板整体隐藏，不出现任何旋钮或可插入遗物的位置
      dialPanel.hidden = true;
      return;
    }
    dialPanel.hidden = false;
    for (const dial of DIALS) {
      const locked = state.lockedDials.includes(dial.id);
      const wrap = document.createElement('div');
      wrap.className = 'dial';
      wrap.dataset.testid = `dial-${dial.id}`;
      wrap.dataset.value = String(state.dials[dial.id]);
      wrap.dataset.locked = String(locked);

      const label = document.createElement('span');
      label.className = 'dial-label';
      label.textContent = dial.label;

      const value = document.createElement('strong');
      value.className = 'dial-value';
      value.textContent = String(state.dials[dial.id]);

      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'dial-up';
      up.dataset.testid = `dial-${dial.id}-up`;
      up.dataset.action = 'raise-dial';
      up.dataset.dialId = dial.id;
      up.textContent = '＋';
      up.addEventListener('click', () => onRaiseDial(dial.id));

      const wave = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      wave.setAttribute('class', 'dial-wave');
      wave.setAttribute('viewBox', '0 0 100 40');
      wave.setAttribute('preserveAspectRatio', 'none');
      const targetLine = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      targetLine.setAttribute('class', 'wave-target');
      targetLine.setAttribute('points', waveformPoints(dial.target, dial.id === 'frequency' ? dial.target : 1, dial.id === 'phase' ? dial.target : 0, 100, 40));
      const currentLine = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      currentLine.setAttribute('class', 'wave-current');
      currentLine.setAttribute('points', waveformPoints(state.dials[dial.id], dial.id === 'frequency' ? state.dials[dial.id] : 1, dial.id === 'phase' ? state.dials[dial.id] : 0, 100, 40));
      wave.append(targetLine, currentLine);

      wrap.append(label, value, up, wave);
      dialPanel.append(wrap);
    }
  }

  function renderStart() {
    // 已启动后按钮保持可点击但点击无效，由结束锁保证只交接一次
    startButton.disabled = !completed && !canStartPortal(state);
  }

  function renderAll() {
    renderParts();
    renderSlots();
    renderCables();
    renderDials();
    renderStart();
  }

  function onSelectPart(event) {
    const partId = event.currentTarget.dataset.partId;
    if (state.parts[partId] !== null) return;
    selectedPart = selectedPart === partId ? null : partId;
    api.playSound('ui.click');
    for (const button of partTray.querySelectorAll('[data-action="select-part"]')) {
      button.setAttribute('aria-pressed', String(button.dataset.partId === selectedPart));
    }
    setFeedback(selectedPart ? `已选中 ${PARTS.find((p) => p.id === selectedPart).label}，点击对应轮廓安装。` : '已取消选中。');
  }

  function onInstallPart(slotId) {
    if (!selectedPart) {
      setFeedback('先点击上方组件，再点击轮廓安装（支持点击替代拖放）。');
      return;
    }
    const accepted = placePart(state, selectedPart, slotId);
    if (accepted) {
      api.playSound('warehouse.place');
      api.registerInteraction();
      setFeedback(`${PARTS.find((p) => p.id === selectedPart).label} 已安装到位。`);
      selectedPart = null;
    } else {
      api.playSound('ui.click');
      setFeedback('组件与轮廓不匹配，弹回了原位，已有进度不受影响。');
    }
    renderParts();
    renderSlots();
    renderStart();
  }

  function onNodeClick(nodeId) {
    if (!pendingNode) {
      pendingNode = nodeId;
      api.playSound('ui.click');
      renderCables();
      setFeedback(`已选中 ${nodeId} 接口，再点击下一个接口连接导管。`);
      return;
    }
    const from = pendingNode;
    pendingNode = null;
    const accepted = connectCable(state, from, nodeId);
    if (accepted) {
      api.playSound('warehouse.cable');
      api.registerInteraction();
      setFeedback(`导管已接通：${from} → ${nodeId}。`);
    } else if (state.cables.includes(`${from}->${nodeId}`)) {
      setFeedback('这条导管已经接好，无需重复连接。');
    } else {
      setFeedback(`导管方向不对：图纸要求沿 能源 → 稳定器 → 聚焦环 → 门框 方向连接（${from} → ${nodeId} 不成立）。`);
    }
    renderCables();
    renderStart();
  }

  function onRaiseDial(dialId) {
    const nextValue = state.dials[dialId] + 1;
    if (nextValue > DIAL_MAX) {
      setFeedback('旋钮已到最大档位。');
      return;
    }
    const accepted = adjustDial(state, dialId, nextValue);
    if (!accepted) {
      setFeedback('这一项已经校准锁定，无法再调整。');
      return;
    }
    api.playSound('warehouse.dial');
    api.registerInteraction();
    const locked = state.lockedDials.includes(dialId);
    setFeedback(locked ? `${DIALS.find((d) => d.id === dialId).label} 对准目标波形，指示灯亮起。` : '波形已更新，继续对照图纸调整。');
    renderDials();
    renderStart();
  }

  function onResetWiring() {
    if (!resetWiring(state)) return;
    api.playSound('ui.click');
    api.registerInteraction();
    pendingNode = null;
    renderCables();
    renderStart();
    setFeedback('导管已全部拆下，组件与旋钮进度保持不变。');
  }

  function onResetDials() {
    if (!resetDials(state)) return;
    api.playSound('ui.click');
    api.registerInteraction();
    renderDials();
    renderStart();
    setFeedback('旋钮已全部归零，装配与导管进度保持不变。');
  }

  function onStartPortal() {
    // 结束锁：portalStarted 后连续点击不再重复提交
    if (completed || !canStartPortal(state)) return;
    if (!startPortal(state)) return;
    completed = true;
    portal.dataset.state = 'open';
    api.playSound('warehouse.portal');
    api.registerInteraction();
    setFeedback('传送门稳定展开了。冷光漫过货架——夜班结束的钟声响起。');
    api.completeLevel();
  }

  startButton.addEventListener('click', onStartPortal);
  root.querySelector('[data-testid="reset-wiring"]').addEventListener('click', onResetWiring);
  root.querySelector('[data-testid="reset-dials"]').addEventListener('click', onResetDials);

  renderAll();
  container.append(root);

  return {
    destroy() {
      startButton.removeEventListener('click', onStartPortal);
      root.remove();
    },
    updateContext(context) {
      // 只更新校准资格与面板可见性，保留组件、导管和已锁定旋钮进度，不重挂场景
      setSanityRelic(state, context.hasSanityRelic);
      pendingNode = null;
      renderDials();
      renderStart();
      setFeedback(state.hasSanityRelic ? '理智恢复：你直接看懂了重叠的波形，校准已自动完成。' : '遗物效果已移除，需要手动完成校准。');
    },
  };
}
