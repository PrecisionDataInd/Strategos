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

const { markDeploymentAttempted } = require('../deployment-pacer');
const { isInCooldown, getCooldownRemainingMs } = require('../cooldown-tracker');
const { canSpendFees, getBudgetStatus } = require('../fee-budget');
const { shouldHaltStrategy, getRollingPnL } = require('../profitability-guard');

// Tiering: tier1 = capital-preserving, tier2 = active strategies, tier3 = high-risk
const STRATEGIES = [
  { id: 'staking',   name: 'Liquid Staking',       risk: 'LOW',    fn: executeStaking,        minSol: 0.1,  priority: 1, tier: 'tier1' },
  { id: 'lending',   name: 'Lending Desk',          risk: 'LOW',    fn: executeLending,        minSol: 0.1,  priority: 2, tier: 'tier1' },
  { id: 'leveraged', name: 'Leveraged Yield',       risk: 'MEDIUM', fn: executeLeveragedYield, minSol: 0.3,  priority: 3, tier: 'tier2' },
  { id: 'liquidity', name: 'Liquidity Provision',   risk: 'MEDIUM', fn: executeLiquidity,      minSol: 0.5,  priority: 4, tier: 'tier2' },
  { id: 'arbitrage', name: 'Arbitrage',             risk: 'MEDIUM', fn: executeArbitrage,      minSol: 0.05, priority: 5, tier: 'tier2' },
  { id: 'mev',       name: 'MEV Capture',           risk: 'HIGH',   fn: executeMEV,            minSol: 0.01, priority: 6, tier: 'tier3' },
  { id: 'sniper',    name: 'Launch Sniper',         risk: 'HIGH',   fn: executeSniper,         minSol: 0.1,  priority: 7, tier: 'tier3' },
  { id: 'grid',      name: 'Grid Trading',          risk: 'HIGH',   fn: executeGrid,           minSol: 0.3,  priority: 8, tier: 'tier2' },
];

