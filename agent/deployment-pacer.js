const Store = require('electron-store');
const store = new Store({ name: 'strategos-pacing' });

const DEPLOYMENT_ORDER = [
  'staking',
  'lending',
  'kamino',
  'liquidity',
  'leveraged',
  'arbitrage',
  'grid',
  'sniper',
  'mev',
];

function getNextStrategyToDeploy(existingPositions) {
  for (const strategyId of DEPLOYMENT_ORDER) {
    const positions = existingPositions[strategyId] || [];
    if (positions.length === 0) return strategyId;
  }
  return null;
}

function markDeploymentAttempted(strategyId) {
  const tick = (store.get('currentTick', 0) || 0) + 1;
  store.set('currentTick', tick);
  store.set(`lastAttempt:${strategyId}`, {
    tick,
    timestamp: Date.now(),
  });
}

function getCurrentTick() {
  return store.get('currentTick', 0) || 0;
}

function resetPacing() {
  store.clear();
}

module.exports = {
  getNextStrategyToDeploy,
  markDeploymentAttempted,
  getCurrentTick,
  resetPacing,
  DEPLOYMENT_ORDER,
};
