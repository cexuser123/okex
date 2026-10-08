/**
 * OKX Balance & Deposit Address Check Bot (single file)
 *
 * Usage:
 *   node okx-bot.js balance
 *   node okx-bot.js balance BTC
 *   node okx-bot.js address USDT
 *   node okx-bot.js perms
 *   node okx-bot.js all USDT
 *
 * balance also prints:
 *   - deposit addresses for held coins
 *   - API key permission probe (Read / Trade / Withdraw)
 *
 * Credentials (pick one):
 *   1) Set below in CONFIG
 *   2) Or env: OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE
 *   Optional: OKX_SIMULATED=1 for demo trading
 *   Optional: OKX_BASE_URL=https://www.okx.com
 */

'use strict';

const https = require('https');
const dns = require('dns');
const crypto = require('crypto');
const { URL } = require('url');

// Prefer IPv4 — avoids broken IPv6 / local 169.254.* proxy paths on some Windows hosts
dns.setDefaultResultOrder('ipv4first');

// ============ PUT YOUR KEYS HERE (or use env vars) ============
const CONFIG = {
  apiKey: process.env.OKX_API_KEY || 'aa67b956-2f65-4c63-8e5f-a91c241d47a3',
  secretKey: process.env.OKX_SECRET_KEY || '6E401931372F86C07346FA4FCFE48A18',
  passphrase: process.env.OKX_PASSPHRASE || 'Crypto-options6',
  // Demo trading: set true or OKX_SIMULATED=1
  simulated: process.env.OKX_SIMULATED === '1' || false,
  // Primary host (override with OKX_BASE_URL). Fallbacks are tried automatically on network errors.
  baseUrl: process.env.OKX_BASE_URL || 'https://www.okx.com',
  fallbackBaseUrls: [
    'https://www.okx.com',
    'https://my.okx.com',
    'https://app.okx.com',
  ],
  connectTimeoutMs: Number(process.env.OKX_TIMEOUT_MS || 15000),
};
// ==============================================================

let activeBaseUrl = CONFIG.baseUrl;

function requireCreds() {
  const { apiKey, secretKey, passphrase } = CONFIG;
  if (!apiKey || !secretKey || !passphrase) {
    console.error(`
Missing API credentials.

Set them in CONFIG at the top of okx-bot.js, or export:
  OKX_API_KEY
  OKX_SECRET_KEY
  OKX_PASSPHRASE
`);
    process.exit(1);
  }
}

function sign(timestamp, method, requestPath, body, secretKey) {
  const prehash = timestamp + method.toUpperCase() + requestPath + (body || '');
  return crypto.createHmac('sha256', secretKey).update(prehash).digest('base64');
}

function isNetworkError(err) {
  const code = err && (err.code || '');
  return (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    /timeout/i.test(String(err && err.message))
  );
}

function explainNetworkError(err) {
  const addr = err && err.address;
  const msg = (err && err.message) || String(err);
  let tip = '';
  if (addr && String(addr).startsWith('169.254.')) {
    tip =
      '\nHint: DNS/proxy resolved OKX to a link-local address (169.254.*). ' +
      'Disable VPN/antivirus HTTPS scan, check hosts file, or set OKX_BASE_URL to a working host.';
  } else if (err && err.code === 'ETIMEDOUT') {
    tip =
      '\nHint: Connection timed out. Try another network/VPN, or set OKX_BASE_URL=https://my.okx.com';
  }
  return msg + tip;
}

