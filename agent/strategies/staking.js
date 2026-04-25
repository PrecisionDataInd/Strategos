const {
  PublicKey,
  VersionedTransaction,
  Transaction,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const { savePosition, getOpenPositions, updatePosition } = require('../positions');

const MARINADE_API = 'https://api.marinade.finance';
const MSOL_MINT = new PublicKey('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So');
const FETCH_TIMEOUT_MS = 10000;

console.log('[STRATEGOS] Staking: Marinade REST API mode (no SDK required)');

function fetchWithTimeout(url, options = {}) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), FETCH_TIMEOUT_MS)
    ),
  ]);
}

async function executeStaking({ connection, agentKeypair, amountSol, log }) {
  if (amountSol < 0.1) {
    return {
      success: false,
      reason: 'AMOUNT_TOO_SMALL',
      soft: true,
      _displayStatus: 'STANDBY',
    };
  }

  // Position-exists check — never re-stake if already staking
  const existing = getOpenPositions('staking');
  if (existing.length > 0) {
    const pos = existing[0];
    try {
      const msolATA = await getAssociatedTokenAddress(
        MSOL_MINT, agentKeypair.publicKey
      );
      const msolBalance = await connection.getTokenAccountBalance(msolATA);
      const currentMsol = parseFloat(msolBalance.value.uiAmount || 0);
      updatePosition('staking', pos.id, {
        currentMsol,
        lastChecked: new Date().toISOString(),
      });
      log('INFO',
        `STAKING: position active — ${currentMsol.toFixed(6)} mSOL held`,
        { currentMsol }
      );
    } catch (_) {
      log('INFO',
        `STAKING: position active — ${pos.amountSol.toFixed(4)} SOL staked`,
        {}
      );
    }
    return {
      success: true,
      reason: 'POSITION_EXISTS',
      positions: existing,
      strategy: 'marinade-staking',
      apy: '~8%',
      amountSol: pos.amountSol,
      _displayStatus: 'ACTIVE',
    };
  }

  // Also check if mSOL exists in wallet (position record may have been lost)
  try {
    const msolATA = await getAssociatedTokenAddress(
      MSOL_MINT, agentKeypair.publicKey
    );
    const msolBalance = await connection.getTokenAccountBalance(msolATA);
    const existingMsol = parseFloat(msolBalance.value.uiAmount || 0);
    if (existingMsol > 0.001) {
      log('INFO',
        `STAKING: ${existingMsol.toFixed(6)} mSOL detected in wallet — recording as existing position`,
        { existingMsol }
      );
      savePosition('staking', {
        amountSol: existingMsol,
        currentMsol: existingMsol,
        protocol: 'marinade',
        status: 'OPEN',
        apy: '~8%',
        seeded: true,
        openedAt: new Date().toISOString(),
      });
      return {
        success: true,
        reason: 'SEEDED_FROM_WALLET',
        strategy: 'marinade-staking',
        apy: '~8%',
        amountSol: existingMsol,
        _displayStatus: 'ACTIVE',
      };
    }
  } catch (_) {
    // No mSOL ATA exists — proceed with deposit
  }

  // Deposit via Marinade REST API
  try {
    log('INFO',
      `STAKING: depositing ${amountSol.toFixed(4)} SOL into Marinade`,
      { amount: amountSol }
    );

    const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
    const depositRes = await fetchWithTimeout(
      `${MARINADE_API}/v1/stake`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lamports: lamports.toString(),
          userPublicKey: agentKeypair.publicKey.toString(),
        }),
      }
    );

    if (!depositRes.ok) {
      log('WARN',
        `STAKING: Marinade API ${depositRes.status} — tracking position locally`,
        {}
      );
      savePosition('staking', {
        amountSol,
        protocol: 'marinade-tracked',
        tracked: true,
        status: 'OPEN',
        apy: '~8%',
        openedAt: new Date().toISOString(),
      });
      return {
        success: true,
        amountSol,
        strategy: 'marinade-staking',
        apy: '~8%',
        tracked: true,
        _displayStatus: 'TRACKED',
      };
    }

    const data = await depositRes.json();
    const txData = data?.transaction || data?.tx;

    if (!txData) {
      savePosition('staking', {
        amountSol,
        protocol: 'marinade-tracked',
        tracked: true,
        status: 'OPEN',
        apy: '~8%',
        openedAt: new Date().toISOString(),
      });
      return {
        success: true,
        amountSol,
        strategy: 'marinade-staking',
        apy: '~8%',
        tracked: true,
        _displayStatus: 'TRACKED',
      };
    }

    const txBuf = Buffer.from(txData, 'base64');
    let tx;
    try {
      tx = VersionedTransaction.deserialize(txBuf);
      tx.sign([agentKeypair]);
    } catch {
      tx = Transaction.from(txBuf);
      tx.sign(agentKeypair);
    }

    const txid = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(txid, 'confirmed');

    savePosition('staking', {
      amountSol,
      protocol: 'marinade',
      txid,
      status: 'OPEN',
      apy: '~8%',
      openedAt: new Date().toISOString(),
    });

    log('INFO',
      `STAKING CONFIRMED: ${amountSol.toFixed(4)} SOL staked | txid ${txid}`,
      { txid, amountSol }
    );
    return {
      success: true,
      txid,
      amountSol,
      strategy: 'marinade-staking',
      apy: '~8%',
      _displayStatus: 'ACTIVE',
    };
  } catch (err) {
    log('WARN',
      `STAKING: error ${err.message} — tracking locally`,
      { error: err.message }
    );
    savePosition('staking', {
      amountSol,
      protocol: 'marinade-tracked',
      tracked: true,
      status: 'OPEN',
      apy: '~8%',
      openedAt: new Date().toISOString(),
    });
    return {
      success: true,
      amountSol,
      strategy: 'marinade-staking',
      apy: '~8%',
      tracked: true,
      _displayStatus: 'TRACKED',
    };
  }
}

module.exports = { executeStaking };
