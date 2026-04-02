const { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');

async function executeLiveSweep({ connection, agentKeypair, vaultPublicKey, sweepAmountSol, log }) {
  const sweepLamports = Math.floor(sweepAmountSol * LAMPORTS_PER_SOL);

  // Safety check: never sweep below 1000 lamports
  if (sweepLamports < 1000) {
    log('WARN', 'Sweep amount too small, skipping', { sweepLamports });
    return { swept: false, reason: 'AMOUNT_TOO_SMALL' };
  }

  // Build transaction
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: agentKeypair.publicKey,
      toPubkey: vaultPublicKey,
      lamports: sweepLamports,
    })
  );

  // Log intent before broadcasting
  log('SWEEP', `EXECUTING LIVE SWEEP: ${sweepAmountSol.toFixed(4)} SOL \u2192 ${vaultPublicKey.toString().slice(0, 8)}...`, {
    amount: sweepAmountSol,
    destination: vaultPublicKey.toString(),
    lamports: sweepLamports
  });

  try {
    const txid = await sendAndConfirmTransaction(connection, transaction, [agentKeypair], {
      commitment: 'confirmed',
      maxRetries: 3,
    });

    log('SWEEP', `SWEEP CONFIRMED: txid ${txid}`, { txid, amount: sweepAmountSol });
    return { swept: true, amount: sweepAmountSol, txid, simulated: false };
  } catch (err) {
    log('ERROR', `SWEEP FAILED: ${err.message}`, { error: err.message });
    return { swept: false, reason: 'TX_FAILED', error: err.message };
  }
}

module.exports = { executeLiveSweep };
