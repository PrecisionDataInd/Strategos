const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getOpenPositions, savePosition, closePosition } = require('../positions');

const JUPITER_LIMIT_API = 'https://jup.ag/api/limit/v1';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUPITER_PRICE_API = 'https://lite-api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112';
const FETCH_TIMEOUT_MS = 8000;

function fetchWithTimeout(url, options = {}) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('JUPITER_TIMEOUT')), FETCH_TIMEOUT_MS)
    ),
  ]);
}

async function executeGrid({ connection, agentKeypair, amountSol, config, log }) {
  if (amountSol < 0.3) return { success: false, reason: 'AMOUNT_TOO_SMALL' };

  // Check existing grid orders
  const existingOrders = getOpenPositions('grid');
  if (existingOrders.length >= 10) {
    log('INFO', `GRID: ${existingOrders.length} orders already active — skipping new grid`, { count: existingOrders.length });
    return { success: true, reason: 'GRID_ACTIVE', positions: existingOrders, strategy: 'sol-usdc-grid' };
  }

  // Fetch current SOL price
  let currentPrice;
  try {
    const priceRes = await fetchWithTimeout(JUPITER_PRICE_API);
    const priceData = await priceRes.json();
    currentPrice = priceData?.data?.['So11111111111111111111111111111111111111112']?.price;
  } catch (err) {
    if (
      err.message === 'JUPITER_TIMEOUT' ||
      err.message.includes('ENOTFOUND') ||
      err.message.includes('ECONNREFUSED') ||
      err.message.includes('fetch failed') ||
      err.message.includes('network')
    ) {
      log('WARN', `GRID SKIPPED: Jupiter unreachable — ${err.message.split('\n')[0]}`, {});
      return { success: false, reason: 'API_UNREACHABLE', soft: true, _displayStatus: 'STANDBY' };
    }
    log('WARN', `GRID SKIPPED: Price fetch failed — ${err.message}`, { reason: err.message });
    return { success: false, reason: 'PRICE_FETCH_FAILED' };
  }

  if (!currentPrice) return { success: false, reason: 'PRICE_UNAVAILABLE' };

  const GRID_LEVELS = 5;
  const GRID_SPACING_PCT = 0.015;
  const SOL_PER_LEVEL = amountSol / (GRID_LEVELS * 2);

  log('INFO', `GRID: placing ${GRID_LEVELS * 2} limit orders around $${currentPrice.toFixed(2)}`, {
    currentPrice, levels: GRID_LEVELS * 2, solPerLevel: SOL_PER_LEVEL
  });

  const placedOrders = [];

  for (let i = 1; i <= GRID_LEVELS; i++) {
    // BUY order below current price
    const buyPrice = currentPrice * (1 - GRID_SPACING_PCT * i);
    const buyAmountLamports = Math.floor(SOL_PER_LEVEL * LAMPORTS_PER_SOL);

    try {
      // Place BUY order via Jupiter Limit Orders API
      const buyRes = await fetchWithTimeout(`${JUPITER_LIMIT_API}/createOrder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner: agentKeypair.publicKey.toString(),
          inputMint: USDC_MINT,
          outputMint: SOL_MINT,
          inAmount: Math.floor(SOL_PER_LEVEL * buyPrice * 1e6).toString(),
          outAmount: buyAmountLamports.toString(),
          expiredAt: null,
        }),
      });
      const buyOrder = await buyRes.json();

      if (buyOrder.order) {
        // Sign and send the order transaction
        const orderTxBuf = Buffer.from(buyOrder.tx, 'base64');
        const { VersionedTransaction } = require('@solana/web3.js');
        const orderTx = VersionedTransaction.deserialize(orderTxBuf);
        orderTx.sign([agentKeypair]);
        const txid = await connection.sendRawTransaction(orderTx.serialize(), { maxRetries: 3 });
        await connection.confirmTransaction(txid, 'confirmed');

        const orderRecord = {
          type: 'BUY',
          orderId: buyOrder.order,
          price: buyPrice,
          amountSol: SOL_PER_LEVEL,
          level: i,
          txid,
          status: 'OPEN',
        };
        savePosition('grid', orderRecord);
        placedOrders.push(orderRecord);
        log('INFO', `GRID BUY ORDER: level ${i} @ $${buyPrice.toFixed(2)} | ${SOL_PER_LEVEL.toFixed(4)} SOL | txid ${txid}`, { level: i, price: buyPrice });
      }

    } catch (err) {
      if (
        err.message === 'JUPITER_TIMEOUT' ||
        err.message.includes('ENOTFOUND') ||
        err.message.includes('ECONNREFUSED') ||
        err.message.includes('fetch failed') ||
        err.message.includes('network')
      ) {
        log('WARN', `GRID SKIPPED: Jupiter unreachable — ${err.message.split('\n')[0]}`, {});
        return { success: false, reason: 'API_UNREACHABLE', soft: true, _displayStatus: 'STANDBY' };
      }
      log('ERROR', `GRID: order placement failed at level ${i}: ${err.message}`, { level: i, error: err.message });
    }

    // Small delay between orders to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  return {
    success: placedOrders.length > 0,
    strategy: 'sol-usdc-grid',
    currentPrice,
    placedOrders,
    amountSol,
    apy: 'Variable — spread capture',
  };
}

module.exports = { executeGrid };
