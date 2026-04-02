let Raydium, TxVersion;
let raydiumAvailable = false;

try {
  const raydiumSdk = require('@raydium-io/raydium-sdk-v2');
  Raydium = raydiumSdk.Raydium;
  TxVersion = raydiumSdk.TxVersion;
  raydiumAvailable = true;
  console.log('[STRATEGOS] Raydium SDK loaded successfully');
} catch (e) {
  console.warn('[STRATEGOS] Raydium SDK not available:', e.message);
}

const { savePosition, getOpenPositions } = require('../positions');
const { PublicKey } = require('@solana/web3.js');

// Raydium SOL/USDC CLMM pool (mainnet)
const SOL_USDC_POOL = new PublicKey('2QdhepnKRTLjjSqPL1PtKNwqrUkoLee5Gqs8bvZhRdAv');

async function executeLiquidity({ connection, agentKeypair, amountSol, log }) {
  if (amountSol < 0.5) return { success: false, reason: 'AMOUNT_TOO_SMALL' };

  const existing = getOpenPositions('liquidity');
  if (existing.length > 0) {
    // Stop-loss check
    const pos = existing[0];
    if (pos.entryValueSol) {
      const drawdown = (pos.entryValueSol - (pos.currentValueSol || pos.amountSol)) / pos.entryValueSol;
      if (drawdown >= 0.05) {
        log('WARN', `LP: position down ${(drawdown*100).toFixed(2)}% — stop-loss exit`, { drawdown });
        const { closePosition } = require('../positions');
        closePosition('liquidity', pos.id, { exitReason: 'STOP_LOSS' });
        return { success: true, exited: true, reason: 'STOP_LOSS' };
      }
    }
    log('INFO', `LP: ${existing.length} Raydium position(s) active`, { count: existing.length });
    return { success: true, reason: 'POSITION_EXISTS', strategy: 'raydium-clmm', apy: '~12%', _displayStatus: 'ACTIVE' };
  }

  if (!raydiumAvailable) {
    log('WARN', 'LP SKIPPED: Raydium SDK not installed', {});
    return { success: false, reason: 'SDK_NOT_INSTALLED', soft: true, _displayStatus: 'STANDBY' };
  }

  try {
    log('INFO', `LP: opening Raydium CLMM position with ${amountSol.toFixed(4)} SOL`, { amount: amountSol });

    const raydium = await Raydium.load({
      connection,
      owner: agentKeypair,
      disableLoadToken: false,
    });

    // Fetch pool info
    const poolInfo = await raydium.clmm.getPoolInfoFromRpc(SOL_USDC_POOL.toString());
    const currentPrice = poolInfo.currentPrice;

    // Define ±5% range
    const lowerPrice = currentPrice * 0.95;
    const upperPrice = currentPrice * 1.05;

    log('INFO', `LP: opening position @ $${currentPrice.toFixed(2)} | range $${lowerPrice.toFixed(2)}-$${upperPrice.toFixed(2)}`, {
      currentPrice, lowerPrice, upperPrice
    });

    const { execute } = await raydium.clmm.openPositionFromBase({
      poolInfo,
      ownerInfo: { useSOLBalance: true },
      tickLower: raydium.clmm.getPriceToTick(poolInfo, lowerPrice, true),
      tickUpper: raydium.clmm.getPriceToTick(poolInfo, upperPrice, false),
      base: 'MintA',
      baseAmount: BigInt(Math.floor(amountSol / 2 * 1e9)),
      otherAmountMax: BigInt(Math.floor(amountSol / 2 * poolInfo.currentPrice * 1e6)),
      txVersion: TxVersion.V0,
    });

    const { txids } = await execute({ sendAndConfirm: true });
    const txid = txids[0];

    savePosition('liquidity', {
      amountSol,
      entryValueSol: amountSol,
      currentValueSol: amountSol,
      protocol: 'raydium-clmm',
      poolAddress: SOL_USDC_POOL.toString(),
      entryPrice: currentPrice,
      lowerPrice,
      upperPrice,
      txid,
      status: 'OPEN',
      apy: '~12%',
      openedAt: new Date().toISOString(),
    });

    log('INFO', `LP POSITION OPENED: ${amountSol.toFixed(4)} SOL | Raydium CLMM | txid ${txid}`, { txid });
    return { success: true, txid, amountSol, strategy: 'raydium-clmm', apy: '~12%', _displayStatus: 'ACTIVE' };

  } catch (err) {
    log('ERROR', `LP failed: ${err.message}`, { error: err.message });
    return { success: false, error: err.message, _displayStatus: 'ERROR' };
  }
}

module.exports = { executeLiquidity };
