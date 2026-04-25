const Store = require('electron-store');
const store = new Store({ name: 'strategos-cooldowns' });

const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

function registerStopLoss(strategyId) {
  store.set(`cooldown:${strategyId}`, {
    triggeredAt: Date.now(),
    expiresAt: Date.now() + COOLDOWN_MS,
  });
}

function isInCooldown(strategyId) {
  const entry = store.get(`cooldown:${strategyId}`);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    store.delete(`cooldown:${strategyId}`);
    return false;
  }
  return true;
}

function getCooldownRemainingMs(strategyId) {
  const entry = store.get(`cooldown:${strategyId}`);
  if (!entry) return 0;
  return Math.max(0, entry.expiresAt - Date.now());
}

function clearCooldown(strategyId) {
  store.delete(`cooldown:${strategyId}`);
}

function clearAllCooldowns() {
  store.clear();
}

module.exports = {
  registerStopLoss,
  isInCooldown,
  getCooldownRemainingMs,
  clearCooldown,
  clearAllCooldowns,
};
