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
    const html = this.parseBriefToHtml(briefText);
    this.briefContentEl.innerHTML = html;

    if (timestamp) {
      const timeAgo = this.timeAgo(timestamp);
      this.briefTimestampEl.textContent = 'BRIEF GENERATED: ' + timeAgo;
      this.sidebarLastEl.textContent = 'LAST BRIEF: ' + timeAgo;
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
