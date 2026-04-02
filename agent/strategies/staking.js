const { MarinadeUtils, Marinade, MarinadeConfig } = require('@marinade.finance/marinade-ts-sdk');
const { PublicKey } = require('@solana/web3.js');

async function executeStaking({ connection, agentKeypair, amountSol, log }) {
  if (amountSol < 0.1) return { success: false, reason: 'AMOUNT_TOO_SMALL' };

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

    log('INFO', `STAKING CONFIRMED: ${amountSol.toFixed(4)} SOL staked | txid ${txid}`, { txid });
    return { success: true, txid, amountSol, strategy: 'marinade-staking', apy: '~8%' };

  } catch (err) {
    log('ERROR', `Staking failed: ${err.message}`, { error: err.message });
    return { success: false, error: err.message };
  }
}

module.exports = { executeStaking };
