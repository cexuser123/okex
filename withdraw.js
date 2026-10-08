/**
 * OKX Withdraw Bot (single file)
 *
 * Withdrawals always leave from the Funding account.
 * This script can auto-transfer Trading -> Funding first.
 *
 * Usage:
 *   node withdraw.js chains BTC
 *   node withdraw.js balance [CCY]
 *   node withdraw.js transfer BTC 0.1
 *   node withdraw.js withdraw BTC all
 *   node withdraw.js withdraw ETH all --yes
 *   node withdraw.js sweep --yes
 *   node withdraw.js history [CCY]
 *
 * Flags:
 *   --chain <CHAIN>     optional if defaultChains[ccy] is set
 *   --tag <MEMO>        tag/memo if required
 *   --fee <FEE>         optional fee override (else OKX default / chain fee)
 *   --from trading|funding|auto   default: auto
 *   --yes               skip confirmation prompt
 *
 * Credentials: same as okx-bot.js (CONFIG below or OKX_* env vars)
 * API key needs: Read + Trade (transfer) + Withdraw (+ IP whitelist usually)
 */

'use strict';

const https = require('https');
const dns = require('dns');
const crypto = require('crypto');
const readline = require('readline');
const { URL } = require('url');

dns.setDefaultResultOrder('ipv4first');

// ============ PUT YOUR KEYS HERE (same as okx-bot.js) ============
const CONFIG = {
  apiKey: process.env.OKX_API_KEY || '61724dfb-b38a-4bb3-ac1c-51cb17a46429',
  secretKey: process.env.OKX_SECRET_KEY || '000F6D2DD53B3CAE02754AEC090E8E5E',
  passphrase: process.env.OKX_PASSPHRASE || 'Ls2798092/@@',
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

  // Default destination wallets (used when address omitted / sweep)
  wallets: {
    BTC: 'bc1qzvk44pust9ngvxgndnfrfxfc6xtf2k0gjnpnep',
    ETH: '0xD430c630b2F4f90F471b8d8BDdE36647db0F0702',
  },
  // Default withdraw networks
  defaultChains: {
    BTC: 'BTC-Bitcoin',
    ETH: 'ETH-ERC20',
  },
};
// ==================================================================

function defaultWallet(ccy) {
  const w = (CONFIG.wallets || {})[String(ccy || '').toUpperCase()];
  return w || '';
}

function defaultChain(ccy) {
  const c = (CONFIG.defaultChains || {})[String(ccy || '').toUpperCase()];
  return c || '';
}

let activeBaseUrl = CONFIG.baseUrl;

