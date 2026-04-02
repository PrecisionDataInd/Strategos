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

    // Start countdown timer
    startCountdown();

    // Listen for events from main process
    window.strategos.on('agent:tick', handleAgentTick);
    window.strategos.on('log:entry', handleLogEntry);
    window.strategos.on('nova:brief', handleNovaBrief);
    window.strategos.on('agent:halted', handleAgentHalted);

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

    // Trigger radar ping
    triggerRadarPing();
  }

  function handleLogEntry(entry) {
    LoggerUI.addEntry(entry);
  }

  function handleNovaBrief(data) {
    NovaUI.updateFromEvent(data);
  }

  function handleAgentHalted() {
    agentRunning = false;
    updateAgentUI();
    showErrorBanner('critical', 'AGENT HALTED — Balance below loss floor. Manual intervention required.');
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
        agentNextCheck.textContent = 'NEXT CHECK: —';
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
        showErrorBanner('critical', 'AGENT WALLET KEY MISSING — CONFIGURE .env FILE BEFORE PROCEEDING');
      }
      if (!vaultPub) {
        showErrorBanner('warning', 'VAULT ADDRESS NOT SET — AUTO-SWEEP DISABLED');
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
