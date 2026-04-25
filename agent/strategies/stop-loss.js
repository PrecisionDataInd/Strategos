const { getPositions, closePosition, updatePosition } = require('../positions');
const { registerStopLoss } = require('../cooldown-tracker');

const STOP_LOSS_PCT = 0.05; // 5%

async function runStopLossCheck({ connection, log }) {
  const allPositions = getPositions();
  const exits = [];

  for (const [strategyId, posArray] of Object.entries(allPositions)) {
    const openPositions = posArray.filter(p => p.status !== 'CLOSED');

    for (const pos of openPositions) {
      if (!pos.entryValueSol || pos.entryValueSol <= 0) continue;

      const currentValue = pos.currentValueSol || pos.currentMsol || pos.currentBalance || pos.amountSol;
      if (!currentValue) continue;

      const drawdownPct = (pos.entryValueSol - currentValue) / pos.entryValueSol;

      if (drawdownPct >= STOP_LOSS_PCT) {
        log('WARN',
          `STOP-LOSS: ${strategyId} position down ${(drawdownPct * 100).toFixed(2)}% — marking for exit`,
          { strategyId, positionId: pos.id, drawdownPct, entryValueSol: pos.entryValueSol, currentValue }
        );

        closePosition(strategyId, pos.id, {
          exitReason: 'STOP_LOSS',
          exitDrawdownPct: drawdownPct,
          closedAt: new Date().toISOString(),
        });

        registerStopLoss(strategyId);
        log('WARN',
          `COOLDOWN: ${strategyId} entering 30-minute cooldown after stop-loss`,
          { strategyId }
        );

        exits.push({ strategyId, positionId: pos.id, drawdownPct });
      }
    }
  }

  if (exits.length > 0) {
    log('WARN', `STOP-LOSS: ${exits.length} position(s) closed this tick`, { exits });
  }

  return { exitsTriggered: exits.length, exits };
}

module.exports = { runStopLossCheck };
