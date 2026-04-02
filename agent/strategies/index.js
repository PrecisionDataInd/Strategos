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
  const deployable = balance - (config.reserveFloor || 0.25) - 0.01;

  if (deployable <= 0) {
    log('WARN', `STRATEGIES: insufficient deployable balance (${balance.toFixed(4)} SOL)`, { balance });
    // Still return position status even if nothing to deploy
    return STRATEGIES.map(s => ({
      id: s.id,
      name: s.name,
      success: false,
      reason: 'INSUFFICIENT_BALANCE',
      soft: true,
      _displayStatus: 'STANDBY',
    }));
  }

  // Run stop-loss check first on all existing positions
  try {
    const { runStopLossCheck } = require('./stop-loss');
    await runStopLossCheck({ connection, log });
  } catch (err) {
    log('WARN', `Stop-loss check failed: ${err.message}`, {});
  }

  // Divide deployable equally among all strategies
  const amountPerStrategy = deployable / STRATEGIES.length;
  const results = [];

  for (const strategy of STRATEGIES) {
    // Always run the strategy fn — it handles its own position-exists check internally
    // Even if amount is below minimum, the fn will return POSITION_EXISTS if one is open
    const effectiveAmount = Math.max(amountPerStrategy, strategy.minSol);

    try {
      const result = await strategy.fn({
        connection,
        agentKeypair,
        amountSol: effectiveAmount,
        config,
        log,
      });

      // Determine display status
      if (!result._displayStatus) {
        if (result.success && result.reason === 'POSITION_EXISTS') {
          result._displayStatus = 'ACTIVE';
        } else if (result.success && result.exited) {
          result._displayStatus = 'STANDBY';
        } else if (result.success) {
          result._displayStatus = 'ACTIVE';
        } else if (result.soft) {
          result._displayStatus = 'STANDBY';
        } else if (result.reason === 'SDK_NOT_INSTALLED') {
          result._displayStatus = 'STANDBY';
        } else if (result.reason === 'MODULE_LOAD_FAILED') {
          result._displayStatus = 'STANDBY';
        } else {
          result._displayStatus = 'ERROR';
        }
      }

      results.push({ id: strategy.id, name: strategy.name, ...result });

    } catch (err) {
      log('ERROR', `Strategy ${strategy.id} threw: ${err.message}`, { strategy: strategy.id });
      results.push({
        id: strategy.id,
        name: strategy.name,
        success: false,
        error: err.message,
        soft: true,
        _displayStatus: 'STANDBY',
      });
    }
  }

  return results;
}

module.exports = { runStrategies, STRATEGIES };
