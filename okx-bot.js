/**
 * OKX Balance & Deposit Address Check Bot (single file)
 *
 * Usage:
 *   node okx-bot.js balance
 *   node okx-bot.js address USDT
 *   node okx-bot.js address BTC --chain ERC20
 *   node okx-bot.js all USDT
 *
 * Credentials (pick one):
 *   1) Set below in CONFIG
 *   2) Or env: OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE
 *   Optional: OKX_SIMULATED=1 for demo trading
 */

'use strict';

const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

// ============ PUT YOUR KEYS HERE (or use env vars) ============
const CONFIG = {
  apiKey: process.env.OKX_API_KEY || '',
  secretKey: process.env.OKX_SECRET_KEY || '',
  passphrase: process.env.OKX_PASSPHRASE || '',
  // Demo trading: set true or OKX_SIMULATED=1
  simulated: process.env.OKX_SIMULATED === '1' || false,
  baseUrl: 'https://www.okx.com',
};
// ==============================================================

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

function request(method, pathWithQuery, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : '';
    const timestamp = new Date().toISOString();
    const signature = sign(timestamp, method, pathWithQuery, body, CONFIG.secretKey);
    const url = new URL(CONFIG.baseUrl + pathWithQuery);

    const headers = {
      'OK-ACCESS-KEY': CONFIG.apiKey,
      'OK-ACCESS-SIGN': signature,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': CONFIG.passphrase,
      'Content-Type': 'application/json',
    };
    if (CONFIG.simulated) headers['x-simulated-trading'] = '1';

    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: method.toUpperCase(),
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(raw);
          } catch {
            return reject(new Error(`Invalid JSON (${res.statusCode}): ${raw}`));
          }
          if (String(json.code) !== '0') {
            return reject(
              new Error(`OKX API error code=${json.code} msg=${json.msg || JSON.stringify(json)}`)
            );
          }
          resolve(json);
        });
      }
    );

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
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
  let path = `/api/v5/asset/deposit-address?ccy=${encodeURIComponent(ccy)}`;
  // OKX returns all chains for the ccy; we filter client-side by chain if provided
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
  balance [CCY]              Show trading + funding balances (optional currency filter)
  address <CCY> [--chain X]  Show deposit address(es) for a currency
  all <CCY> [--chain X]      Show balances + deposit address for a currency

Examples:
  node okx-bot.js balance
  node okx-bot.js balance USDT
  node okx-bot.js address USDT
  node okx-bot.js address USDT --chain ERC20
  node okx-bot.js all BTC --chain Bitcoin

Env / config:
  OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE
  OKX_SIMULATED=1   (demo trading)
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

  if (cmd === 'balance') {
    const [trading, funding] = await Promise.all([
      getTradingBalance(ccy),
      getFundingBalance(ccy),
    ]);
    printTradingBalance(trading);
    printFundingBalance(funding);
    return;
  }

  if (cmd === 'address') {
    const res = await getDepositAddress(ccy, flags.chain);
    printAddresses(res, ccy);
    return;
  }

  if (cmd === 'all') {
    if (!ccy) throw new Error('all requires a currency, e.g. all USDT');
    const [trading, funding, addr] = await Promise.all([
      getTradingBalance(ccy),
      getFundingBalance(ccy),
      getDepositAddress(ccy, flags.chain),
    ]);
    printTradingBalance(trading);
    printFundingBalance(funding);
    printAddresses(addr, ccy);
    return;
  }

  usage();
  process.exit(1);
}

main().catch((err) => {
  console.error('\nError:', err.message || err);
  process.exit(1);
});