function requestOnce(baseUrl, method, pathWithQuery, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : '';
    const timestamp = new Date().toISOString();
    const signature = sign(timestamp, method, pathWithQuery, body, CONFIG.secretKey);
    const url = new URL(baseUrl + pathWithQuery);

    const headers = {
      'OK-ACCESS-KEY': CONFIG.apiKey,
      'OK-ACCESS-SIGN': signature,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': CONFIG.passphrase,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'okx-balance-address-bot/1.1',
    };
    if (CONFIG.simulated) headers['x-simulated-trading'] = '1';

    const req = https.request(
      {
        protocol: 'https:',
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: method.toUpperCase(),
        headers,
        family: 4, // force IPv4
        servername: url.hostname,
        timeout: CONFIG.connectTimeoutMs,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(raw);
          } catch {
            return reject(new Error(`Invalid JSON (${res.statusCode}) from ${url.hostname}: ${raw}`));
          }
          if (String(json.code) !== '0') {
            return reject(
              Object.assign(
                new Error(
                  `OKX API error code=${json.code} msg=${json.msg || JSON.stringify(json)}`
                ),
                { okxCode: String(json.code), okxBody: json }
              )
            );
          }
          resolve(json);
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(Object.assign(new Error(`connect ETIMEDOUT ${url.hostname}:443`), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function uniqueBaseUrls() {
  const list = [activeBaseUrl, CONFIG.baseUrl, ...(CONFIG.fallbackBaseUrls || [])];
  return [...new Set(list.filter(Boolean))];
}

async function request(method, pathWithQuery, bodyObj) {
  const hosts = uniqueBaseUrls();
  let lastErr;

  for (let i = 0; i < hosts.length; i++) {
    const baseUrl = hosts[i];
    try {
      const result = await requestOnce(baseUrl, method, pathWithQuery, bodyObj);
      if (activeBaseUrl !== baseUrl) {
        activeBaseUrl = baseUrl;
        console.log(`[net] using ${baseUrl}`);
      }
      return result;
    } catch (err) {
      lastErr = err;
      // API/auth errors should not fall through to other hosts
      if (!isNetworkError(err)) throw err;
      const next = hosts[i + 1];
      console.warn(`[net] ${baseUrl} failed: ${err.message}`);
      if (next) console.warn(`[net] retrying via ${next} ...`);
    }
  }

  throw new Error(explainNetworkError(lastErr));
}

function fmt(n) {
  if (n === undefined || n === null || n === '') return '0';
  const num = Number(n);
  if (Number.isNaN(num)) return String(n);
  return num.toLocaleString('en-US', { maximumFractionDigits: 12 });
}

async function getTradingBalance(ccy) {
  const q = ccy ? `?ccy=${encodeURIComponent(ccy)}` : '';
  return request('GET', `/api/v5/account/balance${q}`);
}

async function getFundingBalance(ccy) {
  const q = ccy ? `?ccy=${encodeURIComponent(ccy)}` : '';
  return request('GET', `/api/v5/asset/balances${q}`);
}

async function getDepositAddress(ccy, chain) {
  if (!ccy) throw new Error('Currency is required for address check, e.g. address USDT');
  const path = `/api/v5/asset/deposit-address?ccy=${encodeURIComponent(ccy)}`;
  const res = await request('GET', path);
  if (chain) {
    const wanted = chain.toUpperCase();
    res.data = (res.data || []).filter(
      (row) =>
        String(row.chain || '').toUpperCase().includes(wanted) ||
        String(row.chain || '').toUpperCase() === `${ccy.toUpperCase()}-${wanted}`
    );
  }
  return res;
}

async function getAccountConfig() {
  return request('GET', '/api/v5/account/config');
}

function collectHeldCcys(tradingRes, fundingRes, onlyCcy) {
  if (onlyCcy) return [onlyCcy.toUpperCase()];
  const set = new Set();
  for (const acct of tradingRes.data || []) {
    for (const d of acct.details || []) {
      if (Number(d.eq) > 0 || Number(d.cashBal) > 0 || Number(d.availBal) > 0) set.add(d.ccy);
    }
  }
  for (const d of fundingRes.data || []) {
    if (Number(d.bal) > 0 || Number(d.availBal) > 0) set.add(d.ccy);
  }
  // Prefer major coins first
  const priority = ['BTC', 'ETH', 'USDT', 'USDC', 'OKB', 'SOL'];
  return [...set].sort((a, b) => {
    const ia = priority.indexOf(a);
    const ib = priority.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

function pickMainDepositRows(rows) {
  const list = rows || [];
  if (!list.length) return [];
  // Prefer common deposit networks, then selected flag
  const prefer = [
    '-Bitcoin',
    'BTC-Bitcoin',
    'ETH-ERC20',
    '-ERC20',
    'USDT-TRC20',
    '-TRC20',
    '-Solana',
    '-BSC',
  ];
  const score = (r) => {
    const chain = String(r.chain || '');
    let s = prefer.findIndex((p) => chain.includes(p) || chain === p);
    if (s === -1) s = 50;
    if (r.selected === true || String(r.selected) === 'true') s -= 0.5;
    return s;
  };
  const best = [...list].sort((a, b) => score(a) - score(b))[0];
  return best ? [best] : [];
}

async function printDepositAddressesForCcys(ccys, { allChains = false } = {}) {
  console.log('\n=== OKX Deposit Addresses (for held coins) ===');
  if (!ccys.length) {
    console.log('(no held coins)');
    return;
  }
  for (const ccy of ccys) {
    try {
      const res = await getDepositAddress(ccy);
      const rows = allChains ? res.data || [] : pickMainDepositRows(res.data || []);
      if (!rows.length) {
        console.log(`${pad(ccy, 8)} (no deposit address returned)`);
        continue;
      }
      for (const row of rows) {
        const tag = row.tag ? `  tag=${row.tag}` : '';
        console.log(`${pad(ccy, 8)} ${pad(row.chain || '', 22)} ${row.addr}${tag}`);
      }
    } catch (err) {
      console.log(`${pad(ccy, 8)} error: ${err.message}`);
    }
  }
  console.log('(use: node okx-bot.js address BTC   to see all chains for one coin)');
}

function permissionDenied(err) {
  const code = String((err && err.okxCode) || '');
  const msg = String((err && err.message) || '').toLowerCase();
  return (
    code === '50113' ||
    code === '50114' ||
    code === '50119' ||
    /permission|not allow|no authority|unauthorized|api key/i.test(msg)
  );
}

async function probeApiKeyPermissions() {
  const result = {
    Read: { ok: false, detail: '' },
    Trade: { ok: false, detail: '' },
    Withdraw: { ok: false, detail: '' },
    account: null,
  };

  // Read
  try {
    await request('GET', '/api/v5/account/balance');
    result.Read = { ok: true, detail: 'account/balance OK' };
  } catch (err) {
    result.Read = { ok: false, detail: err.message };
  }

  // Account config (extra info; still Read)
  try {
    const cfg = await getAccountConfig();
    result.account = (cfg.data && cfg.data[0]) || null;
  } catch {
    /* ignore */
  }

  // Trade: invalid order should fail on params if Trade allowed, or permission if not
  try {
    await request('POST', '/api/v5/trade/order', {
      instId: 'BTC-USDT',
      tdMode: 'cash',
      side: 'buy',
      ordType: 'limit',
      sz: '0',
      px: '1',
    });
    result.Trade = { ok: true, detail: 'trade endpoint accepted (unexpected)' };
  } catch (err) {
    if (permissionDenied(err)) {
      result.Trade = { ok: false, detail: err.message };
    } else {
      // Parameter / business error means the key can hit trade APIs
      result.Trade = { ok: true, detail: `trade API reachable (${err.okxCode || 'biz error'})` };
    }
  }

  // Withdraw: invalid withdraw should fail on params if Withdraw allowed
  try {
    await request('POST', '/api/v5/asset/withdrawal', {
      ccy: 'BTC',
      amt: '0',
      dest: '4',
      toAddr: 'invalid',
      chain: 'BTC-Bitcoin',
    });
    result.Withdraw = { ok: true, detail: 'withdraw endpoint accepted (unexpected)' };
  } catch (err) {
    if (permissionDenied(err)) {
      result.Withdraw = { ok: false, detail: err.message };
    } else {
      result.Withdraw = { ok: true, detail: `withdraw API reachable (${err.okxCode || 'biz error'})` };
    }
  }

  return result;
}

function printPermissions(probe) {
  console.log('\n=== API Key Permissions (probed) ===');
  console.log(`Key     : ${CONFIG.apiKey}`);
  console.log(`Read    : ${probe.Read.ok ? 'YES' : 'NO'}  ${probe.Read.detail}`);
  console.log(`Trade   : ${probe.Trade.ok ? 'YES' : 'NO'}  ${probe.Trade.detail}`);
  console.log(`Withdraw: ${probe.Withdraw.ok ? 'YES' : 'NO'}  ${probe.Withdraw.detail}`);
  if (probe.account) {
    const a = probe.account;
    console.log('-'.repeat(60));
    if (a.uid) console.log(`UID     : ${a.uid}`);
    if (a.acctLv !== undefined) console.log(`AcctLv  : ${a.acctLv}`);
    if (a.posMode) console.log(`PosMode : ${a.posMode}`);
    if (a.level) console.log(`Level   : ${a.level}`);
    if (a.label) console.log(`Label   : ${a.label}`);
    if (a.roleType !== undefined) console.log(`Role    : ${a.roleType}`);
    if (a.ip) console.log(`IP bind : ${a.ip}`);
  }
  console.log(
    '\nNote: OKX does not return a permission list API; this probes endpoints.\n' +
      'Exact IP whitelist / key label are also visible in OKX website: Profile → API.'
  );
}

function printTradingBalance(res) {
  console.log('\n=== Trading Account Balance ===');
  if (!res.data || !res.data.length) {
    console.log('(empty)');
    return;
  }
  for (const acct of res.data) {
    console.log(`Total Equity (USD): ${fmt(acct.totalEq)}`);
    console.log('-'.repeat(60));
    console.log(
      pad('CCY', 10) + pad('Equity', 18) + pad('Cash', 18) + pad('Available', 18) + 'Frozen'
    );
    console.log('-'.repeat(60));
    const details = (acct.details || []).filter(
      (d) => Number(d.eq) > 0 || Number(d.cashBal) > 0 || Number(d.availBal) > 0
    );
    if (!details.length) {
      console.log('(no non-zero balances)');
      continue;
    }
    for (const d of details) {
      console.log(
        pad(d.ccy, 10) +
          pad(fmt(d.eq), 18) +
          pad(fmt(d.cashBal), 18) +
          pad(fmt(d.availBal), 18) +
          fmt(d.frozenBal)
      );
    }
  }
}

function printFundingBalance(res) {
  console.log('\n=== Funding Account Balance ===');
  const rows = (res.data || []).filter((d) => Number(d.bal) > 0 || Number(d.availBal) > 0);
  if (!rows.length) {
    console.log('(no non-zero balances)');
    return;
  }
  console.log('-'.repeat(56));
  console.log(pad('CCY', 10) + pad('Balance', 18) + pad('Available', 18) + 'Frozen');
  console.log('-'.repeat(56));
  for (const d of rows) {
    console.log(
      pad(d.ccy, 10) + pad(fmt(d.bal), 18) + pad(fmt(d.availBal), 18) + fmt(d.frozenBal)
    );
  }
}

function printAddresses(res, ccy) {
  console.log(`\n=== Deposit Addresses (${ccy.toUpperCase()}) ===`);
  const rows = res.data || [];
  if (!rows.length) {
    console.log('(none found — check currency/chain or API key permissions: Read + Withdraw/Deposit)');
    return;
  }
  for (const row of rows) {
    console.log('-'.repeat(60));
    console.log(`Currency : ${row.ccy}`);
    console.log(`Chain    : ${row.chain}`);
    console.log(`Address  : ${row.addr}`);
    if (row.tag) console.log(`Tag/Memo : ${row.tag}`);
    if (row.pmtId) console.log(`PaymentId: ${row.pmtId}`);
    if (row.to) console.log(`To acct  : ${row.to}`); // 6=funding, 18=trading
    if (row.selected !== undefined) console.log(`Selected : ${row.selected}`);
  }
  console.log('-'.repeat(60));
}

function pad(s, n) {
  s = String(s ?? '');
  return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length);
}

function usage() {
  console.log(`
OKX Balance & Address Bot

Commands:
  balance [CCY]              Balances + deposit addresses + API key permissions
  address <CCY> [--chain X]  Show deposit address(es) for a currency (all chains)
  perms                      Probe API key permissions only
  all <CCY> [--chain X]      Balances + deposit address for one currency

Examples:
  node okx-bot.js balance
  node okx-bot.js balance BTC
  node okx-bot.js address BTC
  node okx-bot.js perms

Env / config:
  OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE
  OKX_SIMULATED=1
  OKX_BASE_URL=https://www.okx.com
  OKX_TIMEOUT_MS=15000
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--chain' && args[i + 1]) {
      flags.chain = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      flags.help = true;
    } else {
      positional.push(args[i]);
    }
  }
  return { cmd: (positional[0] || '').toLowerCase(), ccy: positional[1], flags };
}

async function main() {
  const { cmd, ccy, flags } = parseArgs(process.argv);
  if (!cmd || flags.help) {
    usage();
    process.exit(cmd ? 0 : 1);
  }

  requireCreds();

  if (CONFIG.simulated) {
    console.log('[mode] simulated / demo trading');
  }

  if (cmd === 'perms') {
    const probe = await probeApiKeyPermissions();
    printPermissions(probe);
    return;
  }

  if (cmd === 'balance') {
    const [trading, funding, probe] = await Promise.all([
      getTradingBalance(ccy),
      getFundingBalance(ccy),
      probeApiKeyPermissions(),
    ]);
    printTradingBalance(trading);
    printFundingBalance(funding);
    const held = collectHeldCcys(trading, funding, ccy);
    // For full balance, show main deposit addr for major/held coins (cap to avoid rate limits)
    const addrCcys = ccy ? held : held.slice(0, 12);
    await printDepositAddressesForCcys(addrCcys, { allChains: Boolean(ccy) });
    printPermissions(probe);
    return;
  }

  if (cmd === 'address') {
    if (!ccy) throw new Error('Usage: address <CCY> [--chain X]');
    const res = await getDepositAddress(ccy, flags.chain);
    printAddresses(res, ccy);
    return;
  }

  if (cmd === 'all') {
    if (!ccy) throw new Error('all requires a currency, e.g. all USDT');
    const [trading, funding, addr, probe] = await Promise.all([
      getTradingBalance(ccy),
      getFundingBalance(ccy),
      getDepositAddress(ccy, flags.chain),
      probeApiKeyPermissions(),
    ]);
    printTradingBalance(trading);
    printFundingBalance(funding);
    printAddresses(addr, ccy);
    printPermissions(probe);
    return;
  }

  usage();
  process.exit(1);
}

main().catch((err) => {
  console.error('\nError:', err.message || err);
  if (err && err.okxCode === '50119') {
    console.error(
      'Tip: OKX says this API key does not exist. Recreate the key on OKX, confirm passphrase, and check demo vs live (OKX_SIMULATED).'
    );
  }
  process.exit(1);
});
