// reviewTrades.js
/**
 * Local CLI audit printer for Mytrada.
 * Reads synced live logs & ledgers from data/live_sync/ (pushed from VPS via /sync or midnight cron)
 * with automatic fallback to local cache/.
 *
 * Usage:
 *   node reviewTrades.js                # prints today's trades & verbatim Telegram feed
 *   node reviewTrades.js yesterday      # prints yesterday's trades & verbatim feed
 *   node reviewTrades.js 2026-11-11     # prints a specific date
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getDateString } = require('./reportManager');

const arg = (process.argv[2] || '').toLowerCase();
const offset = config.TIMEZONE_OFFSET_HOURS !== undefined ? config.TIMEZONE_OFFSET_HOURS : 1;

let targetDate;
if (arg === 'yesterday' || arg === 'yest') {
  targetDate = new Date(Date.now() + offset * 3600000 - 86400000).toISOString().split('T')[0];
} else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
  targetDate = arg;
} else {
  targetDate = new Date(Date.now() + offset * 3600000).toISOString().split('T')[0];
}

const syncDir = path.join(__dirname, 'data', 'live_sync');
const cacheDir = path.join(__dirname, 'cache');

function readJsonPreferSync(filename) {
  for (const dir of [syncDir, cacheDir]) {
    const p = path.join(dir, filename);
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) {}
    }
  }
  return [];
}

function readTelegramLogPreferSync(dateStr) {
  for (const dir of [path.join(syncDir, 'telegram_logs'), path.join(cacheDir, 'telegram_logs')]) {
    const p = path.join(dir, `${dateStr}.txt`);
    if (fs.existsSync(p)) {
      try {
        return fs.readFileSync(p, 'utf8').trim();
      } catch (e) {}
    }
  }
  return '';
}

const rawFeed = readTelegramLogPreferSync(targetDate);
const history = readJsonPreferSync('trade_history.json');
const incHistory = readJsonPreferSync('incubation_history.json');

const liveTrades = history.filter(t =>
  getDateString(t.signalTime) === targetDate ||
  getDateString(t.triggeredTime) === targetDate ||
  getDateString(t.closedTime) === targetDate
);
const paperTrades = incHistory.filter(t => getDateString(t.time) === targetDate);

console.log('============================================================');
console.log(`MYTRADA TRADE AUDIT & TELEGRAM FEED (${targetDate})`);
console.log('============================================================\n');

if (rawFeed) {
  console.log('--- VERBATIM TELEGRAM SIGNALS & OUTCOMES ---\n');
  console.log(rawFeed);
  console.log('\n============================================================\n');
} else {
  console.log(`(No verbatim telegram_logs/${targetDate}.txt found yet — showing ledger records)\n`);
}

console.log(`--- LIVE REAL-MONEY TRADES (${liveTrades.length}) ---\n`);
liveTrades.forEach((t, i) => {
  const dir = (t.type === 'bullish' || t.type === 'BUY') ? 'BUY' : 'SELL';
  const pnl = typeof t.pnlUSD === 'number' ? t.pnlUSD : 0;
  const pnlR = typeof t.pnlR === 'number' ? t.pnlR : 0;
  console.log(
    `[LIVE #${i + 1}] ${t.symbol} | ${dir} | ${t.strategy || 'Strategy 5B Pro'} | ` +
    `Entry: ${t.entryPrice} | SL: ${t.stopLoss} | TP: ${t.takeProfit} | ` +
    `Exit: ${t.exitPrice || 'OPEN'} | ${t.outcome || 'OPEN'} (${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} / ${pnlR >= 0 ? '+' : ''}${pnlR.toFixed(1)}R)`
  );
});

console.log(`\n--- PAPER SANDBOX TRADES (${paperTrades.length}) ---\n`);
paperTrades.forEach((p, i) => {
  const dir = (p.type === 'bullish' || p.type === 'BUY') ? 'BUY' : 'SELL';
  const pnl = typeof p.pnlUSD === 'number' ? p.pnlUSD : 0;
  const rVal = typeof p.rMultiple === 'number' ? p.rMultiple : (p.pnlR || 0);
  console.log(
    `[PAPER #${i + 1}] ${p.symbol} | ${dir} | ${p.strategy || 'Strategy 5B Pro'} | ` +
    `Entry: ${p.entryPrice} | SL: ${p.stopLoss ?? 'N/A'} | TP: ${p.takeProfit ?? 'N/A'} | ` +
    `Exit: ${p.exitPrice} | ${p.outcome} (${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} / ${rVal >= 0 ? '+' : ''}${rVal.toFixed(1)}R)`
  );
});
