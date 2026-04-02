const { STRATEGIES } = require('./strategies/index');

// Maps NOVA action strategy names to the existing strategy registry
function getStrategyByName(strategyName) {
  return STRATEGIES.find(s => s.id === strategyName) || null;
}

async function executeNovaAction({ action, connection, agentKeypair, config, log }) {
  const strategy = getStrategyByName(action.strategy);
  if (!strategy) {
    log('ERROR', `NOVA EXECUTOR: unknown strategy "${action.strategy}" for ${action.codename}`);
    return { success: false, error: 'UNKNOWN_STRATEGY', actionId: action.id };
  }

  // Calculate amount from deployable balance
  const balance = await connection.getBalance(agentKeypair.publicKey) / 1e9;
  const deployable = balance - config.reserveFloor - 0.01;

  if (deployable <= 0) {
    log('WARN', `NOVA EXECUTOR: insufficient deployable balance for ${action.codename}`);
    return { success: false, error: 'INSUFFICIENT_BALANCE', actionId: action.id };
  }

  const amountSol = Math.min(
    deployable * (action.amountPct / 100),
    deployable * (config.maxPositionPct / 100)
  );

  if (amountSol < strategy.minSol) {
    log('WARN', `NOVA EXECUTOR: amount ${amountSol.toFixed(4)} SOL below minimum ${strategy.minSol} for ${action.codename}`);
    return { success: false, error: 'AMOUNT_TOO_SMALL', actionId: action.id };
  }

  log('NOVA', `NOVA EXECUTOR: executing ${action.codename} — ${action.strategy} ${action.action} ${amountSol.toFixed(4)} SOL — ${action.reason}`);

  try {
    const result = await strategy.fn({
      connection,
      agentKeypair,
      amountSol,
      config,
      log,
    });

    log('NOVA', `NOVA EXECUTOR: ${action.codename} completed — ${result.success ? 'SUCCESS' : 'FAILED'}${result.note ? ' — ' + result.note : ''}`);

    return {
      success: result.success,
      actionId: action.id,
      codename: action.codename,
      strategy: action.strategy,
      amountSol,
      ...result,
    };
  } catch (err) {
    log('ERROR', `NOVA EXECUTOR: ${action.codename} failed — ${err.message}`);
    return { success: false, error: err.message, actionId: action.id, codename: action.codename };
  }
}

module.exports = { executeNovaAction };
