const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('strategos', {
  wallet: {
    getAgentBalance: () => ipcRenderer.invoke('wallet:getAgentBalance'),
    getVaultBalance: () => ipcRenderer.invoke('wallet:getVaultBalance'),
    getAgentPublicKey: () => ipcRenderer.invoke('wallet:getAgentPublicKey'),
    getVaultPublicKey: () => ipcRenderer.invoke('wallet:getVaultPublicKey'),
  },
  sweep: {
    checkAndSweep: () => ipcRenderer.invoke('sweep:checkAndSweep'),
    manualSweep: () => ipcRenderer.invoke('sweep:manualSweep'),
    isLiveMode: () => ipcRenderer.invoke('sweep:isLiveMode'),
  },
  strategies: {
    getResults: () => ipcRenderer.invoke('strategies:getResults'),
    getPositions: () => ipcRenderer.invoke('strategies:getPositions'),
  },
  positions: {
    getAll: () => ipcRenderer.invoke('positions:getAll'),
    getByStrategy: (id) => ipcRenderer.invoke('positions:getByStrategy', id),
  },
  harvest: {
    runNow: () => ipcRenderer.invoke('harvest:runNow'),
    getLastResult: () => ipcRenderer.invoke('harvest:getLastResult'),
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (key, value) => ipcRenderer.invoke('config:set', key, value),
  },
  log: {
    getAll: () => ipcRenderer.invoke('log:getAll'),
    clear: () => ipcRenderer.invoke('log:clear'),
  },
  agent: {
    getStatus: () => ipcRenderer.invoke('agent:getStatus'),
    start: () => ipcRenderer.invoke('agent:start'),
    stop: () => ipcRenderer.invoke('agent:stop'),
  },
  nova: {
    getBrief: () => ipcRenderer.invoke('nova:getBrief'),
    requestNewBrief: () => ipcRenderer.invoke('nova:requestNewBrief'),
    getActions: () => ipcRenderer.invoke('nova:getActions'),
    executeAction: (action) => ipcRenderer.invoke('nova:executeAction', action),
  },
  risk: {
    getStatus: () => ipcRenderer.invoke('risk:getStatus'),
    resetSession: () => ipcRenderer.invoke('risk:resetSession'),
  },
  price: {
    get: () => ipcRenderer.invoke('price:get'),
    onUpdate: (callback) => ipcRenderer.on('price:update', (_, data) => callback(data)),
  },
  portfolio: {
    getSummary: () => ipcRenderer.invoke('portfolio:getSummary'),
    getTransactions: () => ipcRenderer.invoke('portfolio:getTransactions'),
    exportCSV: () => ipcRenderer.invoke('portfolio:exportCSV'),
  },
  report: {
    sendNow: () => ipcRenderer.invoke('report:sendNow'),
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
  },
  on: (channel, callback) => {
    const validChannels = ['agent:tick', 'log:entry', 'nova:brief', 'agent:halted', 'harvest:complete', 'nova:actionResult', 'risk:status', 'price:update'];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (_event, data) => callback(data));
    }
  },
});
