function safeRequire(path, fallbackFnName) {
  try {
    return require(path);
  } catch (e) {
    const fallback = {};
    fallback[fallbackFnName] = async ({ log }) => {
      if (log) log('WARN', `Module ${path} failed to load: ${e.message}`, {});
      return { success: false, reason: 'MODULE_LOAD_FAILED', soft: true, _displayStatus: 'STANDBY' };
    };
    return fallback;
  }
}

module.exports = { safeRequire };