async function runStrategies({ connection, agentKeypair, config, store, log, haltedTiers }) {
  const balance = await connection.getBalance(agentKeypair.publicKey) / 1e9;
  const deployable = balance - (config.reserveFloor || 0.25) - 0.01;

  if (deployable <= 0) {
    log('WARN', `STRATEGIES: insufficient deployable balance (${balance.toFixed(4)} SOL)`, { balance });
    return STRATEGIES.map(s => ({
      id: s.id,
      name: s.name,
      tier: s.tier,
      success: false,
      reason: 'INSUFFICIENT_BALANCE',
      soft: true,
      _displayStatus: 'STANDBY',
    }));
  }

  // Stop-loss sweep before any deployment decisions
  try {
    await runStopLossCheck({ connection, log });
  } catch (err) {
    log('WARN', `Stop-loss check failed: ${err.message}`, {});
  }

  const existingPositions = {};
  for (const strategy of STRATEGIES) {
    existingPositions[strategy.id] = getOpenPositions(strategy.id);
  }

  const feeBudget = getBudgetStatus();
  if (feeBudget.dailyExceeded || feeBudget.weeklyExceeded) {
    log('WARN',
      `FEE BUDGET EXCEEDED: daily ${feeBudget.dailySpent.toFixed(4)}/${feeBudget.dailyBudget} | weekly ${feeBudget.weeklySpent.toFixed(4)}/${feeBudget.weeklyBudget} — position checks only`,
      feeBudget
    );
  }

  // Track which strategies have soft-failed this tick — they're skipped
  // for deployment but the pacer advances to the next eligible strategy
  const softFailedThisTick = new Set();

  function findNextDeploymentSlot(positions, softFailed) {
    const { DEPLOYMENT_ORDER } = require('../deployment-pacer');
    for (const strategyId of DEPLOYMENT_ORDER) {
      if (softFailed.has(strategyId)) continue;
      const strategyPositions = positions[strategyId] || [];
      if (strategyPositions.length === 0) {
        return strategyId;
      }
    }
    return null;
  }

  let nextToDeployId = findNextDeploymentSlot(existingPositions, softFailedThisTick);

  if (nextToDeployId) {
    log('INFO',
      `PACING: next deployment slot → ${nextToDeployId} (other strategies check positions only)`,
      { nextToDeployId }
    );
  } else {
    log('INFO',
      `PACING: all strategies have positions — position checks only this tick`,
      {}
    );
  }

  const perStrategyAllocation = deployable / STRATEGIES.length;
  const results = [];

  for (const strategy of STRATEGIES) {
    // Tier halt check
    if (haltedTiers && haltedTiers.includes(strategy.tier || 'tier2')) {
      results.push({
        id: strategy.id, name: strategy.name, tier: strategy.tier,
        success: false, reason: 'TIER_HALTED', soft: true,
        _displayStatus: 'STANDBY',
      });
      continue;
    }

    // Cooldown check
    if (isInCooldown(strategy.id)) {
      const remainingMin = Math.ceil(getCooldownRemainingMs(strategy.id) / 60000);
      results.push({
        id: strategy.id, name: strategy.name, tier: strategy.tier,
        success: false, reason: 'COOLDOWN',
        cooldownMinutesRemaining: remainingMin,
        soft: true, _displayStatus: 'STANDBY',
      });
      continue;
    }

    // Profitability guard
    if (shouldHaltStrategy(strategy.id)) {
      const loss = getRollingPnL(strategy.id);
      log('WARN',
        `PROFITABILITY GUARD: ${strategy.id} losing ${loss.toFixed(4)} SOL over 24h — auto-halted`,
        { strategy: strategy.id, loss }
      );
      results.push({
        id: strategy.id, name: strategy.name, tier: strategy.tier,
        success: false, reason: 'PROFITABILITY_HALT',
        rollingPnL: loss, soft: true, _displayStatus: 'STANDBY',
      });
      continue;
    }

    const hasExistingPosition = existingPositions[strategy.id].length > 0;
    const isPacingSlot = strategy.id === nextToDeployId;
    const budgetExceeded = feeBudget.dailyExceeded || feeBudget.weeklyExceeded;
    const canDeploy = isPacingSlot && !budgetExceeded && !hasExistingPosition;

    // If strategy has no position and is not the pacing slot, defer
    if (!hasExistingPosition && !canDeploy) {
      results.push({
        id: strategy.id, name: strategy.name, tier: strategy.tier,
        success: false, reason: 'WAITING_FOR_PACING_SLOT',
        soft: true, _displayStatus: 'STANDBY',
      });
      continue;
    }

    const targetAmount = canDeploy ? (perStrategyAllocation || 0.5) : 0;

    try {
      const result = await strategy.fn({
        connection,
        agentKeypair,
        amountSol: targetAmount,
        config,
        log,
      });

      // If this was a deployment attempt and it soft-failed, advance the
      // pacer to the next strategy and let it attempt deployment THIS tick
      if (canDeploy && result.success === false && result.soft === true) {
        softFailedThisTick.add(strategy.id);
        log('INFO',
          `PACING: ${strategy.id} soft-failed (${result.reason}) — advancing to next slot`,
          { strategy: strategy.id, reason: result.reason }
        );

        nextToDeployId = findNextDeploymentSlot(existingPositions, softFailedThisTick);
        if (nextToDeployId) {
          log('INFO',
            `PACING: advanced to → ${nextToDeployId}`,
            { nextToDeployId }
          );
        }
      }

      if (canDeploy && result.success) {
        markDeploymentAttempted(strategy.id);
      }

      results.push({
        id: strategy.id, name: strategy.name, tier: strategy.tier,
        ...result,
      });
    } catch (err) {
      log('ERROR', `Strategy ${strategy.id} threw: ${err.message}`, { error: err.message });
      softFailedThisTick.add(strategy.id);
      results.push({
        id: strategy.id, name: strategy.name, tier: strategy.tier,
        success: false, error: err.message,
        soft: true, _displayStatus: 'ERROR',
      });
    }
  }

  return results;
}

module.exports = { runStrategies, STRATEGIES };
