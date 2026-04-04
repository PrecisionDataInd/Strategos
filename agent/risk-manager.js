const Store = require('electron-store');
const { PublicKey } = require('@solana/web3.js');
const store = new Store({ name: 'strategos-risk' });

const DRAWDOWN_HALT_PCT = 0.35; // 35% from session high triggers halt

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
    // Get SOL price for USDC conversion
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

    // Get USDC balance
    if (solPrice) {
      try {
        const usdcATA = await getAssociatedTokenAddress(USDC_MINT, agentPublicKey);
        const usdcBalance = await connection.getTokenAccountBalance(usdcATA);
        const usdcAmount = parseFloat(usdcBalance.value.uiAmount || 0);
        usdcSol = usdcAmount / solPrice; // Convert USDC to SOL equivalent
        totalSol += usdcSol;
      } catch (_) {}
    }

    // Get mSOL balance (roughly 1:1 with SOL)
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
  // Set session high on first call if not already set
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

function checkDrawdown(totalPortfolioSol, log, breakdown) {
  const sessionHigh = store.get('sessionHigh', totalPortfolioSol);
  if (!sessionHigh || sessionHigh <= 0) return { shouldHalt: false, drawdownPct: 0 };

  const drawdownPct = (sessionHigh - totalPortfolioSol) / sessionHigh;

  // Log breakdown for transparency
  if (breakdown) {
    log('INFO', `PORTFOLIO VALUE: ${totalPortfolioSol.toFixed(4)} SOL total | ${breakdown.solOnly.toFixed(4)} SOL + ${breakdown.usdcSol.toFixed(4)} USDC-equiv + ${breakdown.msolSol.toFixed(4)} mSOL`, {
      total: totalPortfolioSol,
      sol: breakdown.solOnly,
      usdc: breakdown.usdcSol,
      msol: breakdown.msolSol,
    });
  }

  if (drawdownPct >= DRAWDOWN_HALT_PCT) {
    log('CRITICAL',
      `RISK MANAGER: portfolio drawdown ${(drawdownPct * 100).toFixed(2)}% exceeds ${(DRAWDOWN_HALT_PCT * 100).toFixed(0)}% limit — HALTING AGENT`,
      { drawdownPct, sessionHigh, totalPortfolioSol }
    );
    return { shouldHalt: true, drawdownPct, sessionHigh, totalPortfolioSol };
  }

  if (drawdownPct >= 0.20) {
    log('WARN',
      `RISK MANAGER: portfolio drawdown ${(drawdownPct * 100).toFixed(2)}% — monitoring (halt triggers at ${(DRAWDOWN_HALT_PCT * 100).toFixed(0)}%)`,
      { drawdownPct, sessionHigh, totalPortfolioSol }
    );
  }

  return { shouldHalt: false, drawdownPct, sessionHigh, totalPortfolioSol };
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

module.exports = { initSession, recordBalance, checkDrawdown, getRiskStatus, resetSession, getTotalPortfolioValueSol };
