const https = require('https');
const http = require('http');

const DOMAINS_TO_TEST = [
  // Solana RPC
  { name: 'Solana Mainnet RPC',       url: 'https://api.mainnet-beta.solana.com',         critical: true },

  // Jupiter APIs
  { name: 'Jupiter Quote API',         url: 'https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50', critical: true },
  { name: 'Jupiter Price API',         url: 'https://price.jup.ag/v6/price?ids=SOL',      critical: true },
  { name: 'Jupiter Limit Orders API',  url: 'https://jup.ag/api/limit/v1',                critical: false },

  // Marinade
  { name: 'Marinade Finance API',      url: 'https://api.marinade.finance/msol/apy/1y',   critical: true },

  // Kamino
  { name: 'Kamino Finance API',        url: 'https://api.kamino.finance/v2/metrics',      critical: true },

  // Orca
  { name: 'Orca Whirlpool API',        url: 'https://api.mainnet.orca.so/v1/whirlpool/list', critical: false },

  // CoinGecko (price feed)
  { name: 'CoinGecko Price Feed',      url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', critical: true },

  // Anthropic (NOVA)
  { name: 'Anthropic API (NOVA)',      url: 'https://api.anthropic.com',                  critical: true },

  // npm registry (package installs)
  { name: 'npm Registry',             url: 'https://registry.npmjs.org',                 critical: false },
];

const TIMEOUT_MS = 8000;

function testUrl(url) {
  return new Promise((resolve) => {
    const start = Date.now();
    const client = url.startsWith('https') ? https : http;

    const req = client.get(url, { timeout: TIMEOUT_MS }, (res) => {
      const latency = Date.now() - start;
      res.destroy();
      resolve({
        reachable: true,
        status: res.statusCode,
        latency,
        // 200-499 means we reached the server (even 404 = reachable)
        connected: res.statusCode < 500,
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ reachable: false, error: 'TIMEOUT', latency: TIMEOUT_MS });
    });

    req.on('error', (err) => {
      const latency = Date.now() - start;
      resolve({
        reachable: false,
        error: err.code || err.message,
        latency,
      });
    });
  });
}

function colorText(text, color) {
  const colors = {
    green:  '\x1b[32m',
    red:    '\x1b[31m',
    yellow: '\x1b[33m',
    cyan:   '\x1b[36m',
    white:  '\x1b[37m',
    dim:    '\x1b[2m',
    reset:  '\x1b[0m',
    bold:   '\x1b[1m',
  };
  return `${colors[color] || ''}${text}${colors.reset}`;
}

async function runDiagnostics() {
  console.log('\n' + colorText('='.repeat(60), 'cyan'));
  console.log(colorText('  STRATEGOS — NETWORK DIAGNOSTIC', 'bold'));
  console.log(colorText('  Testing connectivity to all required endpoints', 'dim'));
  console.log(colorText('='.repeat(60), 'cyan') + '\n');

  const results = [];
  let criticalFailed = 0;
  let optionalFailed = 0;

  for (const domain of DOMAINS_TO_TEST) {
    process.stdout.write(`  Testing ${domain.name}...`);

    const result = await testUrl(domain.url);
    results.push({ ...domain, ...result });

    if (result.reachable && result.connected) {
      const status = colorText(`\u2713 REACHABLE`, 'green');
      const latency = colorText(`${result.latency}ms`, 'dim');
      const code = colorText(`HTTP ${result.status}`, 'dim');
      console.log(`\r  ${status.padEnd(20)} ${domain.name.padEnd(30)} ${code} ${latency}`);
    } else if (result.reachable && !result.connected) {
      // Reached server but got 5xx
      const status = colorText(`\u26A0 SERVER ERROR`, 'yellow');
      const code = colorText(`HTTP ${result.status}`, 'yellow');
      console.log(`\r  ${status.padEnd(20)} ${domain.name.padEnd(30)} ${code}`);
      if (domain.critical) criticalFailed++;
    } else {
      const status = colorText(`\u2717 BLOCKED`, 'red');
      const error = colorText(result.error || 'UNKNOWN', 'red');
      const tag = domain.critical ? colorText('[CRITICAL]', 'red') : colorText('[OPTIONAL]', 'yellow');
      console.log(`\r  ${status.padEnd(20)} ${domain.name.padEnd(30)} ${error} ${tag}`);
      if (domain.critical) criticalFailed++;
      else optionalFailed++;
    }
  }

  console.log('\n' + colorText('-'.repeat(60), 'dim'));
  console.log(colorText('  SUMMARY', 'bold'));
  console.log(colorText('-'.repeat(60), 'dim'));

  const passed = results.filter(r => r.reachable && r.connected).length;
  const total = results.length;

  console.log(`  ${colorText(passed + '/' + total, passed === total ? 'green' : 'yellow')} endpoints reachable\n`);

  if (criticalFailed === 0) {
    console.log('  ' + colorText('\u2713 All critical endpoints reachable \u2014 agent can operate fully', 'green'));
  } else {
    console.log('  ' + colorText(`\u2717 ${criticalFailed} critical endpoint(s) blocked`, 'red'));
    console.log('\n  ' + colorText('BLOCKED CRITICAL ENDPOINTS affect these features:', 'red'));

    const blocked = results.filter(r => (!r.reachable || !r.connected) && r.critical);
    blocked.forEach(b => {
      const impact = getImpact(b.name);
      console.log(`  ${colorText('\u2022', 'red')} ${b.name}: ${colorText(impact, 'yellow')}`);
    });

    console.log('\n  ' + colorText('POSSIBLE CAUSES:', 'yellow'));
    console.log('  \u2022 Windows Firewall blocking outbound connections');
    console.log('  \u2022 Antivirus/security software intercepting HTTPS');
    console.log('  \u2022 Corporate or ISP-level DNS filtering');
    console.log('  \u2022 VPN routing blocking certain domains');
    console.log('\n  ' + colorText('TO FIX:', 'cyan'));
    console.log('  1. Try disabling VPN if active');
    console.log('  2. Try a different network (phone hotspot to test)');
    console.log('  3. Check Windows Firewall \u2192 Allow node.exe outbound');
    console.log('  4. Check antivirus HTTPS inspection settings');
  }

  if (optionalFailed > 0) {
    console.log('\n  ' + colorText(`\u26A0 ${optionalFailed} optional endpoint(s) blocked (non-critical)`, 'yellow'));
  }

  console.log('\n' + colorText('='.repeat(60), 'cyan') + '\n');

  // DNS resolution test
  console.log(colorText('  DNS RESOLUTION TEST', 'bold'));
  console.log(colorText('-'.repeat(60), 'dim'));

  const dns = require('dns').promises;
  const dnsTargets = [
    'quote-api.jup.ag',
    'price.jup.ag',
    'api.marinade.finance',
    'api.kamino.finance',
    'api.coingecko.com',
    'api.anthropic.com',
  ];

  for (const hostname of dnsTargets) {
    try {
      const addresses = await dns.resolve4(hostname);
      console.log(`  ${colorText('\u2713', 'green')} ${hostname.padEnd(35)} ${colorText(addresses[0], 'dim')}`);
    } catch (err) {
      console.log(`  ${colorText('\u2717', 'red')} ${hostname.padEnd(35)} ${colorText('DNS RESOLUTION FAILED \u2014 ' + err.code, 'red')}`);
    }
  }

  console.log('\n' + colorText('='.repeat(60), 'cyan'));
  console.log(colorText('  Copy this output and share it to diagnose connectivity issues', 'dim'));
  console.log(colorText('='.repeat(60), 'cyan') + '\n');
}

function getImpact(name) {
  const impacts = {
    'Solana Mainnet RPC':      'Agent cannot read balances or send transactions',
    'Jupiter Quote API':       'Arbitrage strategy disabled',
    'Jupiter Price API':       'Grid trading disabled',
    'Marinade Finance API':    'Cannot verify staking APY',
    'Kamino Finance API':      'Lending strategy disabled',
    'CoinGecko Price Feed':    'USD values will not display',
    'Anthropic API (NOVA)':    'NOVA intelligence offline',
  };
  return impacts[name] || 'Feature degraded';
}

runDiagnostics().catch(console.error);
