const Store = require('electron-store');
const store = new Store({ name: 'strategos-pnl-tracker' });

const ROLLING_WINDOW_HOURS = 24;
const MAX_LOSS_PER_STRATEGY_SOL = 0.1;

function recordStrategyResult(strategyId, pnlSol, feeSol = 0) {
  const history = store.get(`history:${strategyId}`, []) || [];
  history.push({
    timestamp: Date.now(),
    pnl: pnlSol,
    fee: feeSol,
    net: pnlSol - feeSol,
  });
  const cutoff = Date.now() - (48 * 60 * 60 * 1000);
  const trimmed = history.filter(e => e.timestamp > cutoff);
  store.set(`history:${strategyId}`, trimmed);
}

function getRollingPnL(strategyId) {
  const history = store.get(`history:${strategyId}`, []) || [];
  const cutoff = Date.now() - (ROLLING_WINDOW_HOURS * 60 * 60 * 1000);
  const window = history.filter(e => e.timestamp > cutoff);
  return window.reduce((sum, e) => sum + (e.net || 0), 0);
}

function shouldHaltStrategy(strategyId) {
  const rollingPnL = getRollingPnL(strategyId);
  return rollingPnL <= -MAX_LOSS_PER_STRATEGY_SOL;
}

function clearStrategyHistory(strategyId) {
  store.delete(`history:${strategyId}`);
}

function clearAllHistory() {
  store.clear();
}

module.exports = {
  recordStrategyResult,
  getRollingPnL,
  shouldHaltStrategy,
  clearStrategyHistory,
  clearAllHistory,
  MAX_LOSS_PER_STRATEGY_SOL,
};
