const { startHarvestTimer, stopHarvestTimer } = require('./harvest');
const { getPositions } = require('./positions');
const { initSession, recordBalance, checkDrawdown } = require('./risk-manager');

let loopInterval = null;
let running = false;
let lastCheck = null;
let nextCheck = null;
let deps = null;

function getAgentStatus() {
  return {
    running,
    lastCheck,
    nextCheck,
  };
}

function startAgentLoop(dependencies) {
  if (running) return;
  deps = dependencies;
  running = true;

  const cfg = deps.getConfig();
  const intervalMs = (cfg.checkIntervalSeconds || 120) * 1000;

  deps.addLogEntry({
    timestamp: Date.now(),
    level: 'INFO',
    message: `Agent loop started — interval ${cfg.checkIntervalSeconds}s`,
  });

  deps.emitToRenderer('agent:tick', {
    running: true,
    lastCheck,
    nextCheck: Date.now() + intervalMs,
  });

  // Start harvest timer alongside main heartbeat
  if (deps.connection && deps.agentKeypair) {
    const harvestLog = (level, message) => {
      deps.addLogEntry({ timestamp: Date.now(), level, message });
    };
    startHarvestTimer({
      connection: deps.connection,
      agentKeypair: deps.agentKeypair,
      log: harvestLog,
      onComplete: ({ totalHarvestedSol, results }) => {
        deps.emitToRenderer('harvest:complete', { totalHarvestedSol, results });
      },
    });
  }

  runTick();

  loopInterval = setInterval(() => {
    runTick();
  }, intervalMs);
}

async function runTick() {
  if (!deps) return;

  const cfg = deps.getConfig();
  const intervalMs = (cfg.checkIntervalSeconds || 120) * 1000;
  lastCheck = Date.now();
  nextCheck = lastCheck + intervalMs;

  try {
    const agentBalance = await deps.getAgentBalance();
    const vaultBalance = await deps.getVaultBalance();

    // Phase 3b: Risk manager — init session, record balance, check drawdown
    initSession(agentBalance);
    recordBalance(agentBalance);

    const logFnRisk = (level, message) => {
      deps.addLogEntry({ timestamp: Date.now(), level, message });
    };
    const riskCheck = checkDrawdown(agentBalance, logFnRisk);

    if (riskCheck.shouldHalt) {
      deps.emitToRenderer('agent:halted', { reason: 'DRAWDOWN_EXCEEDED', ...riskCheck });
      deps.emitToRenderer('risk:status', riskCheck);
      stopAgentLoop();
      return;
    }

    // Emit risk status to renderer each tick
    deps.emitToRenderer('risk:status', riskCheck);

    const sweepResult = await deps.checkAndSweep();

    deps.addLogEntry({
      timestamp: Date.now(),
      level: 'HEARTBEAT',
      message: `Tick — Agent: ${agentBalance.toFixed(4)} SOL | Vault: ${vaultBalance.toFixed(4)} SOL${sweepResult.swept ? ' | SWEEP TRIGGERED' : ''}`,
    });

    // Phase 2: Run strategies after sweep check
    let strategyResults = [];
    if (deps.runStrategies && deps.connection && deps.agentKeypair) {
      try {
        const logFn = (level, message) => {
          deps.addLogEntry({ timestamp: Date.now(), level, message });
        };
        strategyResults = await deps.runStrategies({
          connection: deps.connection,
          agentKeypair: deps.agentKeypair,
          config: cfg,
          store: deps.store,
          log: logFn,
        });
      } catch (stratErr) {
        console.error('Strategy execution error:', stratErr.message);
        deps.addLogEntry({
          timestamp: Date.now(),
          level: 'ERROR',
          message: `Strategy execution error: ${stratErr.message}`,
        });
      }
    }

    // Check if Nova brief is due
    if (cfg.novaEnabled) {
      const novaTimestamp = deps.store.get('novaTimestamp') || 0;
      const novaDue = Date.now() - novaTimestamp > (cfg.novaBriefIntervalMinutes || 60) * 60000;
      if (novaDue) {
        // Non-blocking — fire and forget
        deps.requestNewNovaBrief().catch((e) => {
          console.error('Nova brief error:', e.message);
        });
      }
    }

    // Emit tick with position data
    deps.emitToRenderer('agent:tick', {
      running: true,
      lastCheck,
      nextCheck,
      agentBalance,
      vaultBalance,
      sweepResult,
      strategyResults,
      positions: getPositions(),
    });
  } catch (e) {
    console.error('Agent tick error:', e.message);
    deps.addLogEntry({
      timestamp: Date.now(),
      level: 'ERROR',
      message: `Agent tick error: ${e.message}`,
    });
  }
}

function stopAgentLoop() {
  if (loopInterval) {
    clearInterval(loopInterval);
    loopInterval = null;
  }
  running = false;
  stopHarvestTimer();
  if (deps) {
    deps.addLogEntry({
      timestamp: Date.now(),
      level: 'WARN',
      message: 'Agent loop stopped',
    });
    deps.emitToRenderer('agent:tick', {
      running: false,
      lastCheck,
      nextCheck: null,
    });
  }
}

module.exports = { startAgentLoop, stopAgentLoop, getAgentStatus };
