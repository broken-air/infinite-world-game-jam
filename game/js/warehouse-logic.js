const PART_IDS = ["energy", "stabilizer", "focus"];
const DIAL_TARGETS = Object.freeze({ amplitude: 2, frequency: 3, phase: 1 });
const VALID_CABLES = new Set([
  "energy->stabilizer",
  "stabilizer->focus",
  "focus->frame",
]);

export function createWarehouseState({ hasSanityRelic = false } = {}) {
  return {
    hasSanityRelic: Boolean(hasSanityRelic),
    parts: { energy: null, stabilizer: null, focus: null },
    cables: [],
    dials: { amplitude: 0, frequency: 0, phase: 0 },
    lockedDials: [],
    portalStarted: false,
  };
}

export function setSanityRelic(state, value) {
  state.hasSanityRelic = Boolean(value);
}

export function placePart(state, partId, slotId) {
  if (
    state.portalStarted ||
    !PART_IDS.includes(partId) ||
    !PART_IDS.includes(slotId) ||
    partId !== slotId ||
    state.parts[slotId] !== null ||
    Object.values(state.parts).includes(partId)
  ) {
    return false;
  }

  state.parts[slotId] = partId;
  return true;
}

export function connectCable(state, from, to) {
  const cable = `${from}->${to}`;
  if (state.portalStarted || !VALID_CABLES.has(cable) || state.cables.includes(cable)) {
    return false;
  }

  state.cables.push(cable);
  return true;
}

export function adjustDial(state, dialId, value) {
  if (
    state.portalStarted ||
    !Object.hasOwn(DIAL_TARGETS, dialId) ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 4 ||
    state.lockedDials.includes(dialId)
  ) {
    return false;
  }

  state.dials[dialId] = value;
  if (value === DIAL_TARGETS[dialId]) {
    state.lockedDials.push(dialId);
  }
  return true;
}

export function resetWiring(state) {
  if (state.portalStarted) {
    return false;
  }
  state.cables = [];
  return true;
}

export function resetDials(state) {
  if (state.portalStarted) {
    return false;
  }
  for (const dialId of Object.keys(DIAL_TARGETS)) {
    state.dials[dialId] = 0;
  }
  state.lockedDials = [];
  return true;
}

function assemblyComplete(state) {
  return (
    PART_IDS.every((partId) => state.parts[partId] === partId) &&
    [...VALID_CABLES].every((cable) => state.cables.includes(cable))
  );
}

function calibrationComplete(state) {
  return Object.entries(DIAL_TARGETS).every(
    ([dialId, target]) =>
      state.dials[dialId] === target && state.lockedDials.includes(dialId),
  );
}

export function canStartPortal(state) {
  return (
    !state.portalStarted &&
    assemblyComplete(state) &&
    (state.hasSanityRelic || calibrationComplete(state))
  );
}

export function startPortal(state) {
  if (!canStartPortal(state)) {
    return false;
  }
  state.portalStarted = true;
  return true;
}
