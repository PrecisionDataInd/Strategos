require('dotenv').config();
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const defaults = require('./config/defaults');
const { startAgentLoop, stopAgentLoop, getAgentStatus } = require('./agent/loop');
const { generateNovaBrief } = require('./agent/nova-engine');

const store = new Store();
let mainWindow = null;
let connection = null;
let agentKeypair = null;
let vaultPublicKey = null;

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
// Sweep logic
// ---------------------------------------------------------------------------
async function checkAndSweep() {
  const cfg = getConfig();
  const balance = await getAgentBalance();

  if (balance < cfg.lossFloorSol) {
    const entry = {
      timestamp: Date.now(),
      level: 'CRITICAL',
      message: `Balance ${balance.toFixed(4)} SOL below loss floor ${cfg.lossFloorSol} SOL — HALTING AGENT`,
    };
    addLogEntry(entry);
    stopAgentLoop();
    emitToRenderer('agent:halted', {});
    return { swept: false, halted: true };
  }

  if (balance >= cfg.sweepThreshold && cfg.autoSweepEnabled) {
    const sweepAmount = balance - cfg.reserveFloor;
    if (sweepAmount <= 0) return { swept: false };

    const txid = 'SIM-' + Date.now();
    const entry = {
      timestamp: Date.now(),
      level: 'SWEEP',
      message: `SWEEP SIMULATED: ${sweepAmount.toFixed(4)} SOL → vault | txid: ${txid}`,
    };
    addLogEntry(entry);

    // PHASE 2: Replace with SystemProgram.transfer() transaction
    return { swept: true, amount: sweepAmount, txid, simulated: true };
  }

  return { swept: false };
}

async function manualSweep() {
  const cfg = getConfig();
  const balance = await getAgentBalance();
  const sweepAmount = balance - cfg.reserveFloor;
  if (sweepAmount <= 0) return { swept: false, reason: 'Insufficient balance after reserve' };

  const txid = 'SIM-MANUAL-' + Date.now();
  const entry = {
    timestamp: Date.now(),
    level: 'SWEEP',
    message: `MANUAL SWEEP SIMULATED: ${sweepAmount.toFixed(4)} SOL → vault | txid: ${txid}`,
  };
  addLogEntry(entry);

  return { swept: true, amount: sweepAmount, txid, simulated: true };
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
    return 'NOVA OFFLINE — API key not configured';
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
    const brief = await generateNovaBrief(context);
    store.set('novaBrief', brief);
    store.set('novaTimestamp', Date.now());
    emitToRenderer('nova:brief', { brief, timestamp: Date.now() });
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
    return cached || 'NOVA OFFLINE — Brief generation failed';
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
    });
  });
  ipcMain.handle('agent:stop', async () => {
    stopAgentLoop();
  });

  ipcMain.handle('nova:getBrief', async () => getNovaBrief());
  ipcMain.handle('nova:requestNewBrief', async () => requestNewNovaBrief());

  ipcMain.handle('window:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.handle('window:maximize', () => {
    if (mainWindow) {
      mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    }
  });
  ipcMain.handle('window:close', () => mainWindow && mainWindow.close());
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  initWallet();
  registerIPC();
  createWindow();

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
    });
  }, 2000);
});

app.on('window-all-closed', () => {
  stopAgentLoop();
  app.quit();
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
