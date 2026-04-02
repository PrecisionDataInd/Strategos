const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true';
const FETCH_TIMEOUT_MS = 8000;

let cachedPrice = { usd: null, change24h: null, lastUpdated: null };

function fetchWithTimeout(url) {
  return Promise.race([
    fetch(url),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), FETCH_TIMEOUT_MS)
    ),
  ]);
}

async function fetchSolPrice(log) {
  try {
    const res = await fetchWithTimeout(COINGECKO_URL);
    if (!res.ok) throw new Error(`CoinGecko returned ${res.status}`);
    const data = await res.json();
    const usd = data?.solana?.usd;
    const change24h = data?.solana?.usd_24h_change;
    if (usd) {
      cachedPrice = { usd, change24h, lastUpdated: Date.now() };
    }
    return cachedPrice;
  } catch (err) {
    if (log) log('WARN', `Price feed: ${err.message}`, { error: err.message });
    return cachedPrice; // return last known price
  }
}

function getCachedPrice() {
  return cachedPrice;
}

function startPriceFeed(log, onUpdate) {
  // Fetch immediately on start
  fetchSolPrice(log).then(price => { if (onUpdate) onUpdate(price); });

  // Then refresh every 60 seconds
  return setInterval(async () => {
    const price = await fetchSolPrice(log);
    if (onUpdate) onUpdate(price);
  }, 60 * 1000);
}

module.exports = { fetchSolPrice, getCachedPrice, startPriceFeed };
