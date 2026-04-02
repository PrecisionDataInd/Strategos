const { PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const { getOpenPositions, updatePosition } = require('../positions');

// mSOL token mint (mainnet)
const MSOL_MINT = new PublicKey('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So');

async function harvestStaking({ connection, agentKeypair, log }) {
  try {
    // Get mSOL token account balance
    const msolATA = await getAssociatedTokenAddress(MSOL_MINT, agentKeypair.publicKey);
    const msolBalance = await connection.getTokenAccountBalance(msolATA);
    const msolAmount = parseFloat(msolBalance.value.uiAmount || 0);

    const openPositions = getOpenPositions('staking');

    if (openPositions.length > 0) {
      const pos = openPositions[0];
      const previousMsol = pos.currentMsol || pos.amountSol;
      const msolGrowth = msolAmount - previousMsol;

      updatePosition('staking', pos.id, {
        currentMsol: msolAmount,
        msolGrowth: (pos.msolGrowth || 0) + Math.max(0, msolGrowth),
        lastChecked: new Date().toISOString(),
      });

      log('INFO', `STAKING: mSOL balance ${msolAmount.toFixed(6)} | growth ${msolGrowth.toFixed(6)} mSOL`, {
        msolAmount, msolGrowth
      });
    } else {
      log('INFO', `STAKING: mSOL balance ${msolAmount.toFixed(6)}`, { msolAmount });
    }

    return { harvested: false, msolAmount, note: 'mSOL appreciates automatically — no claim needed' };

  } catch (err) {
    log('WARN', `Staking harvest check failed: ${err.message}`, { error: err.message });
    return { harvested: false, error: err.message };
  }
}

module.exports = { harvestStaking };
