#!/usr/bin/env node
// Don't trust Vlana, check it. No dependencies, Node 18+.
//
//   npx github:getvlana/verify            the site serves the public code, recent payout rounds add up and are on-chain
//   npx github:getvlana/verify round 91   one round in full: every node, every number, the memo on Solana
//   npx github:getvlana/verify me         is this machine going through Vlana right now, and via which node
//
// options: --api https://go.vlana.app   --rpc https://api.mainnet-beta.solana.com   --rounds 6
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const API = opt('api', 'https://go.vlana.app').replace(/\/$/, '');
const RPC = opt('rpc', 'https://api.mainnet-beta.solana.com');
const ROUNDS = +opt('rounds', 6);
const [cmd = 'all', arg] = args;

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n, s) => tty ? `\x1b[${n}m${s}\x1b[0m` : s;
const green = s => c(32, s), red = s => c(31, s), dim = s => c(2, s), bold = s => c(1, s), lime = s => c('38;5;191', s);
let failed = 0;
const line = (ok, what, note = '') => {
  if (ok === false) failed++;
  console.log(`  ${ok === true ? green('✓') : ok === false ? red('✗') : dim('·')} ${what}${note ? dim(`  ${note}`) : ''}`);
};
const head = s => console.log(`\n${bold(lime('▸ ' + s))}`);

const sha = b => createHash('sha256').update(b).digest('hex');
const get = async (url, as = 'json') => {
  const r = await fetch(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(20e3) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return as === 'json' ? r.json() : Buffer.from(await r.arrayBuffer());
};
const rpc = async (method, params) => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20e3) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};
const sol = n => `${(+n || 0).toLocaleString('en', { maximumFractionDigits: 9 })} SOL`;
const short = s => s ? `${s.slice(0, 4)}…${s.slice(-4)}` : '—';

// ---------- the served code is the public code ----------
async function code() {
  head(`${API} serves the public code`);
  const v = await get(API + '/api/version');
  const m = String(v.repo || '').match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (!m) { line(false, 'server names its GitHub repo', String(v.repo)); return; }
  console.log(dim(`  claims ${m[1]} @ ${v.commit.slice(0, 12)}`));
  for (const [file, { url, sha256 }] of Object.entries(v.files)) {
    const served = sha(await get(API + url, 'bytes'));
    const repo = sha(await get(`https://raw.githubusercontent.com/${m[1]}/${v.commit}/${file}`, 'bytes').catch(() => Buffer.from('missing')));
    line(served === repo && repo === sha256, `${url.padEnd(12)} = ${file}`, served === repo ? served.slice(0, 16) : `served ${served.slice(0, 12)} ≠ repo ${repo.slice(0, 12)}`);
  }
}

