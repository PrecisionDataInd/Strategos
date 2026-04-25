require('dotenv').config();
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const defaults = require('./config/defaults');
const { startAgentLoop, stopAgentLoop, getAgentStatus } = require('./agent/loop');
const { generateNovaBrief, parseNovaActions, stripNovaActionTags } = require('./agent/nova-engine');
const { executeNovaAction } = require('./agent/nova-executor');
const { getRiskStatus, resetSession } = require('./agent/risk-manager');
const { executeLiveSweep } = require('./agent/sweep-live');
const { runStrategies, STRATEGIES } = require('./agent/strategies/index');
const { getPositions } = require('./agent/positions');
const { runHarvest } = require('./agent/harvest');
const { startPriceFeed, getCachedPrice } = require('./agent/price-feed');
const { startReportScheduler, sendDailyReport } = require('./agent/reporter');
const { getPortfolioSummary, getTransactionLedger } = require('./agent/portfolio');
const { runUnwind } = require('./agent/unwind');

// ---------------------------------------------------------------------------
// Dependency check — log missing packages without crashing
// ---------------------------------------------------------------------------
function checkDependencies() {
  const required = [
    '@solana/web3.js',
    '@anthropic-ai/sdk',
    'electron-store',
    'dotenv',
  ];

  const optional = [
    '@marinade.finance/marinade-ts-sdk',
    '@orca-so/whirlpools-sdk',
    '@orca-so/common-sdk',
    '@coral-xyz/anchor',
    'decimal.js',
  ];

  const missing = [];

  for (const pkg of required) {
    try { require(pkg); } catch (e) { missing.push({ pkg, required: true }); }
  }

  for (const pkg of optional) {
    try { require(pkg); } catch (e) { missing.push({ pkg, required: false }); }
  }

  if (missing.length > 0) {
    const requiredMissing = missing.filter(m => m.required);
    const optionalMissing = missing.filter(m => !m.required);

    if (optionalMissing.length > 0) {
      console.warn('STRATEGOS: Optional packages not installed (strategies will degrade gracefully):',
        optionalMissing.map(m => m.pkg).join(', '));
      console.warn('Run: npm install --legacy-peer-deps');
    }

    if (requiredMissing.length > 0) {
      console.error('STRATEGOS: Required packages missing — app may not function:',
        requiredMissing.map(m => m.pkg).join(', '));
    }
  }

  return missing;
}

const missingDeps = checkDependencies();

const store = new Store();
let mainWindow = null;
let tray = null;
let trayStatusUpdater = null;
let connection = null;

// Detect if launched from Windows startup (hidden mode)
const isHiddenLaunch = process.argv.includes('--hidden');
let agentKeypair = null;
let vaultPublicKey = null;

// Phase 2: strategy results cache
let latestStrategyResults = [];

// Phase 4: balance cache for reporter
let lastKnownBalances = { agent: 0, vault: 0 };

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------
function getConfig() {
  const saved = store.get('config') || {};
  return { ...defaults, ...saved };
}

function setConfig(key, value) {
  const cfg = getConfig();
  cfg[key] = value;
  store.set('config', cfg);
  return cfg;
}

// ---------------------------------------------------------------------------
// Wallet helpers
// ---------------------------------------------------------------------------
function initWallet() {
  const privKey = process.env.AGENT_WALLET_PRIVATE_KEY;
  if (privKey) {
    try {
      let secretKey;
      const trimmed = privKey.trim();
      if (trimmed.startsWith('[')) {
        secretKey = Uint8Array.from(JSON.parse(trimmed));
      } else {
        const bs58 = require('bs58');
        secretKey = bs58.decode(trimmed);
      }
      agentKeypair = Keypair.fromSecretKey(secretKey);
    } catch (e) {
      console.error('Failed to parse AGENT_WALLET_PRIVATE_KEY:', e.message);
    }
  }

  const vaultAddr = process.env.VAULT_WALLET_PUBLIC_KEY;
  if (vaultAddr) {
    try {
      vaultPublicKey = new PublicKey(vaultAddr.trim());
    } catch (e) {
      console.error('Invalid VAULT_WALLET_PUBLIC_KEY:', e.message);
    }
  }

  const rpc = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
  connection = new Connection(rpc, { commitment: 'confirmed' });
}

