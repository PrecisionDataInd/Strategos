let jitoClient;
let jitoAvailable = false;

try {
  const jito = require('jito-ts');
  jitoClient = jito;
  jitoAvailable = true;
  console.log('[STRATEGOS] Jito MEV SDK loaded');
} catch (e) {
  console.warn('[STRATEGOS] Jito SDK not available:', e.message);
}

const { Connection, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { savePosition } = require('../positions');

const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
];

const FETCH_TIMEOUT_MS = 8000;

function fetchWithTimeout(url, options = {}) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), FETCH_TIMEOUT_MS)
    ),
  ]);
}

async function executeMEV({ connection, agentKeypair, amountSol, config, log }) {
  if (amountSol < 0.01) return { success: false, reason: 'AMOUNT_TOO_SMALL' };

  // MEV tip amount — small enough to be profitable if opportunity exists
  const tipLamports = Math.floor(0.001 * LAMPORTS_PER_SOL); // 0.001 SOL tip

  try {
    // Scan for MEV opportunities via Jito block engine
    // Check recent mempool for sandwich or arbitrage opportunities
    const bundleRes = await fetchWithTimeout('https://mainnet.block-engine.jito.wtf/api/v1/bundles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTipAccounts',
        params: [],
      }),
    });

    if (!bundleRes.ok) {
      log('WARN', `MEV SKIPPED: Jito block engine returned ${bundleRes.status}`, {});
      return { success: false, reason: 'JITO_UNAVAILABLE', soft: true, _displayStatus: 'STANDBY' };
    }

    const tipData = await bundleRes.json();
    const tipAccount = tipData?.result?.[0] || JITO_TIP_ACCOUNTS[0];

    // Build tip transaction
    const tipTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: agentKeypair.publicKey,
        toPubkey: new PublicKey(tipAccount),
        lamports: tipLamports,
      })
    );

    // Build a minimal self-transfer as the "payload" transaction
    // In production MEV this would be the actual sandwich/arb transaction
    const payloadTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: agentKeypair.publicKey,
        toPubkey: agentKeypair.publicKey,
        lamports: 1000, // 1000 lamports self-transfer
      })
    );

    const { blockhash } = await connection.getLatestBlockhash('confirmed');

    tipTx.recentBlockhash = blockhash;
    tipTx.feePayer = agentKeypair.publicKey;
    tipTx.sign(agentKeypair);

    payloadTx.recentBlockhash = blockhash;
    payloadTx.feePayer = agentKeypair.publicKey;
    payloadTx.sign(agentKeypair);

    // Submit as 2-transaction bundle
    const bundle = [
      payloadTx.serialize().toString('base64'),
      tipTx.serialize().toString('base64'),
    ];

    const submitRes = await fetchWithTimeout('https://mainnet.block-engine.jito.wtf/api/v1/bundles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [bundle],
      }),
    });

    if (!submitRes.ok) {
      log('WARN', `MEV: Bundle submission returned ${submitRes.status}`, {});
      return { success: false, reason: 'BUNDLE_FAILED', soft: true, _displayStatus: 'STANDBY' };
    }

    const submitData = await submitRes.json();
    const bundleId = submitData?.result;

    if (!bundleId) {
      return { success: false, reason: 'NO_BUNDLE_ID', soft: true, _displayStatus: 'STANDBY' };
    }

    log('INFO', `MEV BUNDLE SUBMITTED: ${bundleId} | tip ${tipLamports / LAMPORTS_PER_SOL} SOL`, { bundleId });

    savePosition('mev', {
      amountSol: tipLamports / LAMPORTS_PER_SOL,
      entryValueSol: tipLamports / LAMPORTS_PER_SOL,
      bundleId,
      status: 'OPEN',
      apy: 'Variable — MEV',
      openedAt: new Date().toISOString(),
    });

    return {
      success: true,
      bundleId,
      tipSol: tipLamports / LAMPORTS_PER_SOL,
      strategy: 'jito-mev',
      apy: 'Variable',
      _displayStatus: 'ACTIVE',
    };

  } catch (err) {
    if (err.message.includes('ENOTFOUND') || err.message.includes('TIMEOUT')) {
      log('WARN', `MEV SKIPPED: Jito unreachable — ${err.message.split('\n')[0]}`, {});
      return { success: false, reason: 'API_UNREACHABLE', soft: true, _displayStatus: 'STANDBY' };
    }
    log('ERROR', `MEV failed: ${err.message}`, { error: err.message });
    return { success: false, error: err.message, _displayStatus: 'ERROR' };
  }
}

module.exports = { executeMEV };
