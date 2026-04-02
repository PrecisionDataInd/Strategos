const { VersionedTransaction } = require('@solana/web3.js');
const { savePosition } = require('../positions');

const JUPITER_QUOTE_API = 'https://lite-api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_API  = 'https://lite-api.jup.ag/swap/v1/swap';
const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FETCH_TIMEOUT_MS = 8000;

function fetchWithTimeout(url, options = {}) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('JUPITER_TIMEOUT')), FETCH_TIMEOUT_MS)
    ),
  ]);
}

async function executeArbitrage({ connection, agentKeypair, amountSol, config, log }) {
  if (amountSol < 0.05) return { success: false, reason: 'AMOUNT_TOO_SMALL' };

  const amountLamports = Math.floor(amountSol * 1e9);

  // Step 1: Get quote
  let quote;
  try {
    const quoteRes = await fetchWithTimeout(
      `${JUPITER_QUOTE_API}?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=${amountLamports}&slippageBps=${config.slippageBps}&onlyDirectRoutes=false&asLegacyTransaction=false`
    );
    if (!quoteRes.ok) {
      log('WARN', `ARB SKIPPED: Quote API returned ${quoteRes.status}`, {});
      return { success: false, reason: 'QUOTE_HTTP_ERROR', soft: true };
    }
    quote = await quoteRes.json();
  } catch (err) {
    if (err.message.includes('ENOTFOUND') || err.message.includes('TIMEOUT') || err.message.includes('fetch failed')) {
      log('WARN', `ARB SKIPPED: Jupiter unreachable — ${err.message.split('\n')[0]}`, {});
      return { success: false, reason: 'API_UNREACHABLE', soft: true, _displayStatus: 'STANDBY' };
    }
    log('ERROR', `ARB quote error: ${err.message}`, { error: err.message });
    return { success: false, error: err.message };
  }

  if (!quote || quote.error || quote.errorCode) {
    log('WARN', `ARB SKIPPED: Quote error — ${quote?.error || quote?.errorCode || 'unknown'}`, {});
    return { success: false, reason: 'QUOTE_ERROR', soft: true, _displayStatus: 'STANDBY' };
  }

  // Step 2: Evaluate opportunity
  const outAmount = parseInt(quote.outAmount || 0);
  const quotedUSDC = outAmount / 1e6;
  const pricePerSol = quotedUSDC / amountSol;
  const priceImpact = parseFloat(quote.priceImpactPct || '0');

  log('INFO', `ARB SCAN: ${amountSol.toFixed(4)} SOL → ${quotedUSDC.toFixed(2)} USDC @ $${pricePerSol.toFixed(2)}/SOL | impact ${priceImpact.toFixed(4)}%`, {
    amountSol, quotedUSDC, pricePerSol, priceImpact
  });

  if (priceImpact > 0.5) {
    log('WARN', `ARB SKIPPED: price impact ${priceImpact.toFixed(3)}% too high`, { priceImpact });
    return { success: false, reason: 'PRICE_IMPACT_TOO_HIGH', soft: true, _displayStatus: 'STANDBY' };
  }

  // Step 3: Build swap transaction
  let swapData;
  try {
    const swapRes = await fetchWithTimeout(JUPITER_SWAP_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: agentKeypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { autoMultiplier: 2 },
      }),
    });

    if (!swapRes.ok) {
      const errText = await swapRes.text().catch(() => '');
      log('WARN', `ARB SKIPPED: Swap API returned ${swapRes.status} — ${errText.slice(0, 100)}`, {});
      return { success: false, reason: 'SWAP_HTTP_ERROR', soft: true, _displayStatus: 'STANDBY' };
    }

    swapData = await swapRes.json();
  } catch (err) {
    log('WARN', `ARB SKIPPED: Swap request failed — ${err.message}`, {});
    return { success: false, reason: 'SWAP_REQUEST_FAILED', soft: true, _displayStatus: 'STANDBY' };
  }

  // Handle multiple possible field names in Jupiter v1 response
  const swapTransaction =
    swapData?.swapTransaction ||
    swapData?.transaction ||
    swapData?.tx ||
    swapData?.serializedTransaction;

  if (!swapTransaction) {
    log('WARN', `ARB SKIPPED: No transaction in swap response. Fields: ${Object.keys(swapData || {}).join(', ')}`, {});
    return { success: false, reason: 'NO_SWAP_TRANSACTION', soft: true, _displayStatus: 'STANDBY' };
  }

  // Step 4: Execute
  try {
    const swapTxBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTxBuf);
    transaction.sign([agentKeypair]);

    const txid = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(txid, 'confirmed');

    log('INFO', `ARB EXECUTED: ${amountSol.toFixed(4)} SOL → ${quotedUSDC.toFixed(2)} USDC | txid ${txid}`, { txid });

    savePosition('arbitrage', {
      amountSol,
      entryValueSol: amountSol,
      outputUSDC: quotedUSDC,
      txid,
      status: 'CLOSED', // Arb is instant — open and close same tick
      apy: 'Variable',
      openedAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
    });

    return { success: true, txid, amountSol, outputUSDC: quotedUSDC, strategy: 'jupiter-arb', apy: 'Variable', _displayStatus: 'ACTIVE' };

  } catch (err) {
    log('ERROR', `ARB TX FAILED: ${err.message}`, { error: err.message });
    return { success: false, error: err.message, _displayStatus: 'ERROR' };
  }
}

module.exports = { executeArbitrage };