let cachedAgentBalance = 0;
let cachedVaultBalance = 0;

async function getBalance(pubkey) {
  if (!connection || !pubkey) return 0;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const lamports = await connection.getBalance(pubkey, { signal: controller.signal });
    clearTimeout(timeout);
    return lamports / LAMPORTS_PER_SOL;
  } catch (e) {
    clearTimeout(timeout);
    console.error('RPC getBalance error:', e.message);
    return null;
  }
}

async function getAgentBalance() {
  if (!agentKeypair) return cachedAgentBalance;
  const bal = await getBalance(agentKeypair.publicKey);
  if (bal !== null) cachedAgentBalance = bal;
  return cachedAgentBalance;
}

async function getVaultBalance() {
  if (!vaultPublicKey) return cachedVaultBalance;
  const bal = await getBalance(vaultPublicKey);
  if (bal !== null) cachedVaultBalance = bal;
  return cachedVaultBalance;
}

// ---------------------------------------------------------------------------
// Sweep logic — PHASE 2: Live transactions
// ---------------------------------------------------------------------------
function logEntry(level, message, meta) {
  addLogEntry({
    timestamp: Date.now(),
    level,
    message,
  });
}

async function checkAndSweep() {
  const cfg = getConfig();
  const balance = await getAgentBalance();

  if (balance < cfg.lossFloorSol) {
    const entry = {
      timestamp: Date.now(),
      level: 'CRITICAL',
      message: `Balance ${balance.toFixed(4)} SOL below loss floor ${cfg.lossFloorSol} SOL \u2014 HALTING AGENT`,
    };
    addLogEntry(entry);
    stopAgentLoop();
    emitToRenderer('agent:halted', {});
    return { swept: false, halted: true };
  }

  if (balance >= cfg.sweepThreshold && cfg.autoSweepEnabled) {
    const sweepAmount = balance - cfg.reserveFloor;
    if (sweepAmount <= 0) return { swept: false };

    // PHASE 2: Execute live sweep
    if (agentKeypair && vaultPublicKey && connection) {
      const result = await executeLiveSweep({
        connection,
        agentKeypair,
        vaultPublicKey,
        sweepAmountSol: sweepAmount,
        log: logEntry,
      });
      return result;
    }

    // Fallback if wallet not configured
    return { swept: false, reason: 'WALLET_NOT_CONFIGURED' };
  }

  return { swept: false };
}

