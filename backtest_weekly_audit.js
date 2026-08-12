// backtest_weekly_audit.js
/**
 * Full Weekly Audit Report: Master Hybrid Portfolio
 * Covers May, June, July 2026 + completed weeks in August 2026.
 * For every ISO week:
 *   - Shows each day trades were taken (Mon–Fri)
 *   - Daily trade count & PnL per pair
 *   - Weekly summary: Trades | Wins | Losses | Win Rate | Slippage | Net Profit
 */

const config = require('./config');
const { getHistoricalCandles } = require('./dataFetcher');
const { runBacktest } = require('./backtester');

config.DEFAULT_HTF = '1h';
config.DEFAULT_LTF = '5m';

const MASTER_HYBRID_PORTFOLIO = {
  "BOOM500":   { name: "Boom 500",   mode: "TICK_SCALPING" },
  "CRASH500":  { name: "Crash 500",  mode: "SPIKE_CATCHING" },
  "1HZ100V":   { name: "Vol 100",    mode: "BOTH" },
  "BOOM1000":  { name: "Boom 1000",  mode: "TICK_SCALPING" },
  "CRASH1000": { name: "Crash 1000", mode: "SPIKE_CATCHING" },
  "CRASH600":  { name: "Crash 600",  mode: "SPIKE_CATCHING" }
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const R = "\x1b[0m";
const B = "\x1b[1m";
const G = "\x1b[32m";
const RED = "\x1b[31m";
const C = "\x1b[36m";
const Y = "\x1b[33m";
const DIM = "\x1b[2m";

function getISOWeekKey(ms) {
  const d = new Date(ms);
  // Clone and shift to Thursday of current week (ISO week reference day)
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
  return { year: tmp.getUTCFullYear(), week: weekNum, key: `${tmp.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}` };
}

function getWeekDateRange(year, week) {
  // Get Monday of the given ISO week
  const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
  const dow = simple.getUTCDay() || 7;
  if (dow !== 1) simple.setUTCDate(simple.getUTCDate() - (dow - 1));
  const friday = new Date(simple);
  friday.setUTCDate(simple.getUTCDate() + 4);
  const fmt = (d) => `${d.getUTCDate().toString().padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}`;
  return { monday: simple, friday, label: `${fmt(simple)}–${fmt(friday)}` };
}

function formatPnl(v) {
  if (v === 0) return DIM + '    $0.00' + R;
  return (v > 0 ? G : RED) + (v > 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(2) + R;
}

async function main() {
  const months = 3;
  console.log(`\n${B}${C}${'='.repeat(90)}`);
  console.log(`  FULL WEEKLY AUDIT REPORT — MASTER HYBRID PORTFOLIO (MAY–AUG 2026)`);
  console.log(`${'='.repeat(90)}${R}`);
  console.log(`  Strategy: 5M LTF / 1H HTF | Risk 1% per trade | 1:2 R:R | Spike Slippage Modelled`);
  console.log(`${'='.repeat(90)}\n`);

  // ── Fetch & Backtest All Assets ─────────────────────────────────────────────
  const symbols = Object.keys(MASTER_HYBRID_PORTFOLIO);
  const allTrades = []; // Flat list of all trades with symbol attached

  for (const symbol of symbols) {
    const item = MASTER_HYBRID_PORTFOLIO[symbol];
    config.BOOM_CRASH_MODE = item.mode;
    try {
      const ltf = await getHistoricalCandles(symbol, config.DEFAULT_LTF, months, false);
      const htf = await getHistoricalCandles(symbol, config.DEFAULT_HTF, months, false);
      const report = runBacktest(symbol, ltf, htf);
      report.trades.forEach(t => {
        t.symbol = symbol;
        t.symbolName = item.name;
        allTrades.push(t);
      });
    } catch (err) {
      console.error(`[ERROR] ${symbol}: ${err.message}`);
    }
  }

  // ── Group trades by ISO week ────────────────────────────────────────────────
  const weekMap = {};
  for (const t of allTrades) {
    const { key, year, week } = getISOWeekKey(t.entryTime);
    if (!weekMap[key]) weekMap[key] = { key, year, week, trades: [] };
    weekMap[key].trades.push(t);
  }

  // Sort weeks chronologically
  const weeks = Object.values(weekMap).sort((a, b) => a.key.localeCompare(b.key));

  // ── Print Weekly Audit ──────────────────────────────────────────────────────
  let grandTrades = 0, grandWins = 0, grandLosses = 0;
  let grandProfit = 0, grandSlippage = 0;

  for (const wk of weeks) {
    const { key, year, week, trades } = wk;
    const range = getWeekDateRange(year, week);

    // Group trades by day-of-week (entries) — Deriv synthetics run 24/7 including weekends
    const dayMap = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }; // 0=Sun, 1=Mon ... 6=Sat
    for (const t of trades) {
      const d = new Date(t.entryTime);
      const dow = d.getUTCDay();
      if (!dayMap[dow]) dayMap[dow] = [];
      dayMap[dow].push(t);
    }

    // Week-level stats
    const weekWins = trades.filter(t => t.result === 'win').length;
    const weekLosses = trades.length - weekWins;
    const weekWR = trades.length > 0 ? ((weekWins / trades.length) * 100).toFixed(1) : '0.0';
    const weekProfit = trades.reduce((s, t) => s + t.profit, 0);
    const weekSlippage = trades
      .filter(t => t.result === 'loss' && t.slippageMultiplier > 1)
      .reduce((s, t) => s + (t.riskAmount * (t.slippageMultiplier - 1)), 0);

    // Pairs active this week
    const pairsThisWeek = [...new Set(trades.map(t => t.symbolName))];

    console.log(`${B}${Y}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${R}`);
    console.log(`${B}  📅 ${key}  (${range.label})  |  Active Pairs: ${C}${pairsThisWeek.join(', ')}${R}`);
    console.log(`${B}  Weekly Total: ${G}${trades.length} Trades${R}  |  ${G}${weekWins} Wins${R}  |  ${RED}${weekLosses} Losses${R}  |  Win Rate: ${B}${weekWR}%${R}  |  Slippage: ${weekSlippage > 0 ? RED + '-$' + weekSlippage.toFixed(2) : DIM + '$0.00'}${R}  |  Net PnL: ${weekProfit >= 0 ? G + '+' : RED + '-'}$${Math.abs(weekProfit).toFixed(2)}${R}`);
    console.log(`  ${'-'.repeat(86)}`);

    // ── Daily Breakdown — all 7 days (synthetic indices trade 24/7) ─────────────
    // ISO week starts Monday. We iterate Sun(0), Mon(1)...Sat(6) in calendar order.
    // To show the week's days in calendar order: Mon Tue Wed Thu Fri Sat Sun
    const dowOrder = [1, 2, 3, 4, 5, 6, 0];
    for (const dow of dowOrder) {
      const dayTrades = dayMap[dow] || [];
      if (dayTrades.length === 0) continue;

      // Compute actual calendar date for this dow within the ISO week
      const d = new Date(range.monday);
      // Monday of the ISO week is our base (getUTCDay offset: Mon=1 → +0, Tue=1→+1, ...Sat=6→+5, Sun=0→+6)
      const offset = dow === 0 ? 6 : dow - 1;
      d.setUTCDate(d.getUTCDate() + offset);
      const dateStr = `${DAYS[dow]} ${d.getUTCDate().toString().padStart(2, '0')}/${String(d.getUTCMonth()+1).padStart(2, '0')}`;

      const dayWins   = dayTrades.filter(t => t.result === 'win').length;
      const dayLosses = dayTrades.length - dayWins;
      const dayProfit = dayTrades.reduce((s, t) => s + t.profit, 0);

      console.log(`  ${B}${dateStr}${R}  —  ${dayTrades.length} trade${dayTrades.length > 1 ? 's' : ''}  |  ${G}${dayWins}W${R} ${RED}${dayLosses}L${R}  |  Daily PnL: ${formatPnl(dayProfit)}`);

      // Per-trade detail (pair, direction, entry, SL, TP, result, profit, slippage flag)
      for (const t of dayTrades) {
        const dir = t.type === 'sell' ? `${RED}SELL${R}` : `${G} BUY${R}`;
        const res = t.result === 'win'
          ? `${G}WIN  +$${t.profit.toFixed(2)}${R}`
          : `${RED}LOSS -$${Math.abs(t.profit).toFixed(2)}${t.slippageMultiplier > 1 ? ' ⚠️SLIP x' + t.slippageMultiplier.toFixed(2) : ''}${R}`;
        console.log(`    ${DIM}│${R}  ${C}${t.symbolName.padEnd(10)}${R}  ${dir}  Entry: ${t.entryPrice.toFixed(2).padStart(10)}  SL: ${t.stopLoss.toFixed(2).padStart(10)}  TP: ${t.takeProfit.toFixed(2).padStart(10)}  →  ${res}`);
      }
    }

    // Per-pair summary for the week
    console.log(`  ${'-'.repeat(86)}`);
    const pairKeys = [...new Set(trades.map(t => t.symbol))];
    for (const sym of pairKeys) {
      const pt = trades.filter(t => t.symbol === sym);
      const pw = pt.filter(t => t.result === 'win').length;
      const pl = pt.length - pw;
      const pp = pt.reduce((s, t) => s + t.profit, 0);
      const name = MASTER_HYBRID_PORTFOLIO[sym].name;
      console.log(`    ${C}${name.padEnd(12)}${R}  ${pt.length} trades  ${G}${pw}W${R}/${RED}${pl}L${R}   ${pp >= 0 ? G + '+' : RED + '-'}$${Math.abs(pp).toFixed(2)}${R}`);
    }

    grandTrades += trades.length;
    grandWins += weekWins;
    grandLosses += weekLosses;
    grandProfit += weekProfit;
    grandSlippage += weekSlippage;
  }

  // ── Grand Total ─────────────────────────────────────────────────────────────
  console.log(`\n${B}${C}${'='.repeat(90)}${R}`);
  console.log(`${B}${C}  3-MONTH FULL AUDIT SUMMARY (All Weeks Combined)${R}`);
  console.log(`${B}${C}${'='.repeat(90)}${R}`);
  console.log(`  Total Weeks Audited  : ${B}${weeks.length} weeks${R}`);
  console.log(`  Total Trades         : ${B}${grandTrades}${R}  (${(grandTrades / weeks.length).toFixed(1)} trades/week avg)`);
  console.log(`  Total Wins           : ${B}${G}${grandWins}${R}`);
  console.log(`  Total Losses         : ${B}${RED}${grandLosses}${R}`);
  console.log(`  Overall Win Rate     : ${B}${((grandWins / grandTrades) * 100).toFixed(2)}%${R}`);
  console.log(`  Total Slippage Cost  : ${B}${RED}-$${grandSlippage.toFixed(2)}${R}`);
  console.log(`  Total Net Profit     : ${B}${grandProfit >= 0 ? G + '+' : RED + '-'}$${Math.abs(grandProfit).toFixed(2)}${R}`);
  console.log(`  Avg Weekly Net Profit: ${B}${G}+$${(grandProfit / weeks.length).toFixed(2)} / week${R}`);
  console.log(`${'='.repeat(90)}\n`);
}

main().catch(console.error);
