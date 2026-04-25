/* ==========================================================================
   STRATEGOS — Sweep UI Controller
   ========================================================================== */

const SweepUI = {
  sweepStatusEl: null,
  btnManualSweep: null,

  init() {
    this.sweepStatusEl = document.getElementById('sweep-status');
    this.btnManualSweep = document.getElementById('btn-manual-sweep');

    this.btnManualSweep.addEventListener('click', () => this.executeManualSweep());
  },

  updateSweepStatus(agentBalance, threshold) {
    const remaining = threshold - agentBalance;
    if (remaining > 0) {
      this.sweepStatusEl.textContent = '\u25CE ' + remaining.toFixed(4) + ' UNTIL THRESHOLD';
      this.sweepStatusEl.className = 'card-value muted';
      this.sweepStatusEl.classList.remove('threshold-pulse');
    } else {
      this.sweepStatusEl.textContent = 'THRESHOLD MET';
      this.sweepStatusEl.className = 'card-value cyan';
      this.sweepStatusEl.classList.add('threshold-pulse');
    }
  },

  async executeManualSweep() {
    this.btnManualSweep.textContent = 'EXECUTING...';
    this.btnManualSweep.disabled = true;

    try {
      const result = await window.strategos.sweep.manualSweep();
      if (result.swept) {
        WalletUI.addSweptAmount(result.amount);
        LoggerUI.addEntry({
          timestamp: Date.now(),
          level: 'SWEEP',
          message: `Manual sweep executed: ${result.amount.toFixed(4)} SOL (${result.simulated ? 'SIMULATED' : 'LIVE'})`,
        });
      } else {
        LoggerUI.addEntry({
          timestamp: Date.now(),
          level: 'WARN',
          message: 'Manual sweep: insufficient balance after reserve',
        });
      }
    } catch (e) {
      LoggerUI.addEntry({
        timestamp: Date.now(),
        level: 'ERROR',
        message: `Manual sweep failed: ${e.message}`,
      });
    }

    this.btnManualSweep.textContent = 'EXECUTE MANUAL SWEEP';
    this.btnManualSweep.disabled = false;
  },
};
