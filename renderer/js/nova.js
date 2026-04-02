/* ==========================================================================
   STRATEGOS — Nova Intelligence UI Controller
   ========================================================================== */

const NovaUI = {
  briefContentEl: null,
  briefTimestampEl: null,
  sidebarLastEl: null,
  btnNovaIntel: null,
  btnNovaRequest: null,
  isLoading: false,
  currentActions: [],

  init() {
    this.briefContentEl = document.getElementById('nova-brief-content');
    this.briefTimestampEl = document.getElementById('nova-brief-timestamp');
    this.sidebarLastEl = document.getElementById('nova-sidebar-last');
    this.btnNovaIntel = document.getElementById('btn-nova-intel');
    this.btnNovaRequest = document.getElementById('btn-nova-request');

    this.btnNovaIntel.addEventListener('click', () => this.requestNewBrief());
    this.btnNovaRequest.addEventListener('click', () => this.requestNewBrief());

    this.loadCachedBrief();
  },

  async loadCachedBrief() {
    try {
      const data = await window.strategos.nova.getBrief();
      if (data && data.brief) {
        this.currentActions = data.actions || [];
        this.renderBrief(data.brief, data.timestamp);
      } else {
        this.showLoadingState();
      }
    } catch (e) {
      console.error('Failed to load Nova brief:', e);
      this.showOfflineState();
    }
  },

  async requestNewBrief() {
    if (this.isLoading) return;
    this.isLoading = true;
    this.showLoadingState();

    try {
      const brief = await window.strategos.nova.requestNewBrief();
      if (brief.includes('NOVA OFFLINE')) {
        this.showOfflineState(brief);
      } else {
        this.renderBrief(brief, Date.now());
      }
    } catch (e) {
      console.error('Nova brief request failed:', e);
      this.showOfflineState('NOVA OFFLINE — Request failed: ' + e.message);
    }

    this.isLoading = false;
  },

  renderBrief(briefText, timestamp) {
    if (!briefText) {
      this.showLoadingState();
      return;
    }

    // Parse and style the brief
    let html = this.parseBriefToHtml(briefText);

    // Append NOVA action execute buttons if available
    if (this.currentActions && this.currentActions.length > 0) {
      html += this.renderActionButtons(this.currentActions);
    }

    this.briefContentEl.innerHTML = html;
    this.bindActionButtons();

    if (timestamp) {
      const timeAgo = this.timeAgo(timestamp);
      this.briefTimestampEl.textContent = 'BRIEF GENERATED: ' + timeAgo;
      this.sidebarLastEl.textContent = 'LAST BRIEF: ' + timeAgo;
    }
  },

  renderActionButtons(actions) {
    let html = '<div class="nova-actions-container">';
    html += '<div class="nova-actions-header">EXECUTABLE ACTIONS</div>';
    actions.forEach((action) => {
      html += '<div class="nova-action-card" data-action-id="' + this.escapeHtml(action.id) + '">';
      html += '<div class="nova-action-top">';
      html += '<span class="nova-action-codename">' + this.escapeHtml(action.codename) + '</span>';
      html += '<span class="nova-action-strategy badge dim">' + this.escapeHtml(action.strategy.toUpperCase()) + '</span>';
      html += '</div>';
      html += '<div class="nova-action-reason">' + this.escapeHtml(action.reason) + '</div>';
      html += '<div class="nova-action-bottom">';
      html += '<span class="nova-action-pct">' + action.amountPct + '% DEPLOYABLE</span>';
      html += '<button class="btn-nova-execute" data-action-id="' + this.escapeHtml(action.id) + '">EXECUTE</button>';
      html += '</div>';
      html += '</div>';
    });
    html += '</div>';
    return html;
  },

  bindActionButtons() {
    const buttons = this.briefContentEl.querySelectorAll('.btn-nova-execute');
    buttons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const actionId = e.target.dataset.actionId;
        this.executeAction(actionId);
      });
    });
  },

  async executeAction(actionId) {
    const action = this.currentActions.find(a => a.id === actionId);
    if (!action) return;

    const btn = this.briefContentEl.querySelector('.btn-nova-execute[data-action-id="' + actionId + '"]');
    if (btn) {
      btn.textContent = 'EXECUTING...';
      btn.disabled = true;
      btn.classList.add('executing');
    }

    try {
      const result = await window.strategos.nova.executeAction(action);
      if (btn) {
        if (result.success) {
          btn.textContent = 'EXECUTED';
          btn.classList.remove('executing');
          btn.classList.add('executed');
        } else {
          btn.textContent = 'FAILED';
          btn.classList.remove('executing');
          btn.classList.add('failed');
          setTimeout(() => {
            btn.textContent = 'EXECUTE';
            btn.disabled = false;
            btn.classList.remove('failed');
          }, 3000);
        }
      }
    } catch (e) {
      console.error('Nova action execution failed:', e);
      if (btn) {
        btn.textContent = 'ERROR';
        btn.classList.remove('executing');
        btn.classList.add('failed');
        setTimeout(() => {
          btn.textContent = 'EXECUTE';
          btn.disabled = false;
          btn.classList.remove('failed');
        }, 3000);
      }
    }
  },

  parseBriefToHtml(text) {
    // Escape HTML first
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Highlight CODENAME: lines
    let html = escaped.replace(
      /^(CODENAME:)\s*(.+)$/gm,
      '<span class="codename">$1</span> <span class="codename">$2</span>'
    );

    // Highlight OPPORTUNITY: values
    html = html.replace(
      /^(OPPORTUNITY:)\s*(.+)$/gm,
      '<span class="codename">$1</span> <span class="opportunity-value">$2</span>'
    );

    // Highlight other field labels
    const fields = ['MECHANISM', 'EDGE', 'RISK', 'TIMELINE'];
    fields.forEach((field) => {
      const regex = new RegExp(`^(${field}:)`, 'gm');
      html = html.replace(regex, '<span class="codename">$1</span>');
    });

    // Add dividers between strategy blocks (before CODENAME lines that aren't the first)
    const lines = html.split('\n');
    let codenameCount = 0;
    const result = [];
    for (const line of lines) {
      if (line.includes('CODENAME:')) {
        codenameCount++;
        if (codenameCount > 1) {
          result.push('<hr class="strategy-divider">');
        }
      }
      result.push(line);
    }

    return result.join('\n');
  },

  showLoadingState() {
    this.briefContentEl.innerHTML =
      '<span class="nova-loading blink-cursor">ACCESSING INTELLIGENCE NETWORK...</span>';
  },

  showOfflineState(message) {
    const msg = message || 'NOVA OFFLINE — ANTHROPIC_API_KEY NOT CONFIGURED';
    this.briefContentEl.innerHTML = `<span class="nova-offline">${this.escapeHtml(msg)}</span>`;
  },

  showStaleBrief(briefText, timestamp) {
    const html = '<div class="nova-stale">STALE INTEL — Last successful brief shown below</div>' +
      this.parseBriefToHtml(briefText);
    this.briefContentEl.innerHTML = html;
    if (timestamp) {
      const timeAgo = this.timeAgo(timestamp);
      this.briefTimestampEl.textContent = 'BRIEF GENERATED: ' + timeAgo + ' (STALE)';
      this.sidebarLastEl.textContent = 'LAST BRIEF: ' + timeAgo + ' (STALE)';
    }
  },

  updateFromEvent(data) {
    if (data && data.brief) {
      this.currentActions = data.actions || [];
      this.renderBrief(data.brief, data.timestamp);
    }
  },

  timeAgo(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ' + (mins % 60) + 'm ago';
    return new Date(ts).toLocaleString();
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },
};
