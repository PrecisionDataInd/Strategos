/* ==========================================================================
   STRATEGOS — Logger UI Controller
   ========================================================================== */

const LoggerUI = {
  logEntriesEl: null,
  logCountEl: null,
  logEmptyEl: null,
  btnPurgeLog: null,
  entries: [],

  init() {
    this.logEntriesEl = document.getElementById('log-entries');
    this.logCountEl = document.getElementById('log-count');
    this.logEmptyEl = document.getElementById('log-empty-state');
    this.btnPurgeLog = document.getElementById('btn-purge-log');

    this.btnPurgeLog.addEventListener('click', () => this.purgeLog());
    this.loadEntries();
  },

  async loadEntries() {
    try {
      const entries = await window.strategos.log.getAll();
      this.entries = entries || [];
      this.renderAll();
    } catch (e) {
      console.error('Failed to load log:', e);
    }
  },

  renderAll() {
    // Clear all except empty state
    const children = Array.from(this.logEntriesEl.children);
    children.forEach((child) => {
      if (child !== this.logEmptyEl) child.remove();
    });

    if (this.entries.length === 0) {
      this.logEmptyEl.style.display = 'flex';
      this.logCountEl.textContent = '0';
      return;
    }

    this.logEmptyEl.style.display = 'none';
    this.logCountEl.textContent = this.entries.length;

    this.entries.forEach((entry) => {
      const el = this.createEntryElement(entry, false);
      this.logEntriesEl.appendChild(el);
    });
  },

  addEntry(entry) {
    this.entries.unshift(entry);
    if (this.entries.length > 500) this.entries.length = 500;

    this.logEmptyEl.style.display = 'none';
    this.logCountEl.textContent = this.entries.length;

    const el = this.createEntryElement(entry, true);
    // Insert after the empty state element (which is hidden)
    if (this.logEntriesEl.children.length > 1) {
      this.logEntriesEl.insertBefore(el, this.logEntriesEl.children[1]);
    } else {
      this.logEntriesEl.appendChild(el);
    }
  },

  createEntryElement(entry, animate) {
    const el = document.createElement('div');
    el.className = 'log-entry' + (animate ? ' log-entry-new' : '');

    const time = new Date(entry.timestamp);
    const timeStr = time.toLocaleTimeString('en-US', { hour12: false }) +
      '.' + String(time.getMilliseconds()).padStart(3, '0');

    el.innerHTML = `
      <div class="log-entry-time">${timeStr}</div>
      <div>
        <span class="log-entry-level ${entry.level}">${entry.level}</span>
      </div>
      <div class="log-entry-message">${this.escapeHtml(entry.message)}</div>
    `;

    return el;
  },

  async purgeLog() {
    try {
      await window.strategos.log.clear();
      this.entries = [];
      this.renderAll();
    } catch (e) {
      console.error('Failed to purge log:', e);
    }
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },
};
