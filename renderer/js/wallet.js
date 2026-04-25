/* ==========================================================================
   STRATEGOS — Wallet UI Controller
   ========================================================================== */

const WalletUI = {
  agentBalanceEl: null,
  vaultBalanceEl: null,
  agentAddressEl: null,
  vaultAddressEl: null,
  rpcBadgeEl: null,
  thresholdProgressEl: null,
  thresholdDisplayEl: null,
  reserveDisplayEl: null,
  sessionBaselineEl: null,
  sessionPnlEl: null,
  sessionPnlPctEl: null,
  sessionSweptEl: null,

  lastAgentBalance: null,
  lastVaultBalance: null,
  sessionBaseline: null,
  totalSwept: 0,

  init() {
    this.agentBalanceEl = document.getElementById('agent-balance');
    this.vaultBalanceEl = document.getElementById('vault-balance');
    this.agentAddressEl = document.getElementById('agent-address');
    this.vaultAddressEl = document.getElementById('vault-address');
    this.rpcBadgeEl = document.getElementById('rpc-badge');
    this.thresholdProgressEl = document.getElementById('threshold-progress');
    this.thresholdDisplayEl = document.getElementById('threshold-display');
    this.reserveDisplayEl = document.getElementById('reserve-display');
    this.sessionBaselineEl = document.getElementById('session-baseline');
    this.sessionPnlEl = document.getElementById('session-pnl');
    this.sessionPnlPctEl = document.getElementById('session-pnl-pct');
    this.sessionSweptEl = document.getElementById('session-swept');

    // Copy address on click
    this.agentAddressEl.addEventListener('click', () => this.copyAddress('agent'));
    this.vaultAddressEl.addEventListener('click', () => this.copyAddress('vault'));

    this.loadAddresses();
    this.loadBalances();
  },

  async loadAddresses() {
    try {
      const agentPub = await window.strategos.wallet.getAgentPublicKey();
      const vaultPub = await window.strategos.wallet.getVaultPublicKey();

      if (agentPub) {
        this.agentAddressEl.querySelector('.addr-value').textContent =
          agentPub.slice(0, 6) + '...' + agentPub.slice(-6);
        this.agentAddressEl.dataset.full = agentPub;
      } else {
        this.agentAddressEl.querySelector('.addr-value').textContent = 'NOT CONFIGURED';
      }

      if (vaultPub) {
        this.vaultAddressEl.querySelector('.addr-value').textContent =
          vaultPub.slice(0, 6) + '...' + vaultPub.slice(-6);
        this.vaultAddressEl.dataset.full = vaultPub;
      } else {
        this.vaultAddressEl.querySelector('.addr-value').textContent = 'NOT CONFIGURED';
      }
    } catch (e) {
      console.error('Failed to load addresses:', e);
    }
  },

  async loadBalances() {
    try {
      const agentBal = await window.strategos.wallet.getAgentBalance();
      const vaultBal = await window.strategos.wallet.getVaultBalance();
      this.updateBalances(agentBal, vaultBal);
    } catch (e) {
      console.error('Failed to load balances:', e);
      this.rpcBadgeEl.className = 'rpc-badge offline';
      this.rpcBadgeEl.textContent = 'OFFLINE';
    }
  },

  updateBalances(agentBal, vaultBal) {
    if (agentBal !== undefined && agentBal !== null) {
      // Flash on change
      if (this.lastAgentBalance !== null && this.lastAgentBalance !== agentBal) {
        this.agentBalanceEl.classList.add('balance-flash');
        setTimeout(() => this.agentBalanceEl.classList.remove('balance-flash'), 300);
      }
      this.lastAgentBalance = agentBal;
      this.agentBalanceEl.textContent = '\u25CE ' + agentBal.toFixed(4);

      // Set baseline on first load
      if (this.sessionBaseline === null) {
        this.sessionBaseline = agentBal;
        this.sessionBaselineEl.textContent = agentBal.toFixed(4);
      }

      // Update P&L
      const pnl = agentBal - this.sessionBaseline;
      const pnlPct = this.sessionBaseline > 0 ? (pnl / this.sessionBaseline) * 100 : 0;
      const sign = pnl >= 0 ? '+' : '-';
      this.sessionPnlEl.textContent = sign + '\u25CE ' + Math.abs(pnl).toFixed(4);
      this.sessionPnlEl.className = 'card-value ' + (pnl >= 0 ? 'green' : 'red');
      this.sessionPnlPctEl.textContent = (pnl >= 0 ? '+' : '') + pnlPct.toFixed(2) + '%';
    }

    if (vaultBal !== undefined && vaultBal !== null) {
      if (this.lastVaultBalance !== null && this.lastVaultBalance !== vaultBal) {
        this.vaultBalanceEl.classList.add('balance-flash');
        setTimeout(() => this.vaultBalanceEl.classList.remove('balance-flash'), 300);
      }
      this.lastVaultBalance = vaultBal;
      this.vaultBalanceEl.textContent = '\u25CE ' + vaultBal.toFixed(4);
    }

    this.rpcBadgeEl.className = 'rpc-badge connected';
    this.rpcBadgeEl.textContent = 'CONNECTED';
  },

  updateThresholdProgress(balance, threshold) {
    if (!threshold || threshold <= 0) return;
    const pct = Math.min((balance / threshold) * 100, 100);
    this.thresholdProgressEl.style.width = pct + '%';
  },

  updateConfigDisplay(config) {
    this.thresholdDisplayEl.textContent = config.sweepThreshold;
    this.reserveDisplayEl.textContent = config.reserveFloor;
  },

  addSweptAmount(amount) {
    this.totalSwept += amount;
    this.sessionSweptEl.textContent = this.totalSwept.toFixed(4);
  },

  async copyAddress(type) {
    const el = type === 'agent' ? this.agentAddressEl : this.vaultAddressEl;
    const full = el.dataset.full;
    if (full) {
      try {
        await navigator.clipboard.writeText(full);
        const addrEl = el.querySelector('.addr-value');
        const orig = addrEl.textContent;
        addrEl.textContent = 'COPIED';
        setTimeout(() => { addrEl.textContent = orig; }, 1000);
      } catch (e) {
        console.error('Copy failed:', e);
      }
    }
  },
};
