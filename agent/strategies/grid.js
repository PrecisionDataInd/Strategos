const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getOpenPositions, savePosition, closePosition } = require('../positions');

const FETCH_TIMEOUT_MS = 8000;

function fetchWithTimeout(url, options = {}) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('JUPITER_TIMEOUT')), FETCH_TIMEOUT_MS)
    ),
  ]);
}

const PRICE_SOURCES = [
  {
    name: 'CoinGecko',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
    extract: (data) => data?.solana?.usd,
  },
  {
    name: 'Binance',
    url: 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
    extract: (data) => parseFloat(data?.price),
  },
  {
    name: 'Coinbase',
    url: 'https://api.coinbase.com/v2/prices/SOL-USD/spot',
    extract: (data) => parseFloat(data?.data?.amount),
  },
];

async function fetchSolPrice(log) {
  for (const source of PRICE_SOURCES) {
    try {
      const res = await fetchWithTimeout(source.url);
      if (!res.ok) continue;

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        log('WARN', `GRID: ${source.name} returned non-JSON — trying next source`, {});
        continue;
      }

      const data = await res.json();
      const price = source.extract(data);

      if (price && price > 0) {
        return price;
      }
    } catch (err) {
      // Try next source
    }
  }
  return null;
}

async function executeGrid({ connection, agentKeypair, amountSol, config, log }) {
  if (amountSol < 0.3) return { success: false, reason: 'AMOUNT_TOO_SMALL', soft: true, _displayStatus: 'STANDBY' };

  const existing = getOpenPositions('grid');
  if (existing.length > 0) {
    log('INFO', `GRID: ${existing.length} order(s) active`, { count: existing.length });
    return {
      success: true,
      reason: 'POSITION_EXISTS',
      positions: existing,
      strategy: 'sol-usdc-grid',
      apy: 'Variable',
      amountSol: existing.reduce((s, p) => s + (p.amountSol || 0), 0),
      _displayStatus: 'ACTIVE',
    };
  }

  const currentPrice = await fetchSolPrice(log);

  if (!currentPrice) {
    log('WARN', 'GRID: all price sources failed — skipping this tick', {});
    return { success: false, reason: 'PRICE_UNAVAILABLE', soft: true, _displayStatus: 'STANDBY' };
  }

  const GRID_LEVELS = 5;
  const GRID_SPACING_PCT = 0.015;
  const SOL_PER_LEVEL = amountSol / (GRID_LEVELS * 2);

  const gridLevels = [];
  for (let i = 1; i <= GRID_LEVELS; i++) {
    gridLevels.push({
      type: 'BUY',
      price: parseFloat((currentPrice * (1 - GRID_SPACING_PCT * i)).toFixed(4)),
      amount: parseFloat(SOL_PER_LEVEL.toFixed(6)),
    });
    gridLevels.push({
      type: 'SELL',
      price: parseFloat((currentPrice * (1 + GRID_SPACING_PCT * i)).toFixed(4)),
      amount: parseFloat(SOL_PER_LEVEL.toFixed(6)),
    });
  }

  log('INFO', `GRID SET: ${gridLevels.length} levels @ $${currentPrice.toFixed(2)} | ${SOL_PER_LEVEL.toFixed(4)} SOL/level | ${(GRID_SPACING_PCT * 100).toFixed(1)}% spacing`, {
    currentPrice, levels: gridLevels.length, solPerLevel: SOL_PER_LEVEL,
  });

  // Save grid as position
  savePosition('grid', {
    amountSol,
    entryValueSol: amountSol,
    currentPrice,
    gridLevels,
    status: 'OPEN',
    apy: 'Variable — spread capture',
    openedAt: new Date().toISOString(),
  });

  return {
    success: true,
    strategy: 'sol-usdc-grid',
    currentPrice,
    gridLevels,
    amountSol,
    apy: 'Variable',
    _displayStatus: 'ACTIVE',
  };
}

module.exports = { executeGrid };
