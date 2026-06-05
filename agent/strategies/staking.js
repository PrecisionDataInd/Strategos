const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const { savePosition, getOpenPositions, updatePosition } = require('../positions');

const MSOL_MINT = new PublicKey('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So');

let MarinadeUtils, Marinade, MarinadeConfig;
let marinadeAvailable = false;
try {
  const marinadeSdk = require('@marinade.finance/marinade-ts-sdk');
  MarinadeUtils = marinadeSdk.MarinadeUtils;
  Marinade = marinadeSdk.Marinade;
  MarinadeConfig = marinadeSdk.MarinadeConfig;
  marinadeAvailable = true;
  console.log('[STRATEGOS] Staking: Marinade SDK loaded');
} catch (e) {
  console.warn('[STRATEGOS] Staking: Marinade SDK unavailable —', e.message);
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
      const msolATA = await getAssociatedTokenAddress(MSOL_MINT, agentKeypair.publicKey);
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
      profitSol: 0,
      _displayStatus: 'ACTIVE',
    };
  }

  // Wallet-seed check: record an existing on-chain mSOL balance as a
  // position so subsequent ticks treat it as held capital.
  try {
    const msolATA = await getAssociatedTokenAddress(MSOL_MINT, agentKeypair.publicKey);
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
        profitSol: 0,
        openedAt: new Date().toISOString(),
      });
      return {
        success: true,
        reason: 'SEEDED_FROM_WALLET',
        strategy: 'marinade-staking',
        apy: '~8%',
        amountSol: existingMsol,
        profitSol: 0,
        _displayStatus: 'ACTIVE',
      };
    }
  } catch (_) {
    // No mSOL ATA exists — proceed with deposit
  }

  // Hard-fail if the SDK isn't installed. No local-tracking fallback —
  // the agent must not report a successful staking deployment without
  // an actual on-chain transaction.
  if (!marinadeAvailable) {
    log('ERROR',
      'STAKING DISABLED: @marinade.finance/marinade-ts-sdk not installed — run npm install to enable',
      {}
    );
    return {
      success: false,
      reason: 'SDK_NOT_INSTALLED',
      soft: true,
      _displayStatus: 'ERROR',
    };
  }

  try {
    log('INFO',
      `STAKING: depositing ${amountSol.toFixed(4)} SOL into Marinade`,
      { amount: amountSol }
    );

    const cfg = new MarinadeConfig({
      connection,
      publicKey: agentKeypair.publicKey,
    });
    const marinade = new Marinade(cfg);

    const { transaction } = await marinade.deposit(
      MarinadeUtils.solToLamports(amountSol)
    );

    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = agentKeypair.publicKey;
    transaction.sign(agentKeypair);

    const txid = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(txid, 'confirmed');

    savePosition('staking', {
      amountSol,
      entryValueSol: amountSol,
      protocol: 'marinade',
      txid,
      status: 'OPEN',
      apy: '~8%',
      profitSol: 0,
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
      profitSol: 0,
      _displayStatus: 'ACTIVE',
    };
  } catch (err) {
    log('ERROR',
      `STAKING FAILED: ${err.message}`,
      { error: err.message }
    );
    return {
      success: false,
      error: err.message,
      reason: 'TX_FAILED',
      soft: true,
      _displayStatus: 'ERROR',
    };
  }
}

module.exports = { executeStaking };
