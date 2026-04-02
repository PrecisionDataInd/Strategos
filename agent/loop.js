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
    message: `Agent loop started \u2014 interval ${cfg.checkIntervalSeconds}s`,
  });

  deps.emitToRenderer('agent:tick', {
    running: true,
    lastCheck,
    nextCheck: Date.now() + intervalMs,
  });

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

    const sweepResult = await deps.checkAndSweep();

    deps.addLogEntry({
      timestamp: Date.now(),
      level: 'HEARTBEAT',
      message: `Tick \u2014 Agent: ${agentBalance.toFixed(4)} SOL | Vault: ${vaultBalance.toFixed(4)} SOL${sweepResult.swept ? ' | SWEEP TRIGGERED' : ''}`,
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

    deps.emitToRenderer('agent:tick', {
      running: true,
      lastCheck,
      nextCheck,
      agentBalance,
      vaultBalance,
      sweepResult,
      strategyResults,
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
