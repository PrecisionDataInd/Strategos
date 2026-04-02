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
    // Strip tactical brief header lines
    let cleaned = text
      .replace(/^#+ .*TACTICAL BRIEF.*$/gim, '')
      .replace(/^#+ .*NOVA.*INTELLIGENCE.*$/gim, '')
      .replace(/```json[\s\S]*?```/g, '')
      .trim();

    // Try structured parsing (handles both **FIELD:** markdown and plain FIELD: formats)
    const fieldPattern = /\*{0,2}(CODENAME):?\*{0,2}[:\s]+(.+)/i;
    const hasStructuredBlocks = fieldPattern.test(cleaned);

    if (hasStructuredBlocks) {
      return this.parseStructuredBrief(cleaned);
    }

    // Fallback: render as cleaned plain text
    const escaped = this.escapeHtml(cleaned);
    return '<div class="nova-plain">' + escaped.replace(/\n/g, '<br>') + '</div>';
  },

  parseStructuredBrief(text) {
    // Split into strategy blocks — look for CODENAME markers (plain or markdown)
    const blocks = text.split(/(?=(?:#{1,3}\s+)?(?:STRATEGY\s+\d|(?:\*{0,2})CODENAME(?:\*{0,2})))/i).filter(b => b.trim());

    if (blocks.length === 0) {
      const escaped = this.escapeHtml(text);
      return '<div class="nova-plain">' + escaped.replace(/\n/g, '<br>') + '</div>';
    }

    return blocks.map((block) => {
      // Extract fields — handle both **FIELD:** and FIELD: patterns
      function extractField(name) {
        // Match: **FIELD:** value, FIELD: value, **FIELD**: value
        const patterns = [
          new RegExp('\\*\\*' + name + ':\\*\\*\\s*(.+)', 'im'),
          new RegExp('\\*\\*' + name + '\\*\\*:\\s*(.+)', 'im'),
          new RegExp('^' + name + ':\\s*(.+)', 'im'),
        ];
        for (const p of patterns) {
          const m = block.match(p);
          if (m) return m[1].trim();
        }
        return '';
      }

      function extractMultilineField(name) {
        // For MECHANISM which can span multiple lines
        const patterns = [
          new RegExp('\\*\\*' + name + ':\\*\\*\\s*([\\s\\S]*?)(?=\\*\\*(?:EDGE|RISK|TIMELINE)|$)', 'im'),
          new RegExp('\\*\\*' + name + '\\*\\*:\\s*([\\s\\S]*?)(?=\\*\\*(?:EDGE|RISK|TIMELINE)|$)', 'im'),
          new RegExp('^' + name + ':\\s*([\\s\\S]*?)(?=^(?:EDGE|RISK|TIMELINE):)', 'im'),
        ];
        for (const p of patterns) {
          const m = block.match(p);
          if (m) return m[1].replace(/\*\*/g, '').trim();
        }
        return '';
      }

      const codename = extractField('CODENAME');
      const opportunity = extractField('OPPORTUNITY');
      const mechanism = extractMultilineField('MECHANISM');
      const edge = extractField('EDGE');
      const risk = extractField('RISK');
      const timeline = extractField('TIMELINE');

      // If we couldn't extract a codename, render block as plain text
      if (!codename) {
        const escaped = this.escapeHtml(block);
        return '<div class="nova-plain">' + escaped.replace(/\n/g, '<br>') + '</div>';
      }

      let html = '<div class="nova-strategy-block">';
      html += '<div class="nova-strategy-header">';
      html += '<span class="nova-codename">' + this.escapeHtml(codename) + '</span>';
      if (timeline) {
        html += '<span class="nova-timeline">' + this.escapeHtml(timeline) + '</span>';
      }
      html += '</div>';

      if (opportunity) {
        html += '<div class="nova-field"><span class="nova-field-label">OPPORTUNITY</span><span class="nova-field-value">' + this.escapeHtml(opportunity) + '</span></div>';
      }
      if (mechanism) {
        html += '<div class="nova-field"><span class="nova-field-label">MECHANISM</span><span class="nova-field-value">' + this.escapeHtml(mechanism) + '</span></div>';
      }
      if (edge) {
        html += '<div class="nova-field nova-field-edge"><span class="nova-field-label">EDGE</span><span class="nova-field-value">' + this.escapeHtml(edge) + '</span></div>';
      }
      if (risk) {
        html += '<div class="nova-field nova-field-risk"><span class="nova-field-label">RISK</span><span class="nova-field-value">' + this.escapeHtml(risk) + '</span></div>';
      }

      html += '</div>';
      return html;
    }).join('<div class="nova-strategy-divider"></div>');
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
