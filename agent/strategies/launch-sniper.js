const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { savePosition, getOpenPositions } = require('../positions');

const RAYDIUM_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const NEW_POOL_LOG_SIGNATURE = 'initialize2';
const MAX_SNIPE_POSITIONS = 3;
const MIN_POOL_SOL_RESERVE = 5; // Only snipe pools with at least 5 SOL in reserve
const FETCH_TIMEOUT_MS = 8000;

function fetchWithTimeout(url, options = {}) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), FETCH_TIMEOUT_MS)
    ),
  ]);
}

async function executeSniper({ connection, agentKeypair, amountSol, config, log }) {
  if (amountSol < 0.1) return { success: false, reason: 'AMOUNT_TOO_SMALL' };

  const existing = getOpenPositions('sniper');

  // Stop-loss check on existing positions
  for (const pos of existing) {
    if (pos.entryValueSol) {
      const drawdown = (pos.entryValueSol - (pos.currentValueSol || pos.amountSol)) / pos.entryValueSol;
      if (drawdown >= 0.05) {
        log('WARN', `SNIPER: position ${pos.poolAddress?.slice(0,8)}... down ${(drawdown*100).toFixed(2)}% — stop-loss exit`, {});
        const { closePosition } = require('../positions');
        closePosition('sniper', pos.id, { exitReason: 'STOP_LOSS' });
      }
    }
  }

  const activeSnipes = getOpenPositions('sniper');
  if (activeSnipes.length >= MAX_SNIPE_POSITIONS) {
    log('INFO', `SNIPER: max ${MAX_SNIPE_POSITIONS} positions active — monitoring`, { count: activeSnipes.length });
    return { success: true, reason: 'MAX_POSITIONS', _displayStatus: 'ACTIVE' };
  }

  try {
    // Scan recent Raydium transactions for new pool initializations
    const signatures = await connection.getSignaturesForAddress(
      RAYDIUM_PROGRAM_ID,
      { limit: 20 },
      'confirmed'
    );

    const recentSigs = signatures.map(s => s.signature);

    for (const sig of recentSigs.slice(0, 5)) {
      const tx = await connection.getTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!tx) continue;

      const logs = tx?.meta?.logMessages || [];
      const isNewPool = logs.some(l => l.includes('initialize') || l.includes('InitializePool'));

      if (!isNewPool) continue;

      // Extract pool address from transaction accounts
      const accounts = tx.transaction.message.staticAccountKeys || [];
      const poolAddress = accounts[1]?.toString();

      if (!poolAddress) continue;

      // Check if we already have this pool
      const alreadySniped = activeSnipes.some(p => p.poolAddress === poolAddress);
      if (alreadySniped) continue;

      // Verify pool has sufficient liquidity
      const poolBalance = await connection.getBalance(new PublicKey(poolAddress));
      const poolSol = poolBalance / LAMPORTS_PER_SOL;

      if (poolSol < MIN_POOL_SOL_RESERVE) {
        log('INFO', `SNIPER: pool ${poolAddress.slice(0,8)}... too small (${poolSol.toFixed(2)} SOL) — skipping`, {});
        continue;
      }

      // Deploy liquidity to new pool via Jupiter swap
      const snipeAmount = Math.min(amountSol * 0.25, 0.2); // Max 0.2 SOL per snipe
      const amountLamports = Math.floor(snipeAmount * LAMPORTS_PER_SOL);

      log('INFO', `SNIPER: new pool detected ${poolAddress.slice(0,8)}... (${poolSol.toFixed(2)} SOL) — deploying ${snipeAmount.toFixed(4)} SOL`, {
        poolAddress, poolSol, snipeAmount
      });

      // Use Jupiter to swap into the new token for LP seeding
      const quoteRes = await fetchWithTimeout(
        `https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${poolAddress}&amount=${amountLamports}&slippageBps=300&onlyDirectRoutes=true`
      );

      if (!quoteRes.ok) {
        log('WARN', `SNIPER: No Jupiter route to pool token — skipping`, {});
        continue;
      }

      const quote = await quoteRes.json();
      if (!quote || quote.error) continue;

      const swapRes = await fetchWithTimeout('https://lite-api.jup.ag/swap/v1/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: agentKeypair.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: { autoMultiplier: 3 }, // Higher priority for sniping
        }),
      });

      if (!swapRes.ok) continue;

      const swapData = await swapRes.json();
      const swapTx = swapData?.swapTransaction || swapData?.transaction || swapData?.tx;
      if (!swapTx) continue;

      const { VersionedTransaction } = require('@solana/web3.js');
      const txBuf = Buffer.from(swapTx, 'base64');
      const transaction = VersionedTransaction.deserialize(txBuf);
      transaction.sign([agentKeypair]);

      const txid = await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 3 });
      await connection.confirmTransaction(txid, 'confirmed');

      savePosition('sniper', {
        amountSol: snipeAmount,
        entryValueSol: snipeAmount,
        currentValueSol: snipeAmount,
        poolAddress,
        poolSolAtEntry: poolSol,
        txid,
        status: 'OPEN',
        apy: 'Variable — launch fees',
        openedAt: new Date().toISOString(),
      });

      log('INFO', `SNIPER DEPLOYED: ${snipeAmount.toFixed(4)} SOL → pool ${poolAddress.slice(0,8)}... | txid ${txid}`, { txid, poolAddress });
      return { success: true, txid, amountSol: snipeAmount, strategy: 'launch-sniper', _displayStatus: 'ACTIVE' };
    }

    log('INFO', 'SNIPER: no qualifying new pools detected this tick', {});
    return { success: false, reason: 'NO_OPPORTUNITIES', soft: true, _displayStatus: 'STANDBY' };

  } catch (err) {
    if (err.message.includes('ENOTFOUND') || err.message.includes('TIMEOUT')) {
      log('WARN', `SNIPER SKIPPED: network issue — ${err.message.split('\n')[0]}`, {});
      return { success: false, reason: 'NETWORK_ERROR', soft: true, _displayStatus: 'STANDBY' };
    }
    log('ERROR', `SNIPER failed: ${err.message}`, { error: err.message });
    return { success: false, error: err.message, _displayStatus: 'ERROR' };
  }
}

module.exports = { executeSniper };
