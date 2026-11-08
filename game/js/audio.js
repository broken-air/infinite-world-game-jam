const SOUNDS = new Map([
  ['ui.click', { type: 'blip', frequency: 420, duration: 0.04 }],
  ['store.scan', { type: 'blip', frequency: 880, duration: 0.08 }],
  ['store.coffee', { type: 'buzz', frequency: 240, duration: 0.16 }],
  ['store.receipt', { type: 'blip', frequency: 620, duration: 0.1 }],
  ['store.lock', { type: 'thud', frequency: 130, duration: 0.12 }],
  ['store.unlock', { type: 'blip', frequency: 520, duration: 0.14 }],
  ['warehouse.place', { type: 'thud', frequency: 180, duration: 0.09 }],
  ['warehouse.cable', { type: 'buzz', frequency: 330, duration: 0.12 }],
  ['warehouse.dial', { type: 'blip', frequency: 460, duration: 0.06 }],
  ['warehouse.portal', { type: 'swell', frequency: 55, duration: 1.6 }],
]);

/**
 * 创建无依赖的 Web Audio 管理器。
 * 解锁前 play()/startAmbience() 均安全无异常；环境音可随时停止。
 * @returns {import('./contracts.js').AudioManager}
 */
export function createAudioManager() {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  let context = null;
  let noiseBuffer = null;
  let ambienceNodes = null;
  let ambienceRequested = false;
  let destroyed = false;

  function ensureNoiseBuffer() {
    if (noiseBuffer) return noiseBuffer;
    const length = context.sampleRate * 2;
    noiseBuffer = context.createBuffer(1, length, context.sampleRate);
    const channel = noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      channel[i] = Math.random() * 2 - 1;
    }
    return noiseBuffer;
  }

  async function unlock() {
    if (destroyed || !AudioContextClass) return;
    if (!context) context = new AudioContextClass();
    if (context.state === 'suspended') await context.resume();
    if (ambienceRequested) startAmbience();
  }

  /** @param {import('./contracts.js').SoundId} id */
  function play(id) {
    if (destroyed || !context || context.state !== 'running') return;
    const sound = SOUNDS.get(id);
    if (!sound) return;

    const now = context.currentTime;
    const gain = context.createGain();
    gain.connect(context.destination);

    if (sound.type === 'swell') {
      // 传送门：低频上滑 + 轻微颤动，纯合成原创
      const osc = context.createOscillator();
      const lfo = context.createOscillator();
      const lfoGain = context.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(sound.frequency, now);
      osc.frequency.exponentialRampToValueAtTime(sound.frequency * 2.4, now + sound.duration);
      lfo.frequency.value = 6;
      lfoGain.gain.value = 6;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.09, now + sound.duration * 0.4);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + sound.duration);
      osc.connect(gain);
      osc.start(now);
      lfo.start(now);
      osc.stop(now + sound.duration);
      lfo.stop(now + sound.duration);
      osc.addEventListener('ended', () => {
        osc.disconnect();
        lfo.disconnect();
        lfoGain.disconnect();
        gain.disconnect();
      }, { once: true });
      return;
    }

    const osc = context.createOscillator();
    osc.frequency.setValueAtTime(sound.frequency, now);
    if (sound.type === 'thud') {
      osc.type = 'triangle';
      osc.frequency.exponentialRampToValueAtTime(sound.frequency * 0.6, now + sound.duration);
    } else if (sound.type === 'buzz') {
      osc.type = 'sawtooth';
    } else {
      osc.type = 'sine';
    }
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(sound.type === 'buzz' ? 0.04 : 0.055, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + sound.duration);
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + sound.duration);
    osc.addEventListener('ended', () => {
      osc.disconnect();
      gain.disconnect();
    }, { once: true });
  }

  function startAmbience() {
    ambienceRequested = true;
    if (destroyed || !context || context.state !== 'running' || ambienceNodes) return;

    // 分层环境底音：城市风声（滤波噪声）+ 冰箱低鸣 + 远处车流，全部本地合成
    const ambienceGain = context.createGain();
    ambienceGain.gain.value = 1;
    ambienceGain.connect(context.destination);

    // 风声：带通滤波噪声，缓慢起伏
    const wind = context.createBufferSource();
    wind.buffer = ensureNoiseBuffer();
    wind.loop = true;
    const windFilter = context.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 320;
    windFilter.Q.value = 0.6;
    const windGain = context.createGain();
    windGain.gain.value = 0.012;
    const swell = context.createOscillator();
    const swellGain = context.createGain();
    swell.frequency.value = 0.08;
    swellGain.gain.value = 0.006;
    swell.connect(swellGain);
    swellGain.connect(windGain.gain);
    wind.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(ambienceGain);
    wind.start();
    swell.start();

    // 冰箱低鸣：稳定低频正弦
    const fridge = context.createOscillator();
    fridge.type = 'sine';
    fridge.frequency.value = 55;
    const fridgeGain = context.createGain();
    fridgeGain.gain.value = 0.008;
    fridge.connect(fridgeGain);
    fridgeGain.connect(ambienceGain);
    fridge.start();

    // 远处车流：低通噪声，偶发起伏
    const traffic = context.createBufferSource();
    traffic.buffer = ensureNoiseBuffer();
    traffic.loop = true;
    const trafficFilter = context.createBiquadFilter();
    trafficFilter.type = 'lowpass';
    trafficFilter.frequency.value = 160;
    const trafficGain = context.createGain();
    trafficGain.gain.value = 0.01;
    traffic.connect(trafficFilter);
    trafficFilter.connect(trafficGain);
    trafficGain.connect(ambienceGain);
    traffic.start();

    ambienceNodes = { ambienceGain, sources: [wind, swell, fridge, traffic], gains: [windGain, fridgeGain, trafficGain] };
  }

  function stopAmbience() {
    ambienceRequested = false;
    if (!ambienceNodes) return;
    for (const source of ambienceNodes.sources) {
      try {
        source.stop();
      } catch {
        // 已停止的源忽略
      }
    }
    for (const gain of ambienceNodes.gains) {
      gain.disconnect();
    }
    ambienceNodes.ambienceGain.disconnect();
    ambienceNodes = null;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopAmbience();
    if (context && context.state !== 'closed') {
      void context.close().catch(() => {});
    }
    context = null;
    noiseBuffer = null;
  }

  return { unlock, play, startAmbience, stopAmbience, destroy };
}
