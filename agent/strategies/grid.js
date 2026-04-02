const fetch = require('cross-fetch');

async function executeGrid({ connection, agentKeypair, amountSol, config, log }) {
  if (amountSol < 0.3) return { success: false, reason: 'AMOUNT_TOO_SMALL' };

  // Grid trading strategy:
  // 1. Fetch current SOL price
  // 2. Define grid: N levels above and below current price
  // 3. Place sell orders above, buy orders below
  // 4. On fill: place opposite order, capture the spread

  // Grid parameters
  const GRID_LEVELS = 5;
  const GRID_SPACING_PCT = 0.015; // 1.5% between levels
  const SOL_PER_LEVEL = amountSol / (GRID_LEVELS * 2);

  try {
    // Get current price via Jupiter price API
    const priceRes = await fetch('https://price.jup.ag/v6/price?ids=SOL');
    const priceData = await priceRes.json();
    const currentPrice = priceData?.data?.SOL?.price;

    if (!currentPrice) {
      log('WARN', 'Grid: could not fetch SOL price', {});
      return { success: false, reason: 'PRICE_FETCH_FAILED' };
    }

    // Calculate grid levels
    const gridLevels = [];
    for (let i = 1; i <= GRID_LEVELS; i++) {
      gridLevels.push({
        type: 'BUY',
        price: currentPrice * (1 - GRID_SPACING_PCT * i),
        amount: SOL_PER_LEVEL,
      });
      gridLevels.push({
        type: 'SELL',
        price: currentPrice * (1 + GRID_SPACING_PCT * i),
        amount: SOL_PER_LEVEL,
      });
    }

    log('INFO', `GRID SET: ${GRID_LEVELS * 2} levels around $${currentPrice.toFixed(2)} | ${SOL_PER_LEVEL.toFixed(4)} SOL/level`, {
      currentPrice,
      levels: gridLevels.length,
      spacing: `${(GRID_SPACING_PCT * 100).toFixed(1)}%`
    });

    // PHASE 2: Grid levels are tracked in electron-store
    // PHASE 3: Integrate with Jupiter Limit Orders API for actual on-chain grid orders
    return {
      success: true,
      strategy: 'sol-usdc-grid',
      currentPrice,
      gridLevels,
      amountSol,
      apy: 'Variable',
      note: 'Grid tracked \u2014 limit order integration in Phase 3'
    };

  } catch (err) {
    log('ERROR', `Grid trading failed: ${err.message}`, { error: err.message });
    return { success: false, error: err.message };
  }
}

module.exports = { executeGrid };
