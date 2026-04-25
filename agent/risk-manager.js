const Store = require('electron-store');
const { PublicKey } = require('@solana/web3.js');
const store = new Store({ name: 'strategos-risk' });

const DRAWDOWN_HALT_PCT = 0.35; // legacy single-tier limit (kept for compatibility)
const TIER2_3_HALT_PCT = 0.15;
const FULL_HALT_PCT = 0.25;
const GRACE_PERIOD_TICKS = 3;
const DAILY_RESET_HOUR = 0; // UTC midnight

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const MSOL_MINT = new PublicKey('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So');
const FETCH_TIMEOUT_MS = 6000;

function fetchWithTimeout(url) {
  return Promise.race([
    fetch(url),
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), FETCH_TIMEOUT_MS))
  ]);
}

async function getTotalPortfolioValueSol(connection, agentPublicKey, solBalanceSol) {
  let totalSol = solBalanceSol;
  let usdcSol = 0;
  let msolSol = 0;
  let solPrice = null;

  try {
    const priceRes = await fetchWithTimeout(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
    );
    if (priceRes.ok) {
      const priceData = await priceRes.json();
      solPrice = priceData?.solana?.usd;
    }
  } catch (_) {}

  try {
    const { getAssociatedTokenAddress } = require('@solana/spl-token');

    if (solPrice) {
      try {
        const usdcATA = await getAssociatedTokenAddress(USDC_MINT, agentPublicKey);
        const usdcBalance = await connection.getTokenAccountBalance(usdcATA);
        const usdcAmount = parseFloat(usdcBalance.value.uiAmount || 0);
        usdcSol = usdcAmount / solPrice;
        totalSol += usdcSol;
      } catch (_) {}
    }

    try {
      const msolATA = await getAssociatedTokenAddress(MSOL_MINT, agentPublicKey);
      const msolBalance = await connection.getTokenAccountBalance(msolATA);
      msolSol = parseFloat(msolBalance.value.uiAmount || 0);
      totalSol += msolSol;
    } catch (_) {}

  } catch (_) {}

  return { totalSol, solOnly: solBalanceSol, usdcSol, msolSol, solPrice };
}

function initSession(currentBalanceSol) {
  const existing = store.get('sessionHigh');
  if (!existing) {
    store.set('sessionHigh', currentBalanceSol);
    store.set('sessionStart', new Date().toISOString());
  }
}

function recordBalance(totalPortfolioSol) {
  const history = store.get('balanceHistory', []);
  history.push({ balance: totalPortfolioSol, timestamp: Date.now() });
  if (history.length > 200) history.shift();
  store.set('balanceHistory', history);

  const sessionHigh = store.get('sessionHigh', totalPortfolioSol);
  if (totalPortfolioSol > sessionHigh) {
    store.set('sessionHigh', totalPortfolioSol);
    return { sessionHigh: totalPortfolioSol };
  }
  return { sessionHigh };
}

function isInGracePeriod() {
  const tickCount = store.get('tickCount', 0) || 0;
  return tickCount < GRACE_PERIOD_TICKS;
}

function incrementTickCount() {
  const count = (store.get('tickCount', 0) || 0) + 1;
  store.set('tickCount', count);
  return count;
}

function getTickCount() {
  return store.get('tickCount', 0) || 0;
}

function shouldDailyReset() {
  const lastReset = store.get('lastDailyReset', 0) || 0;
  const now = new Date();
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), DAILY_RESET_HOUR)
  ).getTime();
  return lastReset < today && now.getTime() >= today;
}

function performDailyReset(currentPortfolioSol, log) {
  store.set('sessionHigh', currentPortfolioSol);
  store.set('lastDailyReset', Date.now());
  store.set('tickCount', 0);
  log('INFO',
    `DAILY RESET: new session baseline ${currentPortfolioSol.toFixed(4)} SOL`,
    {}
  );
}

function checkDrawdown(totalPortfolioSol, log, breakdown) {
  incrementTickCount();

  if (isInGracePeriod()) {
    log('INFO',
      `GRACE PERIOD: tick ${getTickCount()}/${GRACE_PERIOD_TICKS} — halt checks deferred`,
      {}
    );
    return {
      haltedTiers: [],
      drawdownPct: 0,
      fullHalt: false,
      inGracePeriod: true,
    };
  }

  const sessionHigh = store.get('sessionHigh', totalPortfolioSol);
  if (!sessionHigh || sessionHigh <= 0) {
    return { haltedTiers: [], drawdownPct: 0, fullHalt: false };
  }

  const drawdownPct = (sessionHigh - totalPortfolioSol) / sessionHigh;

  if (breakdown) {
    log('INFO', `PORTFOLIO VALUE: ${totalPortfolioSol.toFixed(4)} SOL total | ${breakdown.solOnly.toFixed(4)} SOL + ${breakdown.usdcSol.toFixed(4)} USDC-equiv + ${breakdown.msolSol.toFixed(4)} mSOL`, {
      total: totalPortfolioSol,
      sol: breakdown.solOnly,
      usdc: breakdown.usdcSol,
      msol: breakdown.msolSol,
    });
  }

  if (drawdownPct >= FULL_HALT_PCT) {
    log('CRITICAL',
      `FULL HALT: portfolio drawdown ${(drawdownPct * 100).toFixed(2)}% exceeds ${(FULL_HALT_PCT * 100).toFixed(0)}% — ALL STRATEGIES STOPPED`,
      { drawdownPct, sessionHigh, totalPortfolioSol }
    );
    return {
      haltedTiers: ['tier1', 'tier2', 'tier3'],
      drawdownPct,
      fullHalt: true,
      sessionHigh,
      totalPortfolioSol,
    };
  }

  if (drawdownPct >= TIER2_3_HALT_PCT) {
    log('WARN',
      `TIER HALT: drawdown ${(drawdownPct * 100).toFixed(2)}% exceeds ${(TIER2_3_HALT_PCT * 100).toFixed(0)}% — Tier 2 and Tier 3 halted, Tier 1 continues`,
      { drawdownPct, sessionHigh }
    );
    return {
      haltedTiers: ['tier2', 'tier3'],
      drawdownPct,
      fullHalt: false,
      sessionHigh,
      totalPortfolioSol,
    };
  }

  if (drawdownPct >= 0.10) {
    log('WARN',
      `RISK: drawdown ${(drawdownPct * 100).toFixed(2)}% — monitoring (tier halt at ${(TIER2_3_HALT_PCT * 100).toFixed(0)}%)`,
      { drawdownPct }
    );
  }

  return {
    haltedTiers: [],
    drawdownPct,
    fullHalt: false,
    sessionHigh,
    totalPortfolioSol,
  };
}

function getRiskStatus() {
  return {
    sessionHigh: store.get('sessionHigh', 0),
    sessionStart: store.get('sessionStart', null),
    tickCount: store.get('tickCount', 0),
  };
}

function resetSession(currentBalance) {
  store.set('sessionHigh', currentBalance);
  store.set('sessionStart', new Date().toISOString());
  store.set('tickCount', 0);
}

module.exports = {
  initSession,
  recordBalance,
  checkDrawdown,
  getRiskStatus,
  resetSession,
  getTotalPortfolioValueSol,
  isInGracePeriod,
  incrementTickCount,
  getTickCount,
  shouldDailyReset,
  performDailyReset,
};
