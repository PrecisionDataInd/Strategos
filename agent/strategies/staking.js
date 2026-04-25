let MarinadeUtils, Marinade, MarinadeConfig;
let marinadeAvailable = false;

try {
  const marinadeSdk = require('@marinade.finance/marinade-ts-sdk');
  MarinadeUtils = marinadeSdk.MarinadeUtils;
  Marinade = marinadeSdk.Marinade;
  MarinadeConfig = marinadeSdk.MarinadeConfig;
  marinadeAvailable = true;
} catch (e) {
  // SDK not installed
}

const { PublicKey } = require('@solana/web3.js');
const { savePosition, getOpenPositions, updatePosition } = require('../positions');

async function executeStaking({ connection, agentKeypair, amountSol, log }) {
  if (!marinadeAvailable) {
    log('WARN', 'STAKING SKIPPED: marinade-ts-sdk not available', {});
    return { success: false, reason: 'SDK_NOT_INSTALLED', soft: true };
  }

  if (amountSol < 0.1) return { success: false, reason: 'AMOUNT_TOO_SMALL' };

  // CHECK FOR EXISTING POSITION — do not stake again if already staked
  const existingPositions = getOpenPositions('staking');
  if (existingPositions.length > 0) {
    const pos = existingPositions[0];

    // Fetch current mSOL balance to track growth
    try {
      const { getAssociatedTokenAddress } = require('@solana/spl-token');
      const MSOL_MINT = new PublicKey('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So');
      const msolATA = await getAssociatedTokenAddress(MSOL_MINT, agentKeypair.publicKey);
      const msolBalance = await connection.getTokenAccountBalance(msolATA);
      const currentMsol = parseFloat(msolBalance.value.uiAmount || 0);

      updatePosition('staking', pos.id, {
        currentMsol,
        lastChecked: new Date().toISOString(),
      });

      log('INFO', `STAKING: position active — ${currentMsol.toFixed(6)} mSOL held`, { currentMsol });
    } catch (err) {
      log('INFO', `STAKING: position active — ${pos.amountSol.toFixed(4)} SOL staked`, { amount: pos.amountSol });
    }

    return {
      success: true,
      reason: 'POSITION_EXISTS',
      positions: existingPositions,
      strategy: 'marinade-staking',
      apy: '~8%',
      _displayStatus: 'ACTIVE',
    };
  }

  // NO EXISTING POSITION — stake for the first time
  try {
    const config = new MarinadeConfig({
      connection,
      publicKey: agentKeypair.publicKey,
    });
    const marinade = new Marinade(config);

    const { transaction } = await marinade.deposit(
      MarinadeUtils.solToLamports(amountSol)
    );

    log('INFO', `STAKING: depositing ${amountSol.toFixed(4)} SOL into Marinade`, { amount: amountSol });

    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = agentKeypair.publicKey;
    transaction.sign(agentKeypair);

    const txid = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(txid, 'confirmed');

    // SAVE POSITION so future ticks see it and skip re-staking
    const position = {
      amountSol,
      txid,
      status: 'OPEN',
      apy: '~8%',
      openedAt: new Date().toISOString(),
    };
    savePosition('staking', position);

    log('INFO', `STAKING CONFIRMED: ${amountSol.toFixed(4)} SOL staked | txid ${txid}`, { txid });
    return {
      success: true,
      txid,
      amountSol,
      strategy: 'marinade-staking',
      apy: '~8%',
      _displayStatus: 'ACTIVE',
    };

  } catch (err) {
    log('ERROR', `Staking failed: ${err.message}`, { error: err.message });
    return { success: false, error: err.message };
  }
}

module.exports = { executeStaking };