function requireCreds() {
  const { apiKey, secretKey, passphrase } = CONFIG;
  if (!apiKey || !secretKey || !passphrase) {
    console.error(`
Missing API credentials.

Copy the CONFIG keys from okx-bot.js into withdraw.js, or export:
  OKX_API_KEY
  OKX_SECRET_KEY
  OKX_PASSPHRASE

API key must allow Withdraw (and Trade for trading->funding transfer).
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
      '\nHint: DNS/proxy resolved OKX to 169.254.*. Disable VPN/AV HTTPS scan or set OKX_BASE_URL.';
  } else if (err && err.code === 'ETIMEDOUT') {
    tip = '\nHint: Timed out. Try OKX_BASE_URL=https://my.okx.com';
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
      'User-Agent': 'okx-withdraw-bot/1.0',
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
        family: 4,
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
      req.destroy(
        Object.assign(new Error(`connect ETIMEDOUT ${url.hostname}:443`), { code: 'ETIMEDOUT' })
      );
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

function pad(s, n) {
  s = String(s ?? '');
  return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length);
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function trimAmt(n) {
  // avoid scientific notation for API amounts
  return Number(n)
    .toFixed(12)
    .replace(/\.?0+$/, '');
}

async function getTradingAvail(ccy) {
  const q = ccy ? `?ccy=${encodeURIComponent(ccy)}` : '';
  const res = await request('GET', `/api/v5/account/balance${q}`);
  const details = (((res.data || [])[0] || {}).details) || [];
  if (ccy) {
    const row = details.find((d) => d.ccy === ccy.toUpperCase());
    return toNum(row && row.availBal);
  }
  return details;
}

async function getFundingAvail(ccy) {
  const q = ccy ? `?ccy=${encodeURIComponent(ccy)}` : '';
  const res = await request('GET', `/api/v5/asset/balances${q}`);
  const rows = res.data || [];
  if (ccy) {
    const row = rows.find((d) => d.ccy === ccy.toUpperCase());
    return toNum(row && row.availBal);
  }
  return rows;
}

async function getCurrencies(ccy) {
  const q = ccy ? `?ccy=${encodeURIComponent(ccy)}` : '';
  return request('GET', `/api/v5/asset/currencies${q}`);
}

async function transferTradingToFunding(ccy, amt) {
  const body = {
    ccy: ccy.toUpperCase(),
    amt: String(amt),
    from: '18', // trading
    to: '6', // funding
    type: '0',
  };
  return request('POST', '/api/v5/asset/transfer', body);
}

async function withdrawOnChain({ ccy, amt, toAddr, chain, fee, tag, clientId }) {
  const body = {
    ccy: ccy.toUpperCase(),
    amt: String(amt),
    dest: '4', // on-chain
    toAddr,
  };
  if (chain) body.chain = chain;
  if (fee !== undefined && fee !== null && fee !== '') body.fee = String(fee);
  if (tag) {
    // OKX accepts tag appended for some coins via toAddr "addr:tag" or separate — use addr:tag when tag set
    // Prefer explicit toAddr as-is if user already included tag; else append.
    if (!toAddr.includes(':') && !toAddr.includes('?dt=')) {
      body.toAddr = `${toAddr}:${tag}`;
    }
  }
  if (clientId) body.clientId = clientId;
  return request('POST', '/api/v5/asset/withdrawal', body);
}

async function getWithdrawHistory(ccy) {
  let path = '/api/v5/asset/withdrawal-history?limit=20';
  if (ccy) path += `&ccy=${encodeURIComponent(ccy)}`;
  return request('GET', path);
}

function matchChain(rows, chainArg, ccy) {
  if (!chainArg) return null;
  const wanted = chainArg.toUpperCase();
  const list = rows || [];
  return (
    list.find((r) => String(r.chain || '').toUpperCase() === wanted) ||
    list.find((r) => String(r.chain || '').toUpperCase() === `${ccy.toUpperCase()}-${wanted}`) ||
    list.find((r) => String(r.chain || '').toUpperCase().includes(wanted)) ||
    null
  );
}

function askConfirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || '').trim().toUpperCase() === 'YES');
    });
  });
}

function usage() {
  console.log(`
OKX Withdraw Bot

Commands:
  chains <CCY>                         List withdraw chains / fees / mins
  balance [CCY]                        Trading + funding available balances
  transfer <CCY> <AMT|all>             Move Trading -> Funding
  withdraw <CCY> <AMT|all> [ADDRESS]   Withdraw on-chain (address optional if in CONFIG.wallets)
  sweep                                Withdraw ALL for every coin in CONFIG.wallets
  wallets                              Show saved destination wallets
  history [CCY]                        Recent withdrawal history

Saved wallets:
  BTC -> ${CONFIG.wallets.BTC}
  ETH -> ${CONFIG.wallets.ETH}

Examples:
  node withdraw.js wallets
  node withdraw.js withdraw BTC all
  node withdraw.js withdraw ETH all --yes
  node withdraw.js sweep --yes

Notes:
  - Withdrawal leaves from Funding account
  - --from auto (default): transfer missing amount from Trading first
  - Type YES at confirmation (or pass --yes)
  - API key needs Withdraw permission + usually IP whitelist
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--chain' && args[i + 1]) flags.chain = args[++i];
    else if (a === '--tag' && args[i + 1]) flags.tag = args[++i];
    else if (a === '--fee' && args[i + 1]) flags.fee = args[++i];
    else if (a === '--from' && args[i + 1]) flags.from = args[++i].toLowerCase();
    else if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else positional.push(a);
  }
  return {
    cmd: (positional[0] || '').toLowerCase(),
    args: positional.slice(1),
    flags,
  };
}

async function cmdChains(ccy) {
  if (!ccy) throw new Error('Usage: chains <CCY>');
  const res = await getCurrencies(ccy);
  const rows = (res.data || []).filter((r) => String(r.canWd) === 'true' || r.canWd === true);
  console.log(`\n=== Withdraw chains for ${ccy.toUpperCase()} ===`);
  if (!rows.length) {
    console.log('(none withdrawable — check currency or API permissions)');
    return;
  }
  console.log(
    pad('CHAIN', 28) + pad('FEE', 14) + pad('MIN', 14) + pad('MAX', 18) + 'canWd'
  );
  console.log('-'.repeat(80));
  for (const r of rows) {
    console.log(
      pad(r.chain, 28) +
        pad(fmt(r.minFee || r.fee), 14) +
        pad(fmt(r.minWd), 14) +
        pad(fmt(r.maxWd), 18) +
        String(r.canWd)
    );
  }
}

async function cmdBalance(ccy) {
  console.log('\n=== Available for withdraw flow ===');
  if (ccy) {
    const [t, f] = await Promise.all([getTradingAvail(ccy), getFundingAvail(ccy)]);
    console.log(`${ccy.toUpperCase()} Trading avail : ${fmt(t)}`);
    console.log(`${ccy.toUpperCase()} Funding avail : ${fmt(f)}`);
    console.log(`${ccy.toUpperCase()} Combined      : ${fmt(t + f)}`);
    return;
  }
  const [trading, funding] = await Promise.all([getTradingAvail(), getFundingAvail()]);
  const map = new Map();
  for (const d of trading || []) {
    if (toNum(d.availBal) > 0) map.set(d.ccy, { trading: toNum(d.availBal), funding: 0 });
  }
  for (const d of funding || []) {
    const cur = map.get(d.ccy) || { trading: 0, funding: 0 };
    cur.funding = toNum(d.availBal);
    if (cur.trading > 0 || cur.funding > 0) map.set(d.ccy, cur);
  }
  console.log(pad('CCY', 10) + pad('Trading', 20) + pad('Funding', 20) + 'Combined');
  console.log('-'.repeat(64));
  for (const [k, v] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (v.trading <= 0 && v.funding <= 0) continue;
    console.log(
      pad(k, 10) + pad(fmt(v.trading), 20) + pad(fmt(v.funding), 20) + fmt(v.trading + v.funding)
    );
  }
}

async function cmdTransfer(ccy, amtArg) {
  if (!ccy || !amtArg) throw new Error('Usage: transfer <CCY> <AMT|all>');
  let amt = amtArg;
  if (String(amtArg).toLowerCase() === 'all') {
    const avail = await getTradingAvail(ccy);
    if (avail <= 0) throw new Error(`No ${ccy.toUpperCase()} available in Trading account`);
    amt = trimAmt(avail);
  }
  console.log(`\nTransfer Trading -> Funding: ${amt} ${ccy.toUpperCase()}`);
  const res = await transferTradingToFunding(ccy, amt);
  console.log('OK:', JSON.stringify(res.data, null, 2));
}

async function cmdHistory(ccy) {
  const res = await getWithdrawHistory(ccy);
  const rows = res.data || [];
  console.log('\n=== Recent withdrawals ===');
  if (!rows.length) {
    console.log('(none)');
    return;
  }
  for (const r of rows) {
    console.log('-'.repeat(60));
    console.log(`Time   : ${r.ts ? new Date(Number(r.ts)).toISOString() : ''}`);
    console.log(`CCY    : ${r.ccy}`);
    console.log(`Chain  : ${r.chain}`);
    console.log(`Amount : ${r.amt}`);
    console.log(`Fee    : ${r.fee}`);
    console.log(`State  : ${r.state}`); // 0:waiting 1:pending 2:failed 3? 4? — print raw
    console.log(`TxId   : ${r.txId || ''}`);
    console.log(`To     : ${r.to}`);
    console.log(`WdId   : ${r.wdId}`);
  }
}

async function cmdWallets() {
  console.log('\n=== Saved destination wallets ===');
  for (const [ccy, addr] of Object.entries(CONFIG.wallets || {})) {
    console.log(`${pad(ccy, 8)} ${addr}`);
    console.log(`${pad('', 8)} chain: ${defaultChain(ccy) || '(set with --chain)'}`);
  }
}

async function cmdSweep(flags) {
  const coins = Object.keys(CONFIG.wallets || {});
  if (!coins.length) throw new Error('No wallets configured in CONFIG.wallets');

  console.log('\n=== Sweep preview (all configured wallets) ===');
  for (const ccy of coins) {
    const [t, f] = await Promise.all([getTradingAvail(ccy), getFundingAvail(ccy)]);
    console.log(
      `${ccy}: trading=${fmt(t)} funding=${fmt(f)} total=${fmt(t + f)} -> ${defaultWallet(ccy)} (${defaultChain(ccy)})`
    );
  }

  if (!flags.yes) {
    const ok = await askConfirm('\nType YES to withdraw ALL for configured coins: ');
    if (!ok) {
      console.log('Cancelled.');
      return;
    }
  }

  for (const ccy of coins) {
    const total = (await getTradingAvail(ccy)) + (await getFundingAvail(ccy));
    if (total <= 0) {
      console.log(`\n[skip] ${ccy}: zero balance`);
      continue;
    }
    console.log(`\n######## Sweeping ${ccy} ########`);
    try {
      await cmdWithdraw(ccy, 'all', defaultWallet(ccy), {
        ...flags,
        yes: true,
        chain: flags.chain || defaultChain(ccy),
        from: flags.from || 'auto',
      });
    } catch (err) {
      console.error(`[fail] ${ccy}:`, err.message || err);
    }
  }
}

async function cmdWithdraw(ccy, amtArg, address, flags) {
  if (!ccy || !amtArg) {
    throw new Error('Usage: withdraw <CCY> <AMT|all> [ADDRESS] --chain <CHAIN>');
  }

  address = address || defaultWallet(ccy);
  if (!address) {
    throw new Error(
      `No address for ${ccy.toUpperCase()}. Pass address or set CONFIG.wallets.${ccy.toUpperCase()}`
    );
  }

  flags.chain = flags.chain || defaultChain(ccy);
  if (!flags.chain) {
    throw new Error('--chain is required (run: node withdraw.js chains ' + ccy + ')');
  }

  const fromMode = flags.from || 'auto';
  if (!['auto', 'trading', 'funding'].includes(fromMode)) {
    throw new Error('--from must be auto|trading|funding');
  }

  const curRes = await getCurrencies(ccy);
  const chainRow = matchChain(curRes.data || [], flags.chain, ccy);
  if (!chainRow) {
    throw new Error(
      `Chain not found for ${ccy.toUpperCase()}: ${flags.chain}\nRun: node withdraw.js chains ${ccy}`
    );
  }
  if (!(String(chainRow.canWd) === 'true' || chainRow.canWd === true)) {
    throw new Error(`Chain not withdrawable: ${chainRow.chain}`);
  }

  const chain = chainRow.chain;
  const fee = flags.fee !== undefined ? toNum(flags.fee) : toNum(chainRow.minFee || chainRow.fee);
  const minWd = toNum(chainRow.minWd);

  let trading = await getTradingAvail(ccy);
  let funding = await getFundingAvail(ccy);

  let wantAmt;
  if (String(amtArg).toLowerCase() === 'all') {
    // Leave enough for fee on funding after transfers
    const total = trading + funding;
    const maxOut = total - fee;
    if (maxOut <= 0) throw new Error(`Balance too small to cover fee (${fmt(fee)} ${ccy.toUpperCase()})`);
    wantAmt = maxOut;
  } else {
    wantAmt = toNum(amtArg);
  }

  if (!(wantAmt > 0)) throw new Error('Amount must be > 0');
  if (wantAmt < minWd) {
    throw new Error(`Amount ${fmt(wantAmt)} < min withdrawal ${fmt(minWd)} on ${chain}`);
  }

  const needOnFunding = wantAmt + fee;
  if (fromMode === 'funding' && funding + 1e-12 < needOnFunding) {
    throw new Error(
      `Funding avail ${fmt(funding)} < needed ${fmt(needOnFunding)} (amt+fee). Use --from auto`
    );
  }
  if (fromMode === 'trading' && trading + funding + 1e-12 < needOnFunding) {
    throw new Error(`Not enough total balance. Need ${fmt(needOnFunding)}, have ${fmt(trading + funding)}`);
  }
  if (fromMode === 'auto' && trading + funding + 1e-12 < needOnFunding) {
    throw new Error(
      `Not enough total balance. Need ${fmt(needOnFunding)} (amt ${fmt(wantAmt)} + fee ${fmt(fee)}), have ${fmt(
        trading + funding
      )}`
    );
  }

  console.log('\n=== Withdraw preview ===');
  console.log(`Currency : ${ccy.toUpperCase()}`);
  console.log(`Chain    : ${chain}`);
  console.log(`Address  : ${address}`);
  if (flags.tag) console.log(`Tag/Memo : ${flags.tag}`);
  console.log(`Amount   : ${fmt(wantAmt)}`);
  console.log(`Fee      : ${fmt(fee)}`);
  console.log(`Need     : ${fmt(needOnFunding)} (amount + fee)`);
  console.log(`Trading  : ${fmt(trading)}`);
  console.log(`Funding  : ${fmt(funding)}`);
  console.log(`From     : ${fromMode}`);
  if (CONFIG.simulated) console.log('[mode] simulated / demo trading');

  if (!flags.yes) {
    const ok = await askConfirm('\nType YES to submit withdrawal: ');
    if (!ok) {
      console.log('Cancelled.');
      return;
    }
  }

  // Move funds to funding if needed (for "all", move entire trading balance)
  funding = await getFundingAvail(ccy);
  trading = await getTradingAvail(ccy);
  if (funding + 1e-12 < needOnFunding) {
    if (fromMode === 'funding') {
      throw new Error('Insufficient funding balance');
    }
    const missing = needOnFunding - funding;
    const move = String(amtArg).toLowerCase() === 'all' ? trading : Math.min(trading, missing);
    const moveAmt = trimAmt(move);
    if (toNum(moveAmt) <= 0) throw new Error('Nothing to transfer from Trading');
    console.log(`\n[transfer] Trading -> Funding: ${moveAmt} ${ccy.toUpperCase()}`);
    const tr = await transferTradingToFunding(ccy, moveAmt);
    console.log('[transfer] OK', JSON.stringify(tr.data));
    await new Promise((r) => setTimeout(r, 1200));
    funding = await getFundingAvail(ccy);
    // refresh wantAmt after full transfer when sweeping all
    if (String(amtArg).toLowerCase() === 'all') {
      wantAmt = funding - fee;
      if (wantAmt < minWd) {
        throw new Error(
          `After transfer, withdrawable ${fmt(wantAmt)} < min ${fmt(minWd)} on ${chain}`
        );
      }
    }
  }

  if (funding + 1e-12 < needOnFunding) {
    throw new Error(
      `Funding still insufficient after transfer: ${fmt(funding)} < ${fmt(needOnFunding)}`
    );
  }

  const amtStr = trimAmt(wantAmt);
  const feeStr = trimAmt(fee);
  console.log(`\n[withdraw] submitting ${amtStr} ${ccy.toUpperCase()} on ${chain} ...`);
  const wd = await withdrawOnChain({
    ccy,
    amt: amtStr,
    toAddr: address,
    chain,
    fee: feeStr,
    tag: flags.tag,
  });
  console.log('\n=== Withdraw submitted ===');
  console.log(JSON.stringify(wd.data, null, 2));
  console.log('\nCheck status: node withdraw.js history ' + ccy.toUpperCase());
}

async function main() {
  const { cmd, args, flags } = parseArgs(process.argv);
  if (!cmd || flags.help) {
    usage();
    process.exit(cmd ? 0 : 1);
  }

  requireCreds();

  if (cmd === 'chains') return cmdChains(args[0]);
  if (cmd === 'balance') return cmdBalance(args[0]);
  if (cmd === 'transfer') return cmdTransfer(args[0], args[1]);
  if (cmd === 'history') return cmdHistory(args[0]);
  if (cmd === 'wallets') return cmdWallets();
  if (cmd === 'sweep') return cmdSweep(flags);
  if (cmd === 'withdraw') {
    // address optional when CONFIG.wallets has the coin
    const maybeAddr = args[2] && !String(args[2]).startsWith('--') ? args[2] : '';
    return cmdWithdraw(args[0], args[1], maybeAddr, flags);
  }

  usage();
  process.exit(1);
}

main().catch((err) => {
  console.error('\nError:', err.message || err);
  if (err && (err.okxCode === '50114' || /withdraw/i.test(String(err.message)))) {
    console.error(
      'Tip: Enable Withdraw on the API key, whitelist this server IP, and confirm chain/address/fee.'
    );
  }
  process.exit(1);
});
