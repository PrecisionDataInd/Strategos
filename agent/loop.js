const { startHarvestTimer, stopHarvestTimer } = require('./harvest');
const { getPositions, getOpenPositions, savePosition } = require('./positions');
const { initSession, recordBalance, checkDrawdown, resetSession, getTotalPortfolioValueSol } = require('./risk-manager');
const { getCachedPrice } = require('./price-feed');
const { runStopLossCheck } = require('./strategies/stop-loss');

let loopInterval = null;
let running = false;
let haltedByRiskManager = false;
let lastCheck = null;
let nextCheck = null;
let deps = null;

function getAgentStatus() {
  return {
    running,
    haltedByRiskManager,
    lastCheck,
    nextCheck,
  };
}

async function startAgentLoop(dependencies) {
  if (running) return;
  deps = dependencies;
  running = true;
  haltedByRiskManager = false;

  const cfg = deps.getConfig();
  const intervalMs = (cfg.checkIntervalSeconds || 120) * 1000;

  const logEntry = (level, message, meta) => {
    deps.addLogEntry({ timestamp: Date.now(), level, message });
  };

  // Seed staking position if none recorded but mSOL exists in wallet
  if (deps.connection && deps.agentKeypair) {
    try {
      const { getAssociatedTokenAddress } = require('@solana/spl-token');
      const { PublicKey } = require('@solana/web3.js');
      const MSOL_MINT = new PublicKey('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So');
      const msolATA = await getAssociatedTokenAddress(MSOL_MINT, deps.agentKeypair.publicKey);

      const msolBalance = await deps.connection.getTokenAccountBalance(msolATA);
      const msolAmount = parseFloat(msolBalance.value.uiAmount || 0);

      const existingStaking = getOpenPositions('staking');

      if (msolAmount > 0 && existingStaking.length === 0) {
        savePosition('staking', {
          amountSol: msolAmount,
          txid: 'SEEDED-ON-STARTUP',
          status: 'OPEN',
          apy: '~8%',
          currentMsol: msolAmount,
          note: 'Position seeded from existing mSOL balance',
          openedAt: new Date().toISOString(),
        });
        logEntry('INFO', `STARTUP: seeded staking position from ${msolAmount.toFixed(6)} existing mSOL`);
      }
    } catch (err) {
      logEntry('WARN', `Could not seed existing positions: ${err.message}`);
    }

    // Reset risk manager session high to current total portfolio value
    try {
      const currentBalance = await deps.connection.getBalance(deps.agentKeypair.publicKey) / 1e9;
      const portfolioBreakdown = await getTotalPortfolioValueSol(
        deps.connection,
        deps.agentKeypair.publicKey,
        currentBalance
      );
      resetSession(portfolioBreakdown.totalSol);
      logEntry('INFO', `RISK MANAGER: session reset — new baseline ${portfolioBreakdown.totalSol.toFixed(4)} SOL (${currentBalance.toFixed(4)} SOL + ${portfolioBreakdown.usdcSol.toFixed(4)} USDC-equiv + ${portfolioBreakdown.msolSol.toFixed(4)} mSOL)`);
    } catch (err) {
      logEntry('WARN', `Could not reset risk session: ${err.message}`);
    }
  }

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

    // Calculate total portfolio value including USDC and mSOL
    let portfolioBreakdown = null;
    let totalPortfolioSol = agentBalance;
    if (deps.connection && deps.agentKeypair) {
      try {
        portfolioBreakdown = await getTotalPortfolioValueSol(
          deps.connection,
          deps.agentKeypair.publicKey,
          agentBalance
        );
        totalPortfolioSol = portfolioBreakdown.totalSol;
      } catch (_) {}
    }

    // Phase 3b: Risk manager — init session, record balance, check drawdown
    initSession(totalPortfolioSol);
    recordBalance(totalPortfolioSol);

    const logFnRisk = (level, message) => {
      deps.addLogEntry({ timestamp: Date.now(), level, message });
    };
    const riskCheck = checkDrawdown(totalPortfolioSol, logFnRisk, portfolioBreakdown);

    if (riskCheck.shouldHalt) {
      haltedByRiskManager = true;
      deps.emitToRenderer('agent:halted', {
        reason: 'DRAWDOWN_EXCEEDED',
        drawdownPct: riskCheck.drawdownPct,
        sessionHigh: riskCheck.sessionHigh,
        totalPortfolioSol,
        breakdown: portfolioBreakdown,
      });
      deps.emitToRenderer('risk:status', riskCheck);
      stopAgentLoop();
      return;
    }

    // Emit risk status to renderer each tick
    deps.emitToRenderer('risk:status', riskCheck);

    // Run stop-loss check before strategies
    if (deps.connection) {
      try {
        const stopLossLog = (level, message) => {
          deps.addLogEntry({ timestamp: Date.now(), level, message });
        };
        await runStopLossCheck({ connection: deps.connection, log: stopLossLog });
      } catch (slErr) {
        console.error('Stop-loss check error:', slErr.message);
      }
    }

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

    // Phase 4: Emit price data alongside tick
    const priceData = getCachedPrice();

    // Emit tick with position data, price, and portfolio breakdown
    deps.emitToRenderer('agent:tick', {
      running: true,
      lastCheck,
      nextCheck,
      agentBalance,
      vaultBalance,
      totalPortfolioSol,
      portfolioBreakdown,
      sweepResult,
      strategyResults,
      positions: getPositions(),
      price: priceData,
      riskStatus: {
        drawdownPct: riskCheck.drawdownPct,
        sessionHigh: riskCheck.sessionHigh,
        shouldHalt: riskCheck.shouldHalt,
        totalPortfolioSol,
      },
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
