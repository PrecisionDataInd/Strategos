const { WhirlpoolContext, buildWhirlpoolClient, ORCA_WHIRLPOOL_PROGRAM_ID, PriceMath, TickUtil } = require('@orca-so/whirlpools-sdk');
const { AnchorProvider } = require('@coral-xyz/anchor');
const { PublicKey } = require('@solana/web3.js');
const { DecimalUtil, Percentage } = require('@orca-so/common-sdk');
const Decimal = require('decimal.js');
const { savePosition, getOpenPositions } = require('../positions');

// SOL/USDC Whirlpool on mainnet (0.05% fee tier)
const SOL_USDC_WHIRLPOOL = new PublicKey('HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ');

async function executeLiquidity({ connection, agentKeypair, amountSol, log }) {
  if (amountSol < 0.5) return { success: false, reason: 'AMOUNT_TOO_SMALL' };

  // Skip if already have an open LP position
  const openPositions = getOpenPositions('liquidity');
  if (openPositions.length > 0) {
    log('INFO', `LP: ${openPositions.length} position(s) already open — skipping new deposit`, { count: openPositions.length });
    return { success: true, reason: 'POSITION_EXISTS', positions: openPositions, strategy: 'orca-clmm' };
  }

  try {
    // Set up Anchor provider and Whirlpool client
    const wallet = {
      publicKey: agentKeypair.publicKey,
      signTransaction: async (tx) => { tx.sign([agentKeypair]); return tx; },
      signAllTransactions: async (txs) => { txs.forEach(tx => tx.sign([agentKeypair])); return txs; },
    };

    const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
    const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID);
    const client = buildWhirlpoolClient(ctx);

    // Fetch pool state
    const pool = await client.getPool(SOL_USDC_WHIRLPOOL);
    const poolData = pool.getData();
    const currentTick = poolData.tickCurrentIndex;
    const tickSpacing = poolData.tickSpacing;

    // Define position range: ±5% around current price (~69 ticks each side for 0.05% pool)
    const RANGE_TICKS = Math.floor(500 / tickSpacing) * tickSpacing;
    const lowerTick = TickUtil.getInitializableTickIndex(currentTick - RANGE_TICKS, tickSpacing);
    const upperTick = TickUtil.getInitializableTickIndex(currentTick + RANGE_TICKS, tickSpacing);

    const currentPrice = PriceMath.tickIndexToPrice(currentTick, 9, 6);
    log('INFO', `LP: opening position at $${currentPrice.toFixed(2)} | range $${PriceMath.tickIndexToPrice(lowerTick, 9, 6).toFixed(2)} - $${PriceMath.tickIndexToPrice(upperTick, 9, 6).toFixed(2)}`, {
      currentTick, lowerTick, upperTick
    });

    // Calculate token amounts
    const solAmount = new Decimal(amountSol / 2);
    const slippage = Percentage.fromFraction(1, 100); // 1% slippage

    // Open position transaction
    const { tx: openTx, positionMint } = await pool.openPositionWithMetadata(
      lowerTick,
      upperTick,
      { tokenA: DecimalUtil.fromNumber(solAmount.toNumber(), 9) },
      slippage,
      agentKeypair.publicKey
    );

    const openTxId = await openTx.buildAndExecute();
    await connection.confirmTransaction(openTxId, 'confirmed');

    const position = {
      positionMint: positionMint.toString(),
      lowerTick,
      upperTick,
      amountSol,
      openPrice: currentPrice.toFixed(4),
      txid: openTxId,
      status: 'OPEN',
    };

    savePosition('liquidity', position);

    log('INFO', `LP POSITION OPENED: ${amountSol.toFixed(4)} SOL | mint ${positionMint.toString().slice(0,8)}... | txid ${openTxId}`, {
      positionMint: positionMint.toString(), txid: openTxId
    });

    return {
      success: true,
      txid: openTxId,
      positionMint: positionMint.toString(),
      amountSol,
      strategy: 'orca-clmm',
      apy: '~10.9%',
    };

  } catch (err) {
    log('ERROR', `LP failed: ${err.message}`, { error: err.message });
    return { success: false, error: err.message };
  }
}

module.exports = { executeLiquidity };
