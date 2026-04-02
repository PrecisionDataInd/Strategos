const {
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const { getPositions, closePosition } = require('./positions');
const Store = require('electron-store');

const MSOL_MINT = new PublicKey('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So');
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const FETCH_TIMEOUT_MS = 15000;

function fetchWithTimeout(url, options = {}) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), FETCH_TIMEOUT_MS)
    ),
  ]);
}

async function runUnwind({ connection, agentKeypair, vaultPublicKey, log, onProgress }) {
  const results = {
    steps: [],
    totalRecovered: 0,
    errors: [],
    complete: false,
  };

  function step(label, status, detail) {
    const entry = { label, status, detail, time: new Date().toISOString() };
    results.steps.push(entry);
    log(status === 'OK' ? 'INFO' : status === 'SKIP' ? 'WARN' : 'ERROR',
      `UNWIND [${label}]: ${detail}`, {});
    if (onProgress) onProgress(results);
  }

  // STEP 1: Halt agent (caller is responsible for stopping loop)
  step('HALT', 'OK', 'Agent loop stopped — beginning unwind sequence');

  // STEP 2: Unstake mSOL via Marinade
  try {
    const msolATA = await getAssociatedTokenAddress(MSOL_MINT, agentKeypair.publicKey);
    const msolBalance = await connection.getTokenAccountBalance(msolATA);
    const msolAmount = parseFloat(msolBalance.value.uiAmount || 0);

    if (msolAmount > 0.001) {
      step('UNSTAKE', 'PENDING', `Unstaking ${msolAmount.toFixed(6)} mSOL via Marinade instant unstake`);

      // Use Marinade's instant unstake API
      const unstakeRes = await fetchWithTimeout('https://api.marinade.finance/v1/unstake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msolAmount: Math.floor(msolAmount * 1e9).toString(),
          userPublicKey: agentKeypair.publicKey.toString(),
          instant: true,
        }),
      });

      if (unstakeRes.ok) {
        const unstakeData = await unstakeRes.json();
        const txData = unstakeData?.transaction || unstakeData?.tx;

        if (txData) {
          const txBuf = Buffer.from(txData, 'base64');
          let tx;
          try {
            tx = VersionedTransaction.deserialize(txBuf);
            tx.sign([agentKeypair]);
          } catch {
            tx = Transaction.from(txBuf);
            tx.sign(agentKeypair);
          }
          const txid = await connection.sendRawTransaction(
            tx.serialize(),
            { maxRetries: 3 }
          );
          await connection.confirmTransaction(txid, 'confirmed');
          step('UNSTAKE', 'OK', `${msolAmount.toFixed(6)} mSOL unstaked | txid ${txid.slice(0, 12)}...`);
          results.totalRecovered += msolAmount;
        } else {
          step('UNSTAKE', 'SKIP', 'Marinade API returned no transaction — mSOL will unstake via delayed process');
        }
      } else {
        // Fallback: use Jupiter to swap mSOL → SOL instantly
        step('UNSTAKE', 'PENDING', 'Marinade API unavailable — swapping mSOL → SOL via Jupiter');

        const msolMintStr = MSOL_MINT.toString();
        const amountLamports = Math.floor(msolAmount * 1e9);

        const quoteRes = await fetchWithTimeout(
          `https://lite-api.jup.ag/swap/v1/quote?inputMint=${msolMintStr}&outputMint=${SOL_MINT}&amount=${amountLamports}&slippageBps=100`
        );

        if (quoteRes.ok) {
          const quote = await quoteRes.json();
          if (quote && !quote.error) {
            const swapRes = await fetchWithTimeout('https://lite-api.jup.ag/swap/v1/swap', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                quoteResponse: quote,
                userPublicKey: agentKeypair.publicKey.toString(),
                wrapAndUnwrapSol: true,
              }),
            });

            if (swapRes.ok) {
              const swapData = await swapRes.json();
              const swapTx = swapData?.swapTransaction || swapData?.transaction || swapData?.tx;

              if (swapTx) {
                const txBuf = Buffer.from(swapTx, 'base64');
                const tx = VersionedTransaction.deserialize(txBuf);
                tx.sign([agentKeypair]);
                const txid = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
                await connection.confirmTransaction(txid, 'confirmed');
                const solReceived = parseInt(quote.outAmount || 0) / LAMPORTS_PER_SOL;
                step('UNSTAKE', 'OK', `mSOL → ${solReceived.toFixed(4)} SOL via Jupiter | txid ${txid.slice(0,12)}...`);
                results.totalRecovered += solReceived;
              }
            }
          }
        } else {
          step('UNSTAKE', 'SKIP', 'Could not swap mSOL — please unstake manually via marinade.finance');
        }
      }
    } else {
      step('UNSTAKE', 'SKIP', 'No mSOL balance to unstake');
    }
  } catch (err) {
    step('UNSTAKE', 'ERROR', `Unstake failed: ${err.message}`);
    results.errors.push({ step: 'UNSTAKE', error: err.message });
  }

  // Small delay between steps
  await new Promise(r => setTimeout(r, 2000));

  // STEP 3: Withdraw from lending (Solend)
  try {
    const lendingPositions = getPositions('lending').filter(p => p.status !== 'CLOSED');

    if (lendingPositions.length > 0) {
      const pos = lendingPositions[0];
      step('LENDING', 'PENDING', `Withdrawing ${pos.amountSol?.toFixed(4)} SOL from Solend`);

      if (pos.tracked) {
        // Tracked position — just close the record
        closePosition('lending', pos.id, { exitReason: 'UNWIND', closedAt: new Date().toISOString() });
        step('LENDING', 'SKIP', 'Lending position was tracked locally — record closed. If real deposit exists, withdraw via app.solend.fi');
      } else {
        // Attempt withdrawal via Solend API
        const withdrawRes = await fetchWithTimeout(
          `https://api.solend.fi/v1/actions/withdraw?amount=${Math.floor(pos.amountSol * LAMPORTS_PER_SOL)}&symbol=SOL&pool=main&publicKey=${agentKeypair.publicKey.toString()}`
        );

        if (withdrawRes.ok) {
          const withdrawData = await withdrawRes.json();
          const txData = withdrawData?.transaction || withdrawData?.tx;

          if (txData) {
            const txBuf = Buffer.from(txData, 'base64');
            let tx;
            try {
              tx = VersionedTransaction.deserialize(txBuf);
              tx.sign([agentKeypair]);
            } catch {
              tx = Transaction.from(txBuf);
              tx.sign(agentKeypair);
            }
            const txid = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
            await connection.confirmTransaction(txid, 'confirmed');
            closePosition('lending', pos.id, { exitReason: 'UNWIND', txid, closedAt: new Date().toISOString() });
            step('LENDING', 'OK', `${pos.amountSol?.toFixed(4)} SOL withdrawn | txid ${txid.slice(0,12)}...`);
            results.totalRecovered += pos.amountSol || 0;
          } else {
            step('LENDING', 'SKIP', 'No withdrawal tx returned — withdraw manually at app.solend.fi');
          }
        } else {
          step('LENDING', 'SKIP', `Solend API returned ${withdrawRes.status} — withdraw manually at app.solend.fi`);
        }
      }
    } else {
      step('LENDING', 'SKIP', 'No lending positions to close');
    }
  } catch (err) {
    step('LENDING', 'ERROR', `Lending withdrawal failed: ${err.message}`);
    results.errors.push({ step: 'LENDING', error: err.message });
  }

  await new Promise(r => setTimeout(r, 2000));

  // STEP 4: Close Raydium LP position
  try {
    const lpPositions = getPositions('liquidity').filter(p => p.status !== 'CLOSED');

    if (lpPositions.length > 0) {
      const pos = lpPositions[0];
      step('LP', 'PENDING', 'Closing Raydium CLMM position');

      if (pos.tracked || !pos.txid) {
        closePosition('liquidity', pos.id, { exitReason: 'UNWIND', closedAt: new Date().toISOString() });
        step('LP', 'SKIP', 'LP position was tracked locally — record closed. If real position exists, close via raydium.io');
      } else {
        // Attempt close via Raydium API
        const closeRes = await fetchWithTimeout('https://api-v3.raydium.io/clmm/close-position', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userPublicKey: agentKeypair.publicKey.toString(),
            positionMint: pos.positionMint || pos.txid,
          }),
        });

        if (closeRes.ok) {
          const closeData = await closeRes.json();
          const txData = closeData?.transaction || closeData?.tx;
          if (txData) {
            const txBuf = Buffer.from(txData, 'base64');
            const tx = VersionedTransaction.deserialize(txBuf);
            tx.sign([agentKeypair]);
            const txid = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
            await connection.confirmTransaction(txid, 'confirmed');
            closePosition('liquidity', pos.id, { exitReason: 'UNWIND', txid, closedAt: new Date().toISOString() });
            step('LP', 'OK', `LP position closed | txid ${txid.slice(0,12)}...`);
            results.totalRecovered += pos.amountSol || 0;
          } else {
            closePosition('liquidity', pos.id, { exitReason: 'UNWIND', closedAt: new Date().toISOString() });
            step('LP', 'SKIP', 'No close tx returned — close manually at raydium.io');
          }
        } else {
          closePosition('liquidity', pos.id, { exitReason: 'UNWIND', closedAt: new Date().toISOString() });
          step('LP', 'SKIP', 'Raydium API unavailable — close manually at raydium.io');
        }
      }
    } else {
      step('LP', 'SKIP', 'No LP positions to close');
    }
  } catch (err) {
    step('LP', 'ERROR', `LP close failed: ${err.message}`);
    results.errors.push({ step: 'LP', error: err.message });
  }

  await new Promise(r => setTimeout(r, 2000));

  // STEP 5: Cancel grid orders
  try {
    const gridPositions = getPositions('grid').filter(p => p.status !== 'CLOSED');

    if (gridPositions.length > 0) {
      step('GRID', 'PENDING', `Cancelling ${gridPositions.length} grid order(s)`);

      for (const pos of gridPositions) {
        if (pos.orderId) {
          try {
            const cancelRes = await fetchWithTimeout('https://lite-api.jup.ag/limit/v2/cancelOrders', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                maker: agentKeypair.publicKey.toString(),
                orders: [pos.orderId],
              }),
            });

            if (cancelRes.ok) {
              const cancelData = await cancelRes.json();
              const txData = cancelData?.transaction || cancelData?.tx;
              if (txData) {
                const txBuf = Buffer.from(txData, 'base64');
                const tx = VersionedTransaction.deserialize(txBuf);
                tx.sign([agentKeypair]);
                const txid = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
                await connection.confirmTransaction(txid, 'confirmed');
                step('GRID', 'OK', `Order ${pos.orderId?.slice(0,8)}... cancelled | txid ${txid.slice(0,12)}...`);
              }
            }
          } catch (err) {
            step('GRID', 'WARN', `Could not cancel order ${pos.orderId?.slice(0,8)}...`);
          }
        }
        closePosition('grid', pos.id, { exitReason: 'UNWIND', closedAt: new Date().toISOString() });
      }
      step('GRID', 'OK', `${gridPositions.length} grid position(s) closed`);
    } else {
      step('GRID', 'SKIP', 'No grid orders to cancel');
    }
  } catch (err) {
    step('GRID', 'ERROR', `Grid cancel failed: ${err.message}`);
    results.errors.push({ step: 'GRID', error: err.message });
  }

  await new Promise(r => setTimeout(r, 2000));

  // STEP 6: Convert USDC back to SOL
  try {
    const { getAccount } = require('@solana/spl-token');
    const usdcMintPubkey = new PublicKey(USDC_MINT);
    const usdcATA = await getAssociatedTokenAddress(usdcMintPubkey, agentKeypair.publicKey);

    let usdcAmount = 0;
    try {
      const usdcBalance = await connection.getTokenAccountBalance(usdcATA);
      usdcAmount = parseFloat(usdcBalance.value.uiAmount || 0);
    } catch {
      // No USDC account
    }

    if (usdcAmount > 0.01) {
      step('CONVERT', 'PENDING', `Converting ${usdcAmount.toFixed(2)} USDC → SOL via Jupiter`);

      const usdcLamports = Math.floor(usdcAmount * 1e6);
      const quoteRes = await fetchWithTimeout(
        `https://lite-api.jup.ag/swap/v1/quote?inputMint=${USDC_MINT}&outputMint=${SOL_MINT}&amount=${usdcLamports}&slippageBps=100`
      );

      if (quoteRes.ok) {
        const quote = await quoteRes.json();
        if (quote && !quote.error) {
          const swapRes = await fetchWithTimeout('https://lite-api.jup.ag/swap/v1/swap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              quoteResponse: quote,
              userPublicKey: agentKeypair.publicKey.toString(),
              wrapAndUnwrapSol: true,
            }),
          });

          if (swapRes.ok) {
            const swapData = await swapRes.json();
            const swapTx = swapData?.swapTransaction || swapData?.transaction || swapData?.tx;

            if (swapTx) {
              const txBuf = Buffer.from(swapTx, 'base64');
              const tx = VersionedTransaction.deserialize(txBuf);
              tx.sign([agentKeypair]);
              const txid = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
              await connection.confirmTransaction(txid, 'confirmed');
              const solReceived = parseInt(quote.outAmount || 0) / LAMPORTS_PER_SOL;
              step('CONVERT', 'OK', `${usdcAmount.toFixed(2)} USDC → ${solReceived.toFixed(4)} SOL | txid ${txid.slice(0,12)}...`);
              results.totalRecovered += solReceived;
            }
          }
        }
      } else {
        step('CONVERT', 'SKIP', `${usdcAmount.toFixed(2)} USDC could not be converted — swap manually via Jupiter`);
      }
    } else {
      step('CONVERT', 'SKIP', 'No USDC balance to convert');
    }
  } catch (err) {
    step('CONVERT', 'ERROR', `USDC conversion failed: ${err.message}`);
    results.errors.push({ step: 'CONVERT', error: err.message });
  }

  await new Promise(r => setTimeout(r, 3000));

  // STEP 7: Final sweep — send everything to vault
  try {
    if (!vaultPublicKey) {
      step('SWEEP', 'SKIP', 'No vault address configured — funds remain in agent wallet');
    } else {
      const finalBalance = await connection.getBalance(agentKeypair.publicKey);
      const finalSol = finalBalance / LAMPORTS_PER_SOL;
      const sweepAmount = finalSol - 0.01; // Keep 0.01 SOL for fees

      if (sweepAmount > 0.001) {
        step('SWEEP', 'PENDING', `Sweeping ${sweepAmount.toFixed(4)} SOL to vault`);

        const sweepLamports = Math.floor(sweepAmount * LAMPORTS_PER_SOL);
        const sweepTx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: agentKeypair.publicKey,
            toPubkey: vaultPublicKey,
            lamports: sweepLamports,
          })
        );

        const { blockhash } = await connection.getLatestBlockhash();
        sweepTx.recentBlockhash = blockhash;
        sweepTx.feePayer = agentKeypair.publicKey;
        sweepTx.sign(agentKeypair);

        const txid = await connection.sendRawTransaction(sweepTx.serialize(), { maxRetries: 3 });
        await connection.confirmTransaction(txid, 'confirmed');

        step('SWEEP', 'OK', `${sweepAmount.toFixed(4)} SOL swept to vault | txid ${txid.slice(0,12)}...`);
        results.totalRecovered += sweepAmount;
      } else {
        step('SWEEP', 'SKIP', `Balance too low to sweep (${finalSol.toFixed(4)} SOL)`);
      }
    }
  } catch (err) {
    step('SWEEP', 'ERROR', `Final sweep failed: ${err.message}`);
    results.errors.push({ step: 'SWEEP', error: err.message });
  }

  // STEP 8: Clear all position records
  try {
    const positionStore = new Store({ name: 'strategos-positions' });
    positionStore.clear();
    const riskStore = new Store({ name: 'strategos-risk' });
    riskStore.clear();
    step('CLEANUP', 'OK', 'All position records cleared — Strategos is clean');
  } catch (err) {
    step('CLEANUP', 'ERROR', `Cleanup failed: ${err.message}`);
  }

  results.complete = true;
  log('INFO', `UNWIND COMPLETE: ${results.steps.length} steps | ${results.errors.length} errors | ${results.totalRecovered.toFixed(4)} SOL recovered`, {
    steps: results.steps.length,
    errors: results.errors.length,
    recovered: results.totalRecovered,
  });

  return results;
}

module.exports = { runUnwind };
