const { WhirlpoolContext, buildWhirlpoolClient, ORCA_WHIRLPOOL_PROGRAM_ID } = require('@orca-so/whirlpools-sdk');
const { AnchorProvider } = require('@coral-xyz/anchor');
const { PublicKey } = require('@solana/web3.js');
const { getOpenPositions, updatePosition } = require('../positions');

async function harvestLP({ connection, agentKeypair, log }) {
  const openPositions = getOpenPositions('liquidity');
  if (openPositions.length === 0) return { harvested: false, reason: 'NO_OPEN_POSITIONS' };

  const wallet = {
    publicKey: agentKeypair.publicKey,
    signTransaction: async (tx) => { tx.sign([agentKeypair]); return tx; },
    signAllTransactions: async (txs) => { txs.forEach(tx => tx.sign([agentKeypair])); return txs; },
  };

  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID);
  const client = buildWhirlpoolClient(ctx);

  let totalHarvestedSol = 0;
  const results = [];

  for (const pos of openPositions) {
    try {
      const positionPubkey = new PublicKey(pos.positionMint);
      const position = await client.getPosition(positionPubkey);
      const positionData = position.getData();

      // Check if there are fees to collect
      const feeOwedA = positionData.feeOwedA;
      const feeOwedB = positionData.feeOwedB;

      if (feeOwedA === BigInt(0) && feeOwedB === BigInt(0)) {
        log('INFO', `LP HARVEST: no fees accrued yet for position ${pos.positionMint.slice(0,8)}...`, {});
        continue;
      }

      // Collect fees
      const collectTx = await position.collectFees();
      const txid = await collectTx.buildAndExecute();
      await connection.confirmTransaction(txid, 'confirmed');

      const solFees = Number(feeOwedA) / 1e9;
      totalHarvestedSol += solFees;

      updatePosition('liquidity', pos.id, {
        lastHarvest: new Date().toISOString(),
        lastHarvestTxid: txid,
        totalHarvestedSol: (pos.totalHarvestedSol || 0) + solFees,
      });

      log('INFO', `LP FEES HARVESTED: ${solFees.toFixed(6)} SOL | txid ${txid}`, { txid, solFees });
      results.push({ positionId: pos.id, solFees, txid });

    } catch (err) {
      log('ERROR', `LP harvest failed for position ${pos.id}: ${err.message}`, { error: err.message });
    }
  }

  return { harvested: totalHarvestedSol > 0, totalHarvestedSol, results };
}

module.exports = { harvestLP };