async function manualSweep() {
  const cfg = getConfig();
  const balance = await getAgentBalance();
  const sweepAmount = balance - cfg.reserveFloor;
  if (sweepAmount <= 0) return { swept: false, reason: 'Insufficient balance after reserve' };

  // PHASE 2: Execute live sweep
  if (agentKeypair && vaultPublicKey && connection) {
    const result = await executeLiveSweep({
      connection,
      agentKeypair,
      vaultPublicKey,
      sweepAmountSol: sweepAmount,
      log: logEntry,
    });
    return result;
  }

  return { swept: false, reason: 'WALLET_NOT_CONFIGURED' };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function getLogEntries() {
  return store.get('logEntries') || [];
}

function addLogEntry(entry) {
  const entries = getLogEntries();
  entries.unshift(entry);
  if (entries.length > 500) entries.length = 500;
  store.set('logEntries', entries);
  emitToRenderer('log:entry', entry);
}

function clearLog() {
  store.set('logEntries', []);
}

// ---------------------------------------------------------------------------
// Nova
// ---------------------------------------------------------------------------
async function getNovaBrief() {
  const brief = store.get('novaBrief') || null;
  const timestamp = store.get('novaTimestamp') || null;
  return { brief, timestamp };
}

async function requestNewNovaBrief() {
  if (!process.env.ANTHROPIC_API_KEY) {
    return 'NOVA OFFLINE \u2014 API key not configured';
  }
  try {
    const agentBalance = await getAgentBalance();
    const vaultBalance = await getVaultBalance();
    const cfg = getConfig();
    const context = {
      agentBalance,
      vaultBalance,
      sweepThreshold: cfg.sweepThreshold,
      riskLevel: cfg.riskLevel,
    };
    const rawBrief = await generateNovaBrief(context);
    const actions = parseNovaActions(rawBrief);
    const brief = stripNovaActionTags(rawBrief);
    store.set('novaBrief', brief);
    store.set('novaActions', actions);
    store.set('novaTimestamp', Date.now());
    emitToRenderer('nova:brief', { brief, timestamp: Date.now(), actions });
    addLogEntry({
      timestamp: Date.now(),
      level: 'NOVA',
      message: 'New intelligence brief generated',
    });
    return brief;
  } catch (e) {
    console.error('Nova brief generation failed:', e.message);
    addLogEntry({
      timestamp: Date.now(),
      level: 'ERROR',
      message: `Nova intelligence failure: ${e.message}`,
    });
    const cached = store.get('novaBrief');
    return cached || 'NOVA OFFLINE \u2014 Brief generation failed';
  }
}

// ---------------------------------------------------------------------------
// IPC helpers
// ---------------------------------------------------------------------------
function emitToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------
function registerIPC() {
  ipcMain.handle('wallet:getAgentBalance', async () => getAgentBalance());
  ipcMain.handle('wallet:getVaultBalance', async () => getVaultBalance());
  ipcMain.handle('wallet:getAgentPublicKey', async () =>
    agentKeypair ? agentKeypair.publicKey.toBase58() : null
  );
  ipcMain.handle('wallet:getVaultPublicKey', async () =>
    vaultPublicKey ? vaultPublicKey.toBase58() : null
  );

  ipcMain.handle('sweep:checkAndSweep', async () => checkAndSweep());
  ipcMain.handle('sweep:manualSweep', async () => manualSweep());
  ipcMain.handle('sweep:isLiveMode', () => true);

  ipcMain.handle('config:get', async () => getConfig());
  ipcMain.handle('config:set', async (_e, key, value) => setConfig(key, value));

  ipcMain.handle('log:getAll', async () => getLogEntries());
  ipcMain.handle('log:clear', async () => {
    clearLog();
    return true;
  });

  ipcMain.handle('agent:getStatus', async () => getAgentStatus());
  ipcMain.handle('agent:start', async () => {
    startAgentLoop({
      getAgentBalance,
      getVaultBalance,
      checkAndSweep,
      getConfig,
      addLogEntry,
      emitToRenderer,
      requestNewNovaBrief,
      store,
      connection,
      agentKeypair,
      runStrategies,
    });
  });
  ipcMain.handle('agent:stop', async () => {
    stopAgentLoop();
  });

  ipcMain.handle('nova:getBrief', async () => {
    const result = await getNovaBrief();
    result.actions = store.get('novaActions') || [];
    return result;
  });
  ipcMain.handle('nova:requestNewBrief', async () => requestNewNovaBrief());
  ipcMain.handle('nova:getActions', async () => store.get('novaActions') || []);
  ipcMain.handle('nova:executeAction', async (_e, action) => {
    if (!connection || !agentKeypair) {
      return { success: false, error: 'WALLET_NOT_CONFIGURED' };
    }
    const cfg = getConfig();
    const result = await executeNovaAction({
      action,
      connection,
      agentKeypair,
      config: cfg,
      log: logEntry,
    });
    emitToRenderer('nova:actionResult', result);
    return result;
  });

  // Phase 3b: Risk Manager IPC handlers
  ipcMain.handle('risk:getStatus', async () => {
    const status = getRiskStatus();
    const agentBalance = await getAgentBalance();
    const sessionHigh = status.sessionHigh || agentBalance;
    const drawdownPct = sessionHigh > 0 ? (sessionHigh - agentBalance) / sessionHigh : 0;
    return { ...status, currentBalance: agentBalance, drawdownPct };
  });
  ipcMain.handle('risk:resetSession', async () => {
    const agentBalance = await getAgentBalance();
    resetSession(agentBalance);
    return { sessionHigh: agentBalance, sessionStart: new Date().toISOString() };
  });

  // Phase 2: Strategy IPC handlers
  ipcMain.handle('strategies:getResults', async () => latestStrategyResults);
  ipcMain.handle('strategies:getPositions', async () => {
    return store.get('strategyPositions') || {};
  });

  // Phase 3a: Position + Harvest IPC handlers
  ipcMain.handle('positions:getAll', () => getPositions());
  ipcMain.handle('positions:getByStrategy', (_, id) => getPositions(id));
  ipcMain.handle('harvest:runNow', async () => {
    if (!connection || !agentKeypair) return { error: 'WALLET_NOT_CONFIGURED' };
    return runHarvest({ connection, agentKeypair, log: logEntry, onComplete: null });
  });
  ipcMain.handle('harvest:getLastResult', () => store.get('lastHarvest', null));

  // Phase 4: Price, Portfolio, Report IPC handlers
  ipcMain.handle('price:get', () => getCachedPrice());

  ipcMain.handle('portfolio:getSummary', () => getPortfolioSummary());

  ipcMain.handle('portfolio:getTransactions', () => getTransactionLedger());

  ipcMain.handle('portfolio:exportCSV', async () => {
    const { dialog } = require('electron');
    const ledger = getTransactionLedger();

    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Transaction History',
      defaultPath: `strategos-transactions-${Date.now()}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });

    if (!filePath) return { exported: false, reason: 'CANCELLED' };

    const fs = require('fs');
    const headers = 'ID,Strategy,Type,Amount SOL,TxID,Timestamp\n';
    const rows = ledger.map(e =>
      `${e.id},${e.strategyId},${e.type},${e.amountSol},${e.txid || ''},${e.timestamp}`
    ).join('\n');

    fs.writeFileSync(filePath, headers + rows, 'utf8');
    logEntry('INFO', `EXPORT: Transaction history saved to ${filePath}`, { filePath });
    return { exported: true, filePath };
  });

  ipcMain.handle('report:sendNow', async () => {
    const { agent, vault } = lastKnownBalances;
    return await sendDailyReport({ agentBalance: agent, vaultBalance: vault, sessionPnl: 0, log: logEntry });
  });

  // Emergency Unwind
  ipcMain.handle('agent:unwind', async () => {
    // Stop agent first
    stopAgentLoop();

    let vaultPubkey = null;
    try {
      if (process.env.VAULT_WALLET_PUBLIC_KEY) {
        vaultPubkey = new PublicKey(process.env.VAULT_WALLET_PUBLIC_KEY);
      }
    } catch (_) {}

    return await runUnwind({
      connection,
      agentKeypair,
      vaultPublicKey: vaultPubkey,
      log: logEntry,
      onProgress: (results) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('unwind:progress', results);
        }
      },
    });
  });

  // Tray status updates from renderer
  ipcMain.on('agent:status-update', (_, status) => {
    if (trayStatusUpdater) trayStatusUpdater(status);
  });

  // Auto-launch on Windows startup
  ipcMain.handle('autolaunch:get', () => store.get('autoLaunchEnabled', true));
  ipcMain.handle('autolaunch:set', (_, enabled) => {
    store.set('autoLaunchEnabled', enabled);
    if (process.platform === 'win32') {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: true,
        name: 'Strategos',
        path: process.execPath,
        args: ['--hidden'],
      });
    }
    return { success: true, enabled };
  });

  ipcMain.handle('window:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.handle('window:maximize', () => {
    if (mainWindow) {
      mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    }
  });
  ipcMain.handle('window:close', () => mainWindow && mainWindow.close());
}

// ---------------------------------------------------------------------------
// System Tray
// ---------------------------------------------------------------------------
function setupTray(win) {
  const trayIconPath = path.join(__dirname, 'assets', 'strategos_256.png');
  const trayIcon = nativeImage.createFromPath(trayIconPath).resize({ width: 16, height: 16 });

  tray = new Tray(trayIcon);
  tray.setToolTip('Strategos — Autonomous Field Agent');

  function buildContextMenu(status) {
    return Menu.buildFromTemplate([
      {
        label: 'STRATEGOS',
        enabled: false,
      },
      { type: 'separator' },
      {
        label: 'Open Dashboard',
        click: () => { win.show(); win.focus(); },
      },
      { type: 'separator' },
      {
        label: `Agent: ${status || 'UNKNOWN'}`,
        enabled: false,
      },
      {
        label: 'Start Agent',
        click: () => { win.webContents.send('tray:start-agent'); },
      },
      {
        label: 'Halt Agent',
        click: () => { win.webContents.send('tray:halt-agent'); },
      },
      { type: 'separator' },
      {
        label: 'Manual Sweep',
        click: () => { win.webContents.send('tray:manual-sweep'); },
      },
      { type: 'separator' },
      {
        label: 'Quit Strategos',
        click: () => { app.isQuitting = true; app.quit(); },
      },
    ]);
  }

  tray.setContextMenu(buildContextMenu('UNKNOWN'));

  tray.on('double-click', () => {
    win.show();
    win.focus();
  });

  function updateTrayStatus(status) {
    tray.setContextMenu(buildContextMenu(status));
    tray.setToolTip(`Strategos — Agent ${status || 'UNKNOWN'}`);
  }

  return { updateTrayStatus };
}

// ---------------------------------------------------------------------------
// Auto-launch on Windows startup
// ---------------------------------------------------------------------------
function configureAutoLaunch() {
  if (process.platform === 'win32') {
    const autoLaunchEnabled = store.get('autoLaunchEnabled', true);
    app.setLoginItemSettings({
      openAtLogin: autoLaunchEnabled,
      openAsHidden: true,
      name: 'Strategos',
      path: process.execPath,
      args: ['--hidden'],
    });
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1280,
    minHeight: 760,
    frame: false,
    backgroundColor: '#0d0608',
    show: !isHiddenLaunch,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Set up system tray
  const trayApi = setupTray(mainWindow);
  trayStatusUpdater = trayApi.updateTrayStatus;

  // Close to tray instead of quitting
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();

      // Show tray notification first time
      const hasShownTrayHint = store.get('hasShownTrayHint', false);
      if (!hasShownTrayHint && tray) {
        try {
          tray.displayBalloon({
            iconType: 'info',
            title: 'Strategos is still running',
            content: 'The agent continues operating in the background. Right-click the tray icon to manage it.',
          });
        } catch (_) {}
        store.set('hasShownTrayHint', true);
      }
    }
  });

  if (isHiddenLaunch) {
    mainWindow.hide();
  } else {
    mainWindow.show();
  }
}

app.whenReady().then(() => {
  initWallet();
  registerIPC();
  configureAutoLaunch();
  createWindow();

  // Phase 4: Start price feed — emits price updates to renderer
  startPriceFeed(logEntry, (price) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('price:update', price);
    }
  });

  // Phase 4: Start report scheduler
  startReportScheduler({
    getBalances: () => lastKnownBalances,
    getSessionPnl: () => {
      try {
        const Store = require('electron-store');
        const pnlStore = new Store({ name: 'strategos-pnl' });
        return pnlStore.get('sessionNetSol', 0);
      } catch (_) { return 0; }
    },
    log: logEntry,
  });

  // Auto-start agent loop
  setTimeout(() => {
    startAgentLoop({
      getAgentBalance,
      getVaultBalance,
      checkAndSweep,
      getConfig,
      addLogEntry,
      emitToRenderer,
      requestNewNovaBrief,
      store,
      connection,
      agentKeypair,
      runStrategies,
    });
  }, 2000);
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopAgentLoop();
});

app.on('window-all-closed', () => {
  // Don't quit on window close — tray keeps app alive.
  // Only quit when explicitly told via tray menu (Quit) or before-quit.
  if (app.isQuitting) {
    stopAgentLoop();
    app.quit();
  }
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
