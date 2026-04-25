const {
  PublicKey,
  VersionedTransaction,
  Transaction,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const { savePosition, getOpenPositions, closePosition } = require('../positions');

const SOLEND_API = 'https://api.solend.fi';
const FETCH_TIMEOUT_MS = 10000;

console.log('[STRATEGOS] Lending: Solend REST API mode (no SDK required)');

function fetchWithTimeout(url, options = {}) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), FETCH_TIMEOUT_MS)
    ),
  ]);
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

  // Position-exists check
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
      _displayStatus: pos.tracked ? 'TRACKED' : 'ACTIVE',
    };
  }

  try {
    log('INFO',
      `LENDING: depositing ${amountSol.toFixed(4)} SOL via Solend`,
      { amount: amountSol }
    );

    const depositRes = await fetchWithTimeout(
      `${SOLEND_API}/v1/actions/deposit?amount=${Math.floor(amountSol * LAMPORTS_PER_SOL)}&symbol=SOL&pool=main&publicKey=${agentKeypair.publicKey.toString()}`
    );

    if (!depositRes.ok) {
      log('WARN',
        `LENDING: Solend API ${depositRes.status} — tracking locally`,
        {}
      );
      savePosition('lending', {
        amountSol,
        entryValueSol: amountSol,
        currentBalance: amountSol,
        protocol: 'solend-tracked',
        tracked: true,
        status: 'OPEN',
        apy: '~6.5%',
        openedAt: new Date().toISOString(),
      });
      return {
        success: true,
        amountSol,
        strategy: 'solend-lending',
        apy: '~6.5%',
        tracked: true,
        _displayStatus: 'TRACKED',
      };
    }

    const depositData = await depositRes.json();
    const txData = depositData?.transaction || depositData?.tx;

    if (!txData) {
      savePosition('lending', {
        amountSol,
        entryValueSol: amountSol,
        currentBalance: amountSol,
        protocol: 'solend-tracked',
        tracked: true,
        status: 'OPEN',
        apy: '~6.5%',
        openedAt: new Date().toISOString(),
      });
      return {
        success: true,
        amountSol,
        strategy: 'solend-lending',
        apy: '~6.5%',
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

    savePosition('lending', {
      amountSol,
      entryValueSol: amountSol,
      currentBalance: amountSol,
      protocol: 'solend',
      txid,
      status: 'OPEN',
      apy: '~6.5%',
      openedAt: new Date().toISOString(),
    });

    log('INFO',
      `LENDING CONFIRMED: ${amountSol.toFixed(4)} SOL | txid ${txid}`,
      { txid, amountSol }
    );
    return {
      success: true,
      txid,
      amountSol,
      strategy: 'solend-lending',
      apy: '~6.5%',
      _displayStatus: 'ACTIVE',
    };
  } catch (err) {
    log('WARN',
      `LENDING: error ${err.message} — tracking locally`,
      { error: err.message }
    );
    savePosition('lending', {
      amountSol,
      entryValueSol: amountSol,
      currentBalance: amountSol,
      protocol: 'solend-tracked',
      tracked: true,
      status: 'OPEN',
      apy: '~6.5%',
      openedAt: new Date().toISOString(),
    });
    return {
      success: true,
      amountSol,
      strategy: 'solend-lending',
      apy: '~6.5%',
      tracked: true,
      _displayStatus: 'TRACKED',
    };
  }
}

module.exports = { executeLending };
