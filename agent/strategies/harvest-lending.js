const { getOpenPositions, updatePosition } = require('../positions');

const FETCH_TIMEOUT_MS = 8000;

function fetchWithTimeout(url, options = {}) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), FETCH_TIMEOUT_MS))
  ]);
}

async function harvestLending({ connection, agentKeypair, log }) {
  const openPositions = getOpenPositions('lending');
  if (openPositions.length === 0) return { harvested: false, reason: 'NO_OPEN_POSITIONS' };

  let totalHarvestedSol = 0;

  for (const pos of openPositions) {
    try {
      // Use Kamino withdraw-interest action
      const harvestRes = await fetchWithTimeout('https://api.kamino.finance/v2/actions/collect-fees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: agentKeypair.publicKey.toString(),
          reserve: pos.reserve,
          market: pos.market,
        }),
      });

      if (!harvestRes.ok) {
        log('WARN', `Lending harvest: Kamino API returned ${harvestRes.status}`, {});
        continue;
      }

      const harvestData = await harvestRes.json();
      if (!harvestData.transaction) continue;

      const { VersionedTransaction } = require('@solana/web3.js');
      const txBuf = Buffer.from(harvestData.transaction, 'base64');
      const tx = VersionedTransaction.deserialize(txBuf);
      tx.sign([agentKeypair]);

      const txid = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
      await connection.confirmTransaction(txid, 'confirmed');

      const earned = harvestData.collectedAmount ? harvestData.collectedAmount / 1e9 : 0;
      totalHarvestedSol += earned;

      updatePosition('lending', pos.id, {
        lastHarvest: new Date().toISOString(),
        lastHarvestTxid: txid,
        totalHarvestedSol: (pos.totalHarvestedSol || 0) + earned,
      });

      log('INFO', `LENDING INTEREST COLLECTED: ${earned.toFixed(6)} SOL | txid ${txid}`, { txid, earned });

    } catch (err) {
      log('ERROR', `Lending harvest failed for position ${pos.id}: ${err.message}`, { error: err.message });
    }
  }

  return { harvested: totalHarvestedSol > 0, totalHarvestedSol };
}

module.exports = { harvestLending };
