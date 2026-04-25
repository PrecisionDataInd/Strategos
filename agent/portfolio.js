const { getPositions } = require('./positions');
const { getCachedPrice } = require('./price-feed');

function getPortfolioSummary() {
  const positions = getPositions();
  const price = getCachedPrice();
  const solPrice = price.usd || 0;

  const summary = {
    totalDeployedSol: 0,
    totalDeployedUsd: 0,
    positions: [],
    byStrategy: {},
  };

  for (const [strategyId, posArray] of Object.entries(positions)) {
    const openPositions = posArray.filter(p => p.status !== 'CLOSED');

    for (const pos of openPositions) {
      const currentValueSol = pos.currentMsol || pos.currentBalance || pos.amountSol || 0;
      const entryValueSol = pos.amountSol || 0;
      const unrealizedSol = currentValueSol - entryValueSol;
      const unrealizedUsd = unrealizedSol * solPrice;
      const currentValueUsd = currentValueSol * solPrice;
      const entryValueUsd = entryValueSol * solPrice;
      const daysOpen = pos.openedAt
        ? Math.floor((Date.now() - new Date(pos.openedAt).getTime()) / (1000 * 60 * 60 * 24))
        : 0;

      const posRecord = {
        id: pos.id,
        strategyId,
        strategyName: getStrategyDisplayName(strategyId),
        entryValueSol,
        entryValueUsd,
        currentValueSol,
        currentValueUsd,
        unrealizedSol,
        unrealizedUsd,
        unrealizedPct: entryValueSol > 0 ? (unrealizedSol / entryValueSol) * 100 : 0,
        apy: pos.apy || '—',
        daysOpen,
        openedAt: pos.openedAt,
        txid: pos.txid,
        tracked: pos.tracked || false,
        status: pos.status,
      };

      summary.positions.push(posRecord);
      summary.totalDeployedSol += currentValueSol;
      summary.totalDeployedUsd += currentValueUsd;

      if (!summary.byStrategy[strategyId]) {
        summary.byStrategy[strategyId] = { deployedSol: 0, deployedUsd: 0, unrealizedSol: 0 };
      }
      summary.byStrategy[strategyId].deployedSol += currentValueSol;
      summary.byStrategy[strategyId].deployedUsd += currentValueUsd;
      summary.byStrategy[strategyId].unrealizedSol += unrealizedSol;
    }
  }

  return summary;
}

function getStrategyDisplayName(id) {
  const names = {
    staking: 'Liquid Staking',
    lending: 'Lending Desk',
    liquidity: 'Liquidity Provision',
    arbitrage: 'Arbitrage',
    grid: 'Grid Trading',
  };
  return names[id] || id;
}

function getTransactionLedger() {
  const Store = require('electron-store');
  const store = new Store({ name: 'strategos-pnl' });
  return store.get('ledger', []);
}

module.exports = { getPortfolioSummary, getTransactionLedger };
