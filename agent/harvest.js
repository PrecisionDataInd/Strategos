const { harvestLP } = require('./strategies/harvest-lp');
const { harvestLending } = require('./strategies/harvest-lending');
const { harvestStaking } = require('./strategies/harvest-staking');

const HARVEST_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
let harvestTimer = null;

async function runHarvest({ connection, agentKeypair, log, onComplete }) {
  log('INFO', 'HARVEST ENGINE: starting harvest cycle', {});

  let totalHarvestedSol = 0;
  const results = {};

  // LP fee collection
  try {
    const lpResult = await harvestLP({ connection, agentKeypair, log });
    results.lp = lpResult;
    if (lpResult.harvested) totalHarvestedSol += lpResult.totalHarvestedSol || 0;
  } catch (err) {
    log('ERROR', `Harvest LP failed: ${err.message}`, { error: err.message });
    results.lp = { harvested: false, error: err.message };
  }

  // Lending interest collection
  try {
    const lendResult = await harvestLending({ connection, agentKeypair, log });
    results.lending = lendResult;
    if (lendResult.harvested) totalHarvestedSol += lendResult.totalHarvestedSol || 0;
  } catch (err) {
    log('ERROR', `Harvest lending failed: ${err.message}`, { error: err.message });
    results.lending = { harvested: false, error: err.message };
  }

  // Staking reward tracking
  try {
    const stakingResult = await harvestStaking({ connection, agentKeypair, log });
    results.staking = stakingResult;
  } catch (err) {
    log('ERROR', `Harvest staking failed: ${err.message}`, { error: err.message });
    results.staking = { error: err.message };
  }

  if (totalHarvestedSol > 0) {
    log('SWEEP', `HARVEST COMPLETE: ${totalHarvestedSol.toFixed(6)} SOL collected across all strategies`, {
      totalHarvestedSol, results
    });
  } else {
    log('INFO', 'HARVEST CYCLE: no fees ready to collect', { results });
  }

  if (onComplete) onComplete({ totalHarvestedSol, results });
  return { totalHarvestedSol, results };
}

function startHarvestTimer({ connection, agentKeypair, log, onComplete }) {
  if (harvestTimer) clearInterval(harvestTimer);
  harvestTimer = setInterval(() => {
    runHarvest({ connection, agentKeypair, log, onComplete });
  }, HARVEST_INTERVAL_MS);
  log('INFO', 'HARVEST TIMER: started — runs every 6 hours', {});
}

function stopHarvestTimer() {
  if (harvestTimer) {
    clearInterval(harvestTimer);
    harvestTimer = null;
  }
}

module.exports = { runHarvest, startHarvestTimer, stopHarvestTimer };
