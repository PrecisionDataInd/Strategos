const { Connection } = require('@solana/web3.js');

const RPC_ENDPOINTS = [
  process.env.RPC_ENDPOINT,
  'https://api.mainnet-beta.solana.com',
  'https://solana-api.projectserum.com',
  'https://rpc.ankr.com/solana',
].filter(Boolean);

let currentIndex = 0;
let currentConnection = null;
const failureCount = new Map();
const MAX_FAILURES_BEFORE_FAILOVER = 3;

function getCurrentEndpoint() {
  return RPC_ENDPOINTS[currentIndex];
}

function getCurrentConnection() {
  if (!currentConnection) {
    currentConnection = new Connection(RPC_ENDPOINTS[currentIndex], 'confirmed');
  }
  return currentConnection;
}

function recordRpcFailure() {
  const endpoint = RPC_ENDPOINTS[currentIndex];
  const count = (failureCount.get(endpoint) || 0) + 1;
  failureCount.set(endpoint, count);
  if (count >= MAX_FAILURES_BEFORE_FAILOVER) {
    failover();
  }
}

function recordRpcSuccess() {
  const endpoint = RPC_ENDPOINTS[currentIndex];
  failureCount.set(endpoint, 0);
}

function failover() {
  const previous = RPC_ENDPOINTS[currentIndex];
  currentIndex = (currentIndex + 1) % RPC_ENDPOINTS.length;
  currentConnection = new Connection(RPC_ENDPOINTS[currentIndex], 'confirmed');
  failureCount.clear();
  console.log(`[STRATEGOS] RPC failover from ${previous} to ${RPC_ENDPOINTS[currentIndex]}`);
}

async function withRpcRetry(operation, maxRetries = 3) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const conn = getCurrentConnection();
      const result = await operation(conn);
      recordRpcSuccess();
      return result;
    } catch (err) {
      lastError = err;
      recordRpcFailure();
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, i)));
    }
  }
  throw lastError;
}

module.exports = {
  getCurrentConnection,
  getCurrentEndpoint,
  recordRpcFailure,
  recordRpcSuccess,
  failover,
  withRpcRetry,
  RPC_ENDPOINTS,
};
