const { PublicKey, VersionedTransaction, Connection } = require('@solana/web3.js');
const fetch = require('cross-fetch');

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6/swap';

// Token mints
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function executeArbitrage({ connection, agentKeypair, amountSol, config, log }) {
  if (amountSol < 0.05) return { success: false, reason: 'AMOUNT_TOO_SMALL' };

  const amountLamports = Math.floor(amountSol * 1e9);

  try {
    // Step 1: Get SOL -> USDC quote
    const quoteResponse = await fetch(
      `${JUPITER_QUOTE_API}?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=${amountLamports}&slippageBps=${config.slippageBps}`
    );
    const quote = await quoteResponse.json();

    if (!quote || quote.error) {
      log('WARN', 'Jupiter quote failed or unavailable', { error: quote?.error });
      return { success: false, reason: 'QUOTE_FAILED' };
    }

    // Step 2: Check if profit opportunity exists
    const quotedUSDC = quote.outAmount / 1e6;
    const pricePerSol = quotedUSDC / amountSol;

    log('INFO', `ARB SCAN: ${amountSol.toFixed(4)} SOL \u2192 ${quotedUSDC.toFixed(2)} USDC @ $${pricePerSol.toFixed(2)}/SOL`, {
      amountSol,
      quotedUSDC,
      pricePerSol,
      priceImpactPct: quote.priceImpactPct
    });

    // Only execute if price impact is below threshold
    if (parseFloat(quote.priceImpactPct) > 0.1) {
      log('WARN', `ARB SKIPPED: price impact ${quote.priceImpactPct}% too high`, { priceImpact: quote.priceImpactPct });
      return { success: false, reason: 'PRICE_IMPACT_TOO_HIGH' };
    }

    // Step 3: Execute swap
    const swapResponse = await fetch(JUPITER_SWAP_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: agentKeypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    });
    const { swapTransaction } = await swapResponse.json();

    const swapTxBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTxBuf);
    transaction.sign([agentKeypair]);

    const txid = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(txid, 'confirmed');

    log('INFO', `ARB EXECUTED: ${amountSol.toFixed(4)} SOL \u2192 ${quotedUSDC.toFixed(2)} USDC | txid ${txid}`, { txid });
    return { success: true, txid, amountSol, outputUSDC: quotedUSDC, strategy: 'jupiter-arb' };

  } catch (err) {
    if (
      err.message === 'JUPITER_TIMEOUT' ||
      err.message.includes('ENOTFOUND') ||
      err.message.includes('ECONNREFUSED') ||
      err.message.includes('fetch failed')
    ) {
      log('WARN', `ARB SKIPPED: Jupiter unreachable — ${err.message}`, { reason: err.message });
      return { success: false, reason: 'API_UNREACHABLE', soft: true };
    }
    log('ERROR', `ARB TX FAILED: ${err.message}`, { error: err.message });
    return { success: false, error: err.message };
  }
}

module.exports = { executeArbitrage };
