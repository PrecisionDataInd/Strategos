const { safeRequire } = require('./safe-require');

const { executeStaking }        = safeRequire('./staking',          'executeStaking');
const { executeLending }        = safeRequire('./lending',          'executeLending');
const { executeLiquidity }      = safeRequire('./liquidity',        'executeLiquidity');
const { executeArbitrage }      = safeRequire('./arbitrage',        'executeArbitrage');
const { executeGrid }           = safeRequire('./grid',             'executeGrid');
const { executeMEV }            = safeRequire('./mev',              'executeMEV');
const { executeSniper }         = safeRequire('./launch-sniper',    'executeSniper');
const { executeLeveragedYield } = safeRequire('./leveraged-yield',  'executeLeveragedYield');
const { runStopLossCheck }      = require('./stop-loss');
const { getPositions, getOpenPositions } = require('../positions');

// Full strategy registry — 8 strategies
const STRATEGIES = [
  { id: 'staking',   name: 'Liquid Staking',       risk: 'LOW',    fn: executeStaking,        minSol: 0.1,  priority: 1 },
  { id: 'lending',   name: 'Lending Desk',          risk: 'LOW',    fn: executeLending,        minSol: 0.1,  priority: 2 },
  { id: 'leveraged', name: 'Leveraged Yield',       risk: 'MEDIUM', fn: executeLeveragedYield, minSol: 0.3,  priority: 3 },
  { id: 'liquidity', name: 'Liquidity Provision',   risk: 'MEDIUM', fn: executeLiquidity,      minSol: 0.5,  priority: 4 },
  { id: 'arbitrage', name: 'Arbitrage',             risk: 'MEDIUM', fn: executeArbitrage,      minSol: 0.05, priority: 5 },
  { id: 'mev',       name: 'MEV Capture',           risk: 'HIGH',   fn: executeMEV,            minSol: 0.01, priority: 6 },
  { id: 'sniper',    name: 'Launch Sniper',         risk: 'HIGH',   fn: executeSniper,         minSol: 0.1,  priority: 7 },
  { id: 'grid',      name: 'Grid Trading',          risk: 'HIGH',   fn: executeGrid,           minSol: 0.3,  priority: 8 },
];

async function runStrategies({ connection, agentKeypair, config, store, log }) {
  const balance = await connection.getBalance(agentKeypair.publicKey) / 1e9;

  // AGGRESSIVE: deploy everything above reserve floor
  const deployable = balance - config.reserveFloor - 0.01;

  if (deployable <= 0) {
    log('WARN', `STRATEGIES: insufficient deployable balance (${balance.toFixed(4)} SOL)`, { balance });
    return [];
  }

  // Run stop-loss check first
  await runStopLossCheck({ connection, log });

  // Allocate per strategy — divide deployable equally among active strategies
  const amountPerStrategy = deployable / STRATEGIES.length;
  const results = [];

  for (const strategy of STRATEGIES) {
    if (amountPerStrategy < strategy.minSol) continue;

    try {
      const result = await strategy.fn({
        connection,
        agentKeypair,
        amountSol: amountPerStrategy,
        config,
        log,
      });

      // Attach position data to result
      const openPos = getOpenPositions(strategy.id);
      result.openPositions = openPos.length;

      // Apply display status
      if (!result._displayStatus) {
        if (result.success && result.tracked) {
          result._displayStatus = 'TRACKED';
        } else if (result.success) {
          result._displayStatus = 'ACTIVE';
        } else if (result.soft) {
          result._displayStatus = 'STANDBY';
        } else {
          result._displayStatus = 'ERROR';
        }
      }

      results.push({ id: strategy.id, name: strategy.name, ...result });

      // Safety rail: Re-fetch balance after each strategy
      const postBalance = await connection.getBalance(agentKeypair.publicKey) / 1e9;
      if (postBalance < config.lossFloorSol) {
        log('CRITICAL', `Balance dropped below loss floor after ${strategy.id} — HALTING`, { postBalance, lossFloor: config.lossFloorSol });
        break;
      }
    } catch (err) {
      log('ERROR', `Strategy ${strategy.id} threw: ${err.message}`, { strategy: strategy.id });
      results.push({ id: strategy.id, name: strategy.name, success: false, error: err.message, _displayStatus: 'ERROR' });
    }
  }

  return results;
}

module.exports = { runStrategies, STRATEGIES };
