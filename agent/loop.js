const { startHarvestTimer, stopHarvestTimer } = require('./harvest');
const { getPositions, getOpenPositions, savePosition } = require('./positions');
const {
  initSession,
  recordBalance,
  checkDrawdown,
  resetSession,
  getTotalPortfolioValueSol,
  shouldDailyReset,
  performDailyReset,
} = require('./risk-manager');
const { getCachedPrice } = require('./price-feed');
const { runStopLossCheck } = require('./strategies/stop-loss');
const { recordFeeSpent, getBudgetStatus } = require('./fee-budget');
const { recordStrategyResult } = require('./profitability-guard');
const { resetPacing } = require('./deployment-pacer');

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

  const logFn = (level, message) => {
    deps.addLogEntry({ timestamp: Date.now(), level, message });
  };

  try {
    // Daily reset check — UTC midnight
    if (shouldDailyReset() && deps.connection && deps.agentKeypair) {
      try {
        const currentBal = await deps.connection.getBalance(deps.agentKeypair.publicKey) / 1e9;
        const breakdown = await getTotalPortfolioValueSol(deps.connection, deps.agentKeypair.publicKey, currentBal);
        performDailyReset(breakdown.totalSol, logFn);
        resetPacing();
      } catch (err) {
        logFn('WARN', `DAILY RESET failed: ${err.message}`, {});
      }
    }

    const agentBalance = await deps.getAgentBalance();
    const vaultBalance = await deps.getVaultBalance();

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

    initSession(totalPortfolioSol);
    recordBalance(totalPortfolioSol);

    const riskCheck = checkDrawdown(totalPortfolioSol, logFn, portfolioBreakdown);

    // Full halt — stop everything
    if (riskCheck.fullHalt) {
      haltedByRiskManager = true;
      deps.emitToRenderer('agent:halted', {
        reason: 'FULL_HALT',
        drawdownPct: riskCheck.drawdownPct,
        sessionHigh: riskCheck.sessionHigh,
        totalPortfolioSol,
        breakdown: portfolioBreakdown,
        haltedTiers: riskCheck.haltedTiers,
      });
      deps.emitToRenderer('risk:status', riskCheck);
      stopAgentLoop();
      return;
    }

    deps.emitToRenderer('risk:status', riskCheck);

    // Run stop-loss check before strategies
    if (deps.connection) {
      try {
        await runStopLossCheck({ connection: deps.connection, log: logFn });
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

    // Run strategies with tier halt awareness
    let strategyResults = [];
    if (deps.runStrategies && deps.connection && deps.agentKeypair) {
      try {
        strategyResults = await deps.runStrategies({
          connection: deps.connection,
          agentKeypair: deps.agentKeypair,
          config: cfg,
          store: deps.store,
          log: logFn,
          haltedTiers: riskCheck.haltedTiers || [],
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

    // Record fees and per-strategy P&L for profitability guard / fee budget
    for (const result of strategyResults) {
      if (result.success && result.txid) {
        const estimatedFeeSol = 0.0001;
        recordFeeSpent(estimatedFeeSol);
        recordStrategyResult(result.id, result.profitSol || 0, estimatedFeeSol);
      }
    }

    if (cfg.novaEnabled) {
      const novaTimestamp = deps.store.get('novaTimestamp') || 0;
      const novaDue = Date.now() - novaTimestamp > (cfg.novaBriefIntervalMinutes || 60) * 60000;
      if (novaDue) {
        deps.requestNewNovaBrief().catch((e) => {
          console.error('Nova brief error:', e.message);
        });
      }
    }

    const priceData = getCachedPrice();

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
        fullHalt: riskCheck.fullHalt,
        haltedTiers: riskCheck.haltedTiers || [],
        inGracePeriod: riskCheck.inGracePeriod || false,
        totalPortfolioSol,
      },
      feeBudget: getBudgetStatus(),
      inGracePeriod: riskCheck.inGracePeriod || false,
      haltedTiers: riskCheck.haltedTiers || [],
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
