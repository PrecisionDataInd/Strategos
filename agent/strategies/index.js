function safeRequire(path, fallbackFnName) {
  try {
    return require(path);
  } catch (e) {
    const fallback = {};
    fallback[fallbackFnName] = async ({ log }) => {
      log('WARN', `Strategy module ${path} failed to load: ${e.message}`, {});
      return { success: false, reason: 'MODULE_LOAD_FAILED' };
    };
    return fallback;
  }
}

const { executeStaking }   = safeRequire('./staking',   'executeStaking');
const { executeLending }   = safeRequire('./lending',    'executeLending');
const { executeLiquidity } = safeRequire('./liquidity',  'executeLiquidity');
const { executeArbitrage } = safeRequire('./arbitrage',  'executeArbitrage');
const { executeGrid }      = safeRequire('./grid',       'executeGrid');
const { getPositions, getOpenPositions } = require('../positions');

// Strategy registry with risk tiers
const STRATEGIES = [
  { id: 'staking',    name: 'Liquid Staking',      risk: 'LOW',    fn: executeStaking,    minSol: 0.1  },
  { id: 'lending',    name: 'Lending Desk',         risk: 'LOW',    fn: executeLending,    minSol: 0.1  },
  { id: 'liquidity',  name: 'Liquidity Provision',  risk: 'MEDIUM', fn: executeLiquidity,  minSol: 0.5  },
  { id: 'arbitrage',  name: 'Arbitrage',            risk: 'MEDIUM', fn: executeArbitrage,  minSol: 0.05 },
  { id: 'grid',       name: 'Grid Trading',         risk: 'HIGH',   fn: executeGrid,       minSol: 0.3  },
];

async function runStrategies({ connection, agentKeypair, config, store, log }) {
  const balance = await connection.getBalance(agentKeypair.publicKey) / 1e9;
  const deployable = balance - config.reserveFloor - 0.01; // extra gas buffer

  // Safety rail 1: Check agent balance >= lossFloorSol + reserveFloor + 0.05
  if (balance < config.lossFloorSol + config.reserveFloor + 0.05) {
    log('CRITICAL', 'Balance below safety floor for strategies', { balance, lossFloor: config.lossFloorSol, reserveFloor: config.reserveFloor });
    return [];
  }

  // Safety rail 2: Check deployable > 0
  if (deployable <= 0) {
    log('WARN', 'Insufficient deployable balance for strategies', { balance, reserveFloor: config.reserveFloor });
    return [];
  }

  const results = [];
  const maxPerStrategy = deployable * (config.maxPositionPct / 100);

  for (const strategy of STRATEGIES) {
    if (deployable < strategy.minSol) {
      results.push({ id: strategy.id, success: false, reason: 'AMOUNT_TOO_SMALL' });
      continue;
    }

    try {
      // Safety rail 4: Cap single transaction
      const amountSol = Math.min(maxPerStrategy, deployable * 0.2);

      const result = await strategy.fn({
        connection,
        agentKeypair,
        amountSol,
        config,
        log,
      });

      // Attach position data to result
      const openPos = getOpenPositions(strategy.id);
      result.openPositions = openPos.length;

      // Determine display status for the renderer badge
      if (!result.success && result.soft === true) {
        result._displayStatus = 'STANDBY';
      } else if (!result.success && result.reason === 'SDK_NOT_INSTALLED') {
        result._displayStatus = 'STANDBY';
      } else if (result.success && result.tracked) {
        result._displayStatus = 'TRACKED';
      } else if (result.success && result.reason === 'POSITION_EXISTS') {
        result._displayStatus = 'ACTIVE';
      } else if (!result.success && result.reason === 'AMOUNT_TOO_SMALL') {
        result._displayStatus = 'STANDBY';
      } else if (!result.success) {
        result._displayStatus = 'ERROR';
      } else {
        result._displayStatus = 'ACTIVE';
      }

      results.push({ id: strategy.id, ...result });

      // Safety rail 3: Re-fetch balance after each strategy
      const postBalance = await connection.getBalance(agentKeypair.publicKey) / 1e9;
      if (postBalance < config.lossFloorSol) {
        log('CRITICAL', `Balance dropped below loss floor after ${strategy.id} — HALTING`, { postBalance, lossFloor: config.lossFloorSol });
        break;
      }
    } catch (err) {
      log('ERROR', `Strategy ${strategy.id} failed: ${err.message}`, { strategy: strategy.id, error: err.message });
      results.push({ id: strategy.id, success: false, error: err.message });
    }
  }

  return results;
}

module.exports = { runStrategies, STRATEGIES };
