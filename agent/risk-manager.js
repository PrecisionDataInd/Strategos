const Store = require('electron-store');
const store = new Store({ name: 'strategos-risk' });

const DRAWDOWN_HALT_PCT = 0.35; // 35% from session high triggers halt

function initSession(currentBalanceSol) {
  // Set session high on first call if not already set
  const existing = store.get('sessionHigh');
  if (!existing) {
    store.set('sessionHigh', currentBalanceSol);
    store.set('sessionStart', new Date().toISOString());
  }
}

function recordBalance(balanceSol) {
  const sessionHigh = store.get('sessionHigh', balanceSol);
  if (balanceSol > sessionHigh) {
    store.set('sessionHigh', balanceSol);
    return { sessionHigh: balanceSol };
  }
  return { sessionHigh };
}

function checkDrawdown(currentBalance, log) {
  const sessionHigh = store.get('sessionHigh', currentBalance);
  if (!sessionHigh || sessionHigh <= 0) return { shouldHalt: false, drawdownPct: 0 };

  const drawdownPct = (sessionHigh - currentBalance) / sessionHigh;

  if (drawdownPct >= DRAWDOWN_HALT_PCT) {
    log('CRITICAL',
      `RISK MANAGER: drawdown ${(drawdownPct * 100).toFixed(2)}% exceeds 35% limit — HALTING AGENT`,
      { drawdownPct, sessionHigh, currentBalance }
    );
    return { shouldHalt: true, drawdownPct, sessionHigh };
  }

  // Warn at 20% but do not halt
  if (drawdownPct >= 0.20) {
    log('WARN',
      `RISK MANAGER: drawdown ${(drawdownPct * 100).toFixed(2)}% — monitoring (halt triggers at 35%)`,
      { drawdownPct, sessionHigh }
    );
  }

  return { shouldHalt: false, drawdownPct, sessionHigh };
}

function getRiskStatus() {
  return {
    sessionHigh: store.get('sessionHigh', 0),
    sessionStart: store.get('sessionStart', null),
  };
}

function resetSession(currentBalance) {
  store.set('sessionHigh', currentBalance);
  store.set('sessionStart', new Date().toISOString());
}

module.exports = { initSession, recordBalance, checkDrawdown, getRiskStatus, resetSession };
