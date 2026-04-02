const Store = require('electron-store');
const store = new Store({ name: 'strategos-positions' });

function savePosition(strategyId, position) {
  const positions = store.get('positions', {});
  if (!positions[strategyId]) positions[strategyId] = [];
  positions[strategyId].push({
    ...position,
    openedAt: new Date().toISOString(),
    id: `${strategyId}-${Date.now()}`,
  });
  store.set('positions', positions);
}

function getPositions(strategyId) {
  const positions = store.get('positions', {});
  return strategyId ? (positions[strategyId] || []) : positions;
}

function updatePosition(strategyId, positionId, updates) {
  const positions = store.get('positions', {});
  if (!positions[strategyId]) return;
  positions[strategyId] = positions[strategyId].map(p =>
    p.id === positionId ? { ...p, ...updates, updatedAt: new Date().toISOString() } : p
  );
  store.set('positions', positions);
}

function closePosition(strategyId, positionId, closeData) {
  const positions = store.get('positions', {});
  if (!positions[strategyId]) return;
  positions[strategyId] = positions[strategyId].map(p =>
    p.id === positionId ? { ...p, ...closeData, closedAt: new Date().toISOString(), status: 'CLOSED' } : p
  );
  store.set('positions', positions);
}

function getOpenPositions(strategyId) {
  return getPositions(strategyId).filter(p => p.status !== 'CLOSED');
}

module.exports = { savePosition, getPositions, updatePosition, closePosition, getOpenPositions };
