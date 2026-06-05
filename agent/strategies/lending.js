const { PublicKey } = require('@solana/web3.js');
const { savePosition, getOpenPositions, closePosition } = require('../positions');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOLEND_POOL = 'main';

let SolendAction;
let solendAvailable = false;
try {
  const solendSdk = require('@solendprotocol/solend-sdk');
  SolendAction = solendSdk.SolendAction;
  solendAvailable = true;
  console.log('[STRATEGOS] Lending: Solend SDK loaded');
} catch (e) {
  console.warn('[STRATEGOS] Lending: Solend SDK unavailable —', e.message);
}

async function executeLending({ connection, agentKeypair, amountSol, log }) {
  if (amountSol < 0.1) {
    return {
      success: false,
      reason: 'AMOUNT_TOO_SMALL',
      soft: true,
      _displayStatus: 'STANDBY',
    };
  }

  const existing = getOpenPositions('lending');
  if (existing.length > 0) {
    const pos = existing[0];
    if (pos.entryValueSol && pos.currentBalance) {
      const drawdown = (pos.entryValueSol - pos.currentBalance) / pos.entryValueSol;
      if (drawdown >= 0.05) {
        log('WARN',
          `LENDING: stop-loss ${(drawdown * 100).toFixed(2)}% — closing`,
          { drawdown }
        );
        closePosition('lending', pos.id, {
          exitReason: 'STOP_LOSS',
          closedAt: new Date().toISOString(),
        });
        return {
          success: true,
          exited: true,
          reason: 'STOP_LOSS',
          profitSol: 0,
          _displayStatus: 'STANDBY',
        };
      }
    }
    log('INFO',
      `LENDING: ${existing.length} position(s) active`,
      {}
    );
    return {
      success: true,
      reason: 'POSITION_EXISTS',
      positions: existing,
      strategy: 'solend-lending',
      apy: '~6.5%',
      amountSol: pos.amountSol,
      profitSol: 0,
      _displayStatus: 'ACTIVE',
    };
  }

  if (!solendAvailable) {
    log('ERROR',
      'LENDING DISABLED: @solendprotocol/solend-sdk not installed — run npm install to enable',
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
      `LENDING: depositing ${amountSol.toFixed(4)} SOL into Solend`,
      { amount: amountSol }
    );

    const solendAction = await SolendAction.buildDepositTxns(
      connection,
      Math.floor(amountSol * 1e9).toString(),
      SOL_MINT,
      agentKeypair.publicKey,
      SOLEND_POOL,
      'production'
    );

    const { lendingInstructions } = await solendAction.getTransactions();
    let lastTxid;
    for (const tx of lendingInstructions) {
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      tx.feePayer = agentKeypair.publicKey;
      tx.sign(agentKeypair);
      const txid = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
      await connection.confirmTransaction(txid, 'confirmed');
      lastTxid = txid;
      log('INFO',
        `LENDING CONFIRMED: ${amountSol.toFixed(4)} SOL into Solend | txid ${txid}`,
        { txid }
      );
    }

    savePosition('lending', {
      amountSol,
      entryValueSol: amountSol,
      currentBalance: amountSol,
      protocol: 'solend',
      txid: lastTxid,
      status: 'OPEN',
      apy: '~6.5%',
      profitSol: 0,
      openedAt: new Date().toISOString(),
    });

    return {
      success: true,
      txid: lastTxid,
      amountSol,
      strategy: 'solend-lending',
      apy: '~6.5%',
      profitSol: 0,
      _displayStatus: 'ACTIVE',
    };
  } catch (err) {
    log('ERROR',
      `LENDING FAILED: ${err.message}`,
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

module.exports = { executeLending };
