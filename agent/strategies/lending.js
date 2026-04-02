const { PublicKey } = require('@solana/web3.js');
const { getOpenPositions, savePosition, updatePosition } = require('../positions');

// Kamino lending program and SOL reserve (mainnet)
const KAMINO_PROGRAM_ID = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const SOL_RESERVE = new PublicKey('d4A2prbA2whesmvHaL88BH6Ewn5N4bJ6L67gHRCBs5S');
const KAMINO_MAIN_MARKET = new PublicKey('7u3HeL2X9J3bRZs3CtdKqhm5qHs2V2GBGSiHhG3yLMo');

const FETCH_TIMEOUT_MS = 8000;

function fetchWithTimeout(url, options = {}) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), FETCH_TIMEOUT_MS)
    ),
  ]);
}

async function executeLending({ connection, agentKeypair, amountSol, log }) {
  if (amountSol < 0.1) return { success: false, reason: 'AMOUNT_TOO_SMALL' };

  // Check existing lending positions
  const existingPositions = getOpenPositions('lending');
  if (existingPositions.length > 0) {
    log('INFO', `LENDING: ${existingPositions.length} position(s) active — checking accrued interest`, { count: existingPositions.length });

    // Fetch current obligation to get updated balance
    try {
      const obligationRes = await fetchWithTimeout(
        `https://api.kamino.finance/v2/obligations/${agentKeypair.publicKey.toString()}`
      );
      if (obligationRes.ok) {
        const obligationData = await obligationRes.json();
        const solObligation = obligationData?.deposits?.find(d => d.mint === 'So11111111111111111111111111111111111111112');
        if (solObligation) {
          const currentBalance = parseFloat(solObligation.amount);
          const deposited = existingPositions[0].amountSol;
          const earned = currentBalance - deposited;
          updatePosition('lending', existingPositions[0].id, {
            currentBalance,
            earnedSol: earned,
            lastChecked: new Date().toISOString(),
          });
          log('INFO', `LENDING POSITION: ${currentBalance.toFixed(6)} SOL deposited | earned ${earned.toFixed(6)} SOL`, { currentBalance, earned });
        }
      }
    } catch (err) {
      log('WARN', `LENDING: could not fetch obligation status — ${err.message}`, { error: err.message });
    }

    return { success: true, reason: 'POSITION_EXISTS', positions: existingPositions, strategy: 'kamino-lending' };
  }

  try {
    // Use Kamino API to get deposit transaction
    log('INFO', `LENDING: depositing ${amountSol.toFixed(4)} SOL into Kamino SOL market`, { amount: amountSol });

    const depositRes = await fetchWithTimeout('https://api.kamino.finance/v2/actions/deposit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: agentKeypair.publicKey.toString(),
        reserve: SOL_RESERVE.toString(),
        amount: Math.floor(amountSol * 1e9).toString(),
        market: KAMINO_MAIN_MARKET.toString(),
      }),
    });

    if (!depositRes.ok) {
      throw new Error(`Kamino API returned ${depositRes.status}`);
    }

    const depositData = await depositRes.json();

    if (!depositData.transaction) {
      throw new Error('No transaction in Kamino deposit response');
    }

    // Deserialize, sign and send
    const { VersionedTransaction } = require('@solana/web3.js');
    const txBuf = Buffer.from(depositData.transaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([agentKeypair]);

    const txid = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(txid, 'confirmed');

    const position = {
      amountSol,
      txid,
      reserve: SOL_RESERVE.toString(),
      market: KAMINO_MAIN_MARKET.toString(),
      status: 'OPEN',
      apy: '~6.5%',
    };
    savePosition('lending', position);

    log('INFO', `LENDING CONFIRMED: ${amountSol.toFixed(4)} SOL deposited into Kamino | txid ${txid}`, { txid });
    return { success: true, txid, amountSol, strategy: 'kamino-lending', apy: '~6.5%' };

  } catch (err) {
    log('ERROR', `Lending failed: ${err.message}`, { error: err.message });
    return { success: false, error: err.message };
  }
}

module.exports = { executeLending };
