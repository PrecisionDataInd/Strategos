/* ==========================================================================
   STRATEGOS — Main App Controller
   ========================================================================== */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let agentRunning = true;
  let nextCheckTime = null;
  let countdownInterval = null;
  let currentConfig = {};

  // Phase 2: Strategy P&L tracking
  const strategyPnL = {
    staking: 0,
    lending: 0,
    liquidity: 0,
    arbitrage: 0,
    grid: 0,
  };

  // Strategy ID to row index mapping
  const STRATEGY_IDS = ['staking', 'lending', 'liquidity', 'arbitrage', 'grid'];

  // Phase 3a: Latest positions data
  let latestPositions = {};

  // Phase 3b: Risk manager state
  let latestRiskStatus = { drawdownPct: 0, sessionHigh: 0, shouldHalt: false };

  // ---------------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------------
  const statusDot = document.getElementById('titlebar-status-dot');
  const statusLabel = document.getElementById('titlebar-status-label');
  const agentStatusText = document.getElementById('agent-status-text');
  const agentLastCheck = document.getElementById('agent-last-check');
  const agentNextCheck = document.getElementById('agent-next-check');
  const btnAgentToggle = document.getElementById('btn-agent-toggle');
  const radarPing = document.getElementById('radar-ping');
  const errorBanners = document.getElementById('error-banners');

  // Config inputs
  const cfgSweepThreshold = document.getElementById('cfg-sweep-threshold');
  const cfgReserveFloor = document.getElementById('cfg-reserve-floor');
  const cfgCheckInterval = document.getElementById('cfg-check-interval');
  const cfgAutoSweep = document.getElementById('cfg-auto-sweep');
  const btnCommitConfig = document.getElementById('btn-commit-config');

  // Risk buttons
  const riskButtons = document.querySelectorAll('.risk-btn');

  // Window controls
  document.getElementById('btn-minimize').addEventListener('click', () => window.strategos.window.minimize());
  document.getElementById('btn-maximize').addEventListener('click', () => window.strategos.window.maximize());
  document.getElementById('btn-close').addEventListener('click', () => window.strategos.window.close());

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  async function init() {
    // Init sub-controllers
    WalletUI.init();
    SweepUI.init();
    LoggerUI.init();
    NovaUI.init();

    // Load config
    await loadConfig();

    // Check environment errors
    checkEnvironmentErrors();

    // Agent toggle
    btnAgentToggle.addEventListener('click', toggleAgent);

    // Config commit
    btnCommitConfig.addEventListener('click', commitConfig);

    // Risk buttons
    riskButtons.forEach((btn) => {
      btn.addEventListener('click', () => setRiskLevel(btn.dataset.risk));
    });

    // Phase 3a: Harvest button
    const btnHarvest = document.getElementById('btn-harvest-now');
    if (btnHarvest) {
      btnHarvest.addEventListener('click', runHarvestNow);
    }

    // Start countdown timer
    startCountdown();

    // Listen for events from main process
    window.strategos.on('agent:tick', handleAgentTick);
    window.strategos.on('log:entry', handleLogEntry);
    window.strategos.on('nova:brief', handleNovaBrief);
    window.strategos.on('agent:halted', handleAgentHalted);
    window.strategos.on('harvest:complete', handleHarvestComplete);
    window.strategos.on('risk:status', handleRiskStatus);
    window.strategos.on('nova:actionResult', handleNovaActionResult);

    // Get initial agent status
    try {
      const status = await window.strategos.agent.getStatus();
      if (status) {
        agentRunning = status.running;
        updateAgentUI();
      }
    } catch (e) {
      console.error('Failed to get agent status:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  async function loadConfig() {
    try {
      currentConfig = await window.strategos.config.get();
      cfgSweepThreshold.value = currentConfig.sweepThreshold;
      cfgReserveFloor.value = currentConfig.reserveFloor;
      cfgCheckInterval.value = currentConfig.checkIntervalSeconds;
      cfgAutoSweep.checked = currentConfig.autoSweepEnabled;

      // Set risk button active state
      riskButtons.forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.risk === currentConfig.riskLevel);
      });

      WalletUI.updateConfigDisplay(currentConfig);
    } catch (e) {
      console.error('Failed to load config:', e);
    }
  }

  async function commitConfig() {
    btnCommitConfig.textContent = 'COMMITTING...';
    try {
      await window.strategos.config.set('sweepThreshold', parseFloat(cfgSweepThreshold.value) || 2.0);
      await window.strategos.config.set('reserveFloor', parseFloat(cfgReserveFloor.value) || 0.25);
      await window.strategos.config.set('checkIntervalSeconds', parseInt(cfgCheckInterval.value) || 120);
      await window.strategos.config.set('autoSweepEnabled', cfgAutoSweep.checked);
      currentConfig = await window.strategos.config.get();
      WalletUI.updateConfigDisplay(currentConfig);
      btnCommitConfig.textContent = 'CONFIG COMMITTED';
      setTimeout(() => { btnCommitConfig.textContent = 'COMMIT CONFIG'; }, 1500);
    } catch (e) {
      console.error('Failed to commit config:', e);
      btnCommitConfig.textContent = 'COMMIT FAILED';
      setTimeout(() => { btnCommitConfig.textContent = 'COMMIT CONFIG'; }, 1500);
    }
  }

  async function setRiskLevel(level) {
    riskButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.risk === level);
    });
    try {
      await window.strategos.config.set('riskLevel', level);
      currentConfig.riskLevel = level;
    } catch (e) {
      console.error('Failed to set risk level:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // Agent control
  // ---------------------------------------------------------------------------
  async function toggleAgent() {
    try {
      if (agentRunning) {
        await window.strategos.agent.stop();
        agentRunning = false;
      } else {
        await window.strategos.agent.start();
        agentRunning = true;
      }
      updateAgentUI();
    } catch (e) {
      console.error('Agent toggle error:', e);
    }
  }

  function updateAgentUI() {
    if (agentRunning) {
      statusDot.className = 'status-dot active';
      statusLabel.textContent = 'AGENT ACTIVE';
      agentStatusText.textContent = 'AGENT ACTIVE';
      agentStatusText.className = 'agent-status-text active';
      btnAgentToggle.textContent = 'HALT AGENT';
    } else {
      statusDot.className = 'status-dot halted';
      statusLabel.textContent = 'AGENT HALTED';
      agentStatusText.textContent = 'AGENT HALTED';
      agentStatusText.className = 'agent-status-text halted';
      btnAgentToggle.textContent = 'START AGENT';
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 3a: Harvest control
  // ---------------------------------------------------------------------------
  async function runHarvestNow() {
    const btn = document.getElementById('btn-harvest-now');
    if (!btn) return;
    btn.textContent = 'HARVESTING...';
    btn.disabled = true;
    try {
      const result = await window.strategos.harvest.runNow();
      if (result && result.totalHarvestedSol > 0) {
        btn.textContent = `HARVESTED ${result.totalHarvestedSol.toFixed(6)} SOL`;
      } else {
        btn.textContent = 'NO FEES TO COLLECT';
      }
    } catch (e) {
      console.error('Harvest error:', e);
      btn.textContent = 'HARVEST FAILED';
    }
    setTimeout(() => {
      btn.textContent = 'RUN HARVEST NOW';
      btn.disabled = false;
    }, 3000);
  }

  function handleHarvestComplete(data) {
    if (data && data.totalHarvestedSol > 0) {
      LoggerUI.addEntry({
        timestamp: Date.now(),
        level: 'SWEEP',
        message: `HARVEST: ${data.totalHarvestedSol.toFixed(6)} SOL collected`,
      });

      // Flash Session P&L card gold
      const pnlCard = document.getElementById('session-pnl');
      if (pnlCard) {
        const card = pnlCard.closest('.metric-card');
        if (card) {
          card.classList.add('harvest-flash');
          setTimeout(() => card.classList.remove('harvest-flash'), 2000);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------
  function handleAgentTick(data) {
    agentRunning = data.running;
    updateAgentUI();

    if (data.lastCheck) {
      const t = new Date(data.lastCheck);
      agentLastCheck.textContent = 'LAST CHECK: ' + t.toLocaleTimeString('en-US', { hour12: false });
    }

    if (data.nextCheck) {
      nextCheckTime = data.nextCheck;
    }

    // Update balances
    if (data.agentBalance !== undefined) {
      WalletUI.updateBalances(data.agentBalance, data.vaultBalance);
      WalletUI.updateThresholdProgress(data.agentBalance, currentConfig.sweepThreshold || 2.0);
      SweepUI.updateSweepStatus(data.agentBalance, currentConfig.sweepThreshold || 2.0);
    }

    // Handle sweep result
    if (data.sweepResult && data.sweepResult.swept) {
      WalletUI.addSweptAmount(data.sweepResult.amount);
    }

    // Phase 3a: Store positions data
    if (data.positions) {
      latestPositions = data.positions;
    }

    // Phase 2/3a: Update strategy matrix with live data + positions
    if (data.strategyResults && data.strategyResults.length > 0) {
      updateStrategyMatrix(data.strategyResults);
    }

    // Trigger radar ping
    triggerRadarPing();
  }

  function handleLogEntry(entry) {
    LoggerUI.addEntry(entry);
  }

  function handleNovaBrief(data) {
    NovaUI.updateFromEvent(data);
  }

  function handleAgentHalted(data) {
    agentRunning = false;
    updateAgentUI();
    if (data && data.reason === 'DRAWDOWN_EXCEEDED') {
      showErrorBanner('critical', 'AGENT HALTED \u2014 Drawdown ' + ((data.drawdownPct || 0) * 100).toFixed(1) + '% exceeds 20% limit. Reset session to resume.');
    } else {
      showErrorBanner('critical', 'AGENT HALTED \u2014 Balance below loss floor. Manual intervention required.');
    }
  }

  // Phase 3b: Risk status handler
  function handleRiskStatus(data) {
    latestRiskStatus = data;
    updateRiskIndicator(data);
  }

  function updateRiskIndicator(riskData) {
    const indicator = document.getElementById('risk-indicator');
    if (!indicator) return;

    const pct = ((riskData.drawdownPct || 0) * 100).toFixed(1);
    const drawdownEl = indicator.querySelector('.risk-drawdown-value');
    const barFill = indicator.querySelector('.risk-bar-fill');
    const statusEl = indicator.querySelector('.risk-status-label');

    if (drawdownEl) drawdownEl.textContent = pct + '%';
    if (barFill) {
      const fillPct = Math.min(riskData.drawdownPct / 0.20 * 100, 100);
      barFill.style.width = fillPct + '%';
      if (riskData.drawdownPct >= 0.15) {
        barFill.className = 'risk-bar-fill critical';
      } else if (riskData.drawdownPct >= 0.10) {
        barFill.className = 'risk-bar-fill warning';
      } else {
        barFill.className = 'risk-bar-fill normal';
      }
    }
    if (statusEl) {
      if (riskData.shouldHalt) {
        statusEl.textContent = 'HALTED';
        statusEl.style.color = 'var(--loss-red)';
      } else if (riskData.drawdownPct >= 0.10) {
        statusEl.textContent = 'CAUTION';
        statusEl.style.color = 'var(--warn-amber)';
      } else {
        statusEl.textContent = 'NOMINAL';
        statusEl.style.color = 'var(--gain-green)';
      }
    }
  }

  function handleNovaActionResult(data) {
    if (data && data.codename) {
      const level = data.success ? 'NOVA' : 'ERROR';
      const msg = data.success
        ? 'NOVA ACTION: ' + data.codename + ' executed \u2014 ' + (data.amountSol || 0).toFixed(4) + ' SOL'
        : 'NOVA ACTION: ' + data.codename + ' failed \u2014 ' + (data.error || 'unknown');
      LoggerUI.addEntry({ timestamp: Date.now(), level, message: msg });
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 2/3a: Strategy Matrix Update
  // ---------------------------------------------------------------------------
  function updateStrategyMatrix(results) {
    const strategyRows = document.querySelectorAll('.strategy-row');
    let activeCount = 0;

    results.forEach((result) => {
      const idx = STRATEGY_IDS.indexOf(result.id);
      if (idx === -1) return;

      const row = strategyRows[idx];
      if (!row) return;

      const cells = row.querySelectorAll('div');
      if (cells.length < 6) return;

      // Check position data for this strategy
      const strategyPositions = latestPositions[result.id] || [];
      const openPositions = strategyPositions.filter(p => p.status !== 'CLOSED');
      const hasOpenPositions = openPositions.length > 0 || result.openPositions > 0;

      // Column 1 (Status badge) — use _displayStatus from strategy coordinator when available
      let badgeClass = 'badge dim';
      let badgeText = 'STANDBY';

      const displayStatus = result._displayStatus || null;

      if (displayStatus === 'TRACKED') {
        badgeClass = 'badge tracked';
        badgeText = 'TRACKED';
        activeCount++;
      } else if (displayStatus === 'ACTIVE' || hasOpenPositions || (result.success === true && result.reason === 'POSITION_EXISTS') || (result.success === true && result.reason === 'GRID_ACTIVE')) {
        badgeClass = 'badge live';
        badgeText = 'ACTIVE';
        activeCount++;
      } else if (displayStatus === 'STANDBY') {
        badgeClass = 'badge dim';
        badgeText = 'STANDBY';
      } else if (displayStatus === 'ERROR') {
        badgeClass = 'badge error';
        badgeText = 'ERROR';
      } else if (result.success === true && result.tracked) {
        badgeClass = 'badge tracked';
        badgeText = 'TRACKED';
        activeCount++;
      } else if (result.success === true) {
        badgeClass = 'badge live';
        badgeText = 'ACTIVE';
        activeCount++;
      } else if (result.error) {
        badgeClass = 'badge error';
        badgeText = 'ERROR';
      } else if (result.reason === 'AMOUNT_TOO_SMALL') {
        badgeClass = 'badge dim';
        badgeText = 'STANDBY';
      } else if (result.success === false && result.reason) {
        badgeClass = 'badge dim';
        badgeText = 'STANDBY';
      }

      cells[1].innerHTML = '<span class="' + badgeClass + '">' + badgeText + '</span>';

      // Add position count sub-label under strategy name
      const nameCell = cells[0];
      let posLabel = nameCell.querySelector('.strategy-pos-count');
      if (hasOpenPositions) {
        const posCount = openPositions.length || result.openPositions || 0;
        if (!posLabel) {
          posLabel = document.createElement('span');
          posLabel.className = 'strategy-pos-count';
          nameCell.appendChild(posLabel);
        }
        posLabel.textContent = 'POSITIONS: ' + posCount + ' open';
      } else if (posLabel) {
        posLabel.remove();
      }

      // Column 2 (APY)
      if (result.apy) {
        cells[2].textContent = result.apy;
        cells[2].style.color = 'var(--gain-green)';
      } else {
        cells[2].textContent = '\u2014';
        cells[2].style.color = '';
      }

      // Column 3 (Allocated) — show real amount from position data
      if (hasOpenPositions && openPositions.length > 0) {
        const totalAllocated = openPositions.reduce((sum, p) => sum + (p.amountSol || 0), 0);
        if (totalAllocated > 0) {
          cells[3].textContent = '\u25CE ' + totalAllocated.toFixed(4);
          cells[3].style.color = 'var(--bronze-light)';
        } else if (result.amountSol !== undefined && result.success) {
          cells[3].textContent = '\u25CE ' + result.amountSol.toFixed(4);
          cells[3].style.color = 'var(--bronze-light)';
        }
      } else if (result.amountSol !== undefined && result.success) {
        cells[3].textContent = '\u25CE ' + result.amountSol.toFixed(4);
        cells[3].style.color = 'var(--bronze-light)';
      } else {
        cells[3].textContent = '\u2014';
        cells[3].style.color = '';
      }

      // Column 4 (Session P&L) — cumulative tracking from positions
      if (hasOpenPositions && openPositions.length > 0) {
        const totalEarned = openPositions.reduce((sum, p) => sum + (p.totalHarvestedSol || p.earnedSol || p.msolGrowth || 0), 0);
        if (totalEarned > 0) {
          strategyPnL[result.id] = totalEarned;
        }
      } else if (result.success && result.amountSol) {
        if (result.note && result.note.includes('tracked')) {
          strategyPnL[result.id] += result.amountSol * 0.00001;
        }
      }
      if (strategyPnL[result.id] > 0) {
        cells[4].textContent = '+\u25CE ' + strategyPnL[result.id].toFixed(6);
        cells[4].style.color = 'var(--gain-green)';
      } else {
        cells[4].textContent = '\u25CE 0.0000';
        cells[4].style.color = 'var(--text-muted)';
      }

      // Column 5 (Risk Tier) — already set in HTML, just re-apply
      const strategy = [
        { risk: 'LOW' },
        { risk: 'LOW' },
        { risk: 'MEDIUM' },
        { risk: 'MEDIUM' },
        { risk: 'HIGH' },
      ];
      const riskColors = { LOW: 'var(--gain-green)', MEDIUM: 'var(--warn-amber)', HIGH: 'var(--loss-red)' };
      cells[5].textContent = strategy[idx].risk;
      cells[5].style.color = riskColors[strategy[idx].risk];
    });

    // Update strategy header badge
    const headerBadge = document.getElementById('strategy-header-badge');
    if (headerBadge) {
      headerBadge.textContent = activeCount + ' / 5 STRATEGIES ACTIVE';
      headerBadge.className = 'badge live';
    }
  }

  // ---------------------------------------------------------------------------
  // Radar ping animation
  // ---------------------------------------------------------------------------
  function triggerRadarPing() {
    radarPing.classList.remove('active');
    // Force reflow
    void radarPing.offsetWidth;
    radarPing.classList.add('active');
    setTimeout(() => radarPing.classList.remove('active'), 1500);
  }

  // ---------------------------------------------------------------------------
  // Countdown timer
  // ---------------------------------------------------------------------------
  function startCountdown() {
    countdownInterval = setInterval(() => {
      if (nextCheckTime && agentRunning) {
        const remaining = Math.max(0, nextCheckTime - Date.now());
        const secs = Math.ceil(remaining / 1000);
        agentNextCheck.textContent = 'NEXT CHECK: ' + secs + 's';
      } else if (!agentRunning) {
        agentNextCheck.textContent = 'NEXT CHECK: \u2014';
      }
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // Error banners
  // ---------------------------------------------------------------------------
  async function checkEnvironmentErrors() {
    try {
      const agentPub = await window.strategos.wallet.getAgentPublicKey();
      const vaultPub = await window.strategos.wallet.getVaultPublicKey();

      if (!agentPub) {
        showErrorBanner('critical', 'AGENT WALLET KEY MISSING \u2014 CONFIGURE .env FILE BEFORE PROCEEDING');
      }
      if (!vaultPub) {
        showErrorBanner('warning', 'VAULT ADDRESS NOT SET \u2014 AUTO-SWEEP DISABLED');
      }
    } catch (e) {
      console.error('Environment check error:', e);
    }
  }

  function showErrorBanner(type, message) {
    const banner = document.createElement('div');
    banner.className = 'error-banner ' + type;
    banner.textContent = message;
    errorBanners.appendChild(banner);
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', init);
})();