// ---------- payout rounds ----------
// the same arithmetic the server runs, in the same order, so floats match exactly
function recompute(R) {
  const rows = R.nodes.map(x => ({ ...x, uptime: x.checks ? x.ok / x.checks : 0 }));
  for (const r of rows) r.good = r.checks >= R.rules.minChecks && r.uptime >= R.rules.goodUptime;
  const per = {};
  for (const r of rows) if (r.good) per[r.country] = (per[r.country] || 0) + 1;
  for (const r of rows) r.raw = r.good ? r.uptime * (1 / Math.sqrt(per[r.country] || 1)) * (r.home ? R.rules.homeBonus : 1) : 0;
  const perOp = {};
  let rules = true;
  for (const r of rows) if (r.counted) { perOp[r.wallet] = (perOp[r.wallet] || 0) + 1; if (!r.good || perOp[r.wallet] > R.rules.maxPerOperator) rules = false; }
  const total = rows.reduce((s, r) => s + (r.counted ? r.raw : 0), 0);
  for (const r of rows) {
    r.share2 = r.counted && total ? r.raw / total : 0;
    r.amount2 = r.share2 > 0 ? Math.floor(R.pool * r.share2 * 1e9) / 1e9 : 0;
    r.match = Math.abs(r.share2 - r.share) < 1e-12 && Math.abs(r.amount2 - r.amount) < 1e-12;
  }
  const pool = Math.abs(R.inflow * R.operatorsPct / 100 + R.carry - R.pool) < 1e-9;
  return { rows, rules, pool, split: rows.every(r => r.match) };
}
async function onchain(d) {
  if (!d.memo) return { ok: null, note: 'memo not posted yet' };
  const tx = await rpc('getTransaction', [d.memo, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
  const logs = tx?.meta?.logMessages || [];
  const memo = logs.some(l => l.includes(`"vlana:r${d.n}:${d.hash}"`));
  const signed = logs.includes(`Program log: Signed by ${d.treasury}`);
  return { ok: !!tx && !tx.meta.err && memo && signed, memo, signed, tx, note: `tx ${short(d.memo)}${tx ? ' · ' + new Date(tx.blockTime * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : ''}` };
}
async function rounds() {
  head('payout rounds add up and are on Solana');
  const pay = await get(API + '/api/payouts');
  const recent = pay.rounds.filter(r => r.hash).slice(0, ROUNDS);
  if (!recent.length) { line(null, 'no receipts yet'); return; }
  for (const { n } of recent) {
    const d = await get(`${API}/api/rounds/${n}`);
    const R = JSON.parse(d.receipt);
    const x = recompute(R);
    const ch = await onchain(d).catch(e => ({ ok: null, note: 'rpc: ' + e.message }));
    const ok = sha(d.receipt) === d.hash && x.rules && x.pool && x.split;
    line(ok && ch.ok !== false ? (ch.ok ? true : null) : false, `round ${n}  ${sol(R.pool).padStart(16)} → ${R.nodes.filter(r => r.counted).length} nodes`, ch.note);
  }
  console.log(dim(`  details: verify round <n>`));
}
async function round(n) {
  head(`round ${n}`);
  const d = await get(`${API}/api/rounds/${n}`);
  const R = JSON.parse(d.receipt);
  console.log(dim(`  ${new Date(R.start).toISOString().slice(0, 16)} → ${new Date(R.end).toISOString().slice(11, 16)} UTC`));
  const h = sha(d.receipt);
  line(h === d.hash, 'receipt matches its sha256', h);
  const ch = await onchain(d).catch(e => ({ ok: null, note: 'rpc: ' + e.message }));
  line(ch.memo ?? ch.ok, 'the sha256 is in a memo on Solana', ch.note);
  if (d.memo) line(ch.signed ?? null, 'signed by the treasury', d.treasury);
  const x = recompute(R);
  line(x.pool, 'pool = fees in × operators% + carry', `${sol(R.inflow)} × ${R.operatorsPct}% + ${sol(R.carry)} = ${sol(R.pool)}`);
  line(x.rules, `only good nodes paid, max ${R.rules.maxPerOperator} per operator`, `good = ${R.rules.minChecks}+ checks, ${R.rules.goodUptime * 100}%+ passed`);
  line(x.split, 'split recomputed here matches the receipt');
  console.log('');
  for (const r of x.rows) console.log(`    ${r.name.padEnd(8)} ${dim(short(r.wallet))}  ${String(r.ok).padStart(3)}/${String(r.checks).padEnd(3)} ${r.home ? 'home' : '    '}  ${r.counted ? (r.match ? green(sol(r.amount)) : red(`${sol(r.amount)} ≠ ${sol(r.amount2)}`)) : dim('not paid')}`);
  if (d.payouts?.length) {
    console.log(dim('\n  transfers sent this round (they can include earlier rounds below the minimum):'));
    for (const p of d.payouts) console.log(`    ${short(p.wallet)}  ${sol(p.amount)}  ${dim('https://solscan.io/tx/' + p.tx)}`);
  }
}

// ---------- this machine ----------
async function me() {
  head('is this machine on Vlana?');
  const c = await get(API + '/api/check');
  line(c.node ? true : null, c.node ? `yes: sites see ${c.ip}, exit node ${bold(c.node.name)} (${c.node.country}, ${c.node.home ? 'home line' : 'datacenter'})` : `no: sites see ${c.ip}, which isn't a Vlana node`);
  if (c.node) console.log(dim(`    run by ${c.node.operator}`));
}

try {
  if (cmd === 'round') await round(+arg);
  else if (cmd === 'me') await me();
  else if (cmd === 'all') { await code(); await rounds(); }
  else { console.log('usage: verify [all | round <n> | me] [--api URL] [--rpc URL] [--rounds N]'); process.exit(2); }
} catch (e) { line(false, e.message); }
console.log(failed ? `\n${red(`${failed} check(s) failed`)}` : `\n${green('nothing to distrust')}`);
process.exit(failed ? 1 : 0);
