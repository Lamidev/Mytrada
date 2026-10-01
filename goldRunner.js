// goldRunner.js
/**
 * 👑 MYTRADA STRATEGY 5G: INDEPENDENT GOLD FLASH SCALPER RUNNER
 * Operates as a standalone daemon for XAUUSD (frxXAUUSD) on Deriv.
 * Completely decoupled from Boom & Crash, but delivers real-time alerts to Telegram.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getCandles } = require('./dataFetcher');
const { detectGoldFlashScalp, calculateGoldLotSize } = require('./goldScalper');
const { sendTelegramMessage } = require('./telegramBot');

const GOLD_SYMBOL = 'frxXAUUSD';
const GOLD_NAME = 'Gold / USD (XAUUSD)';
const CACHE_DIR = path.join(__dirname, 'cache');
const GOLD_TRADES_FILE = path.join(CACHE_DIR, 'gold_active_trades.json');
const GOLD_ALERTED_FILE = path.join(CACHE_DIR, 'gold_alerted_setups.json');

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// ── STATE MANAGEMENT ──
function loadGoldTrades() {
  if (fs.existsSync(GOLD_TRADES_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(GOLD_TRADES_FILE, 'utf8'));
    } catch (e) {
      return [];
    }
  }
  return [];
}

function saveGoldTrades(trades) {
  try {
    fs.writeFileSync(GOLD_TRADES_FILE, JSON.stringify(trades, null, 2), 'utf8');
  } catch (e) {}
}

function loadGoldAlerted() {
  if (fs.existsSync(GOLD_ALERTED_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(GOLD_ALERTED_FILE, 'utf8'));
    } catch (e) {
      return [];
    }
  }
  return [];
}

function saveGoldAlerted(list) {
  try {
    fs.writeFileSync(GOLD_ALERTED_FILE, JSON.stringify(list.slice(-50), null, 2), 'utf8');
  } catch (e) {}
}

// ── ACTIVE POSITION MONITOR ──
async function checkActiveGoldPositions(currentPrice) {
  const trades = loadGoldTrades();
  if (trades.length === 0) return;

  const remainingTrades = [];

  for (const t of trades) {
    const isBuy = t.direction === 'BUY';
    const hitTP = isBuy ? currentPrice >= t.tp : currentPrice <= t.tp;
    const hitSL = isBuy ? currentPrice <= t.sl : currentPrice >= t.sl;

    if (hitTP) {
      const profitPoints = Math.abs(t.tp - t.entry);
      await sendTelegramMessage([
        `🏆 🟢 <b>[MYTRADA GOLD TP HIT (+1.3R)]</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `<b>Asset:</b> <code>${GOLD_SYMBOL}</code> (${GOLD_NAME})`,
        `<b>Direction:</b> ${isBuy ? '🟢 BUY' : '🔴 SELL'}`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `💰 <b>Captured:</b> <code>+$${profitPoints.toFixed(2)} pts (+1.3R)</code>`,
        `🎯 <b>Entry:</b> <code>$${t.entry.toFixed(2)}</code> ➔ 🏆 <b>TP:</b> <code>$${t.tp.toFixed(2)}</code>`,
        `⚡ <b>Strategy:</b> <code>M1 Liquidity Flash Scalp</code>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `👌 <i>Target achieved cleanly. Ready for next M1 sweep!</i>`
      ].join('\n'));
      continue;
    }

    if (hitSL) {
      const lossPoints = Math.abs(t.sl - t.entry);
      await sendTelegramMessage([
        `🔴 🛡️ <b>[MYTRADA GOLD SL HIT (-1.0R)]</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `<b>Asset:</b> <code>${GOLD_SYMBOL}</code> (${GOLD_NAME})`,
        `<b>Direction:</b> ${isBuy ? '🟢 BUY' : '🔴 SELL'}`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `💸 <b>Loss:</b> <code>-$${lossPoints.toFixed(2)} pts (-1.0R)</code>`,
        `🔥 <b>Entry:</b> <code>$${t.entry.toFixed(2)}</code> ➔ 🛡️ <b>SL:</b> <code>$${t.sl.toFixed(2)}</code>`,
        `⚡ <b>Strategy:</b> <code>M1 Liquidity Flash Scalp</code>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `🛡️ <i>Wick breach detected. Fast disciplined exit executed.</i>`
      ].join('\n'));
      continue;
    }

    remainingTrades.push(t);
  }

  saveGoldTrades(remainingTrades);
}

// ── MAIN SCAN CYCLE ──
async function runGoldScanCycle() {
  try {
    const [m1Candles, m5Candles, m15Candles] = await Promise.all([
      getCandles(GOLD_SYMBOL, '1m', 60, true),
      getCandles(GOLD_SYMBOL, '5m', 40, true),
      getCandles(GOLD_SYMBOL, '15m', 50, true)
    ]);

    if (!m1Candles || m1Candles.length < 20) return;

    const latestPrice = m1Candles[m1Candles.length - 1].close;

    // Check existing positions first
    await checkActiveGoldPositions(latestPrice);

    // If an open Gold scalp is already running, wait for resolution before opening another
    const activeTrades = loadGoldTrades();
    if (activeTrades.length > 0) {
      return;
    }

    // Scan for new M1 liquidity setup
    const setup = detectGoldFlashScalp(m1Candles, m5Candles, m15Candles);
    if (!setup) return;

    // Prevent duplicate signals on the same candle
    const setupId = `${GOLD_SYMBOL}_${setup.direction}_${setup.entry.toFixed(2)}_${m1Candles[m1Candles.length - 1].time || Date.now()}`;
    const alerted = loadGoldAlerted();
    if (alerted.includes(setupId)) return;

    alerted.push(setupId);
    saveGoldAlerted(alerted);

    // Save as active position
    activeTrades.push({
      setupId,
      ...setup
    });
    saveGoldTrades(activeTrades);

    const isBuy = setup.direction === 'BUY';
    const dirEmoji = isBuy ? '🟢' : '🔴';

    // Broadcast Telegram Signal
    await sendTelegramMessage([
      `👑 🟡 <b>[MYTRADA GOLD FLASH SCALPER]</b>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `<b>Asset:</b> <code>${GOLD_SYMBOL}</code> (${GOLD_NAME})`,
      `<b>Action:</b> ${dirEmoji} <b>${setup.direction} (Market)</b>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `🎯 <b>Entry:</b> <code>$${setup.entry.toFixed(2)}</code>`,
      `🛡️ <b>Stop Loss:</b> <code>$${setup.sl.toFixed(2)}</code> (-$${setup.slDist.toFixed(2)} pts)`,
      `🏆 <b>Take Profit:</b> <code>$${setup.tp.toFixed(2)}</code> (+$${setup.tpDist.toFixed(2)} pts • 1:1.3 R:R)`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `📊 <b>Timeframe:</b> <code>1-Minute (M1 Flash Scalp)</code>`,
      `🔍 <b>Setup:</b> ${setup.rationale}`,
      `⚡ <b>M15 Flow Bias:</b> <code>${setup.m15Bias}</code>`,
      `⏱️ <b>Expected Hold:</b> <code>45 – 120 Seconds</code>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`
    ].join('\n'));

    console.log(`\n👑 [GOLD SCALPER ALERT] Dispatched ${setup.direction} signal @ $${setup.entry.toFixed(2)} (SL: $${setup.sl.toFixed(2)} | TP: $${setup.tp.toFixed(2)})\n`);
  } catch (err) {
    console.error(`[goldRunner Error]:`, err.message);
  }
}

// ── DAEMON SERVICE RUNNER ──
async function startGoldDaemon() {
  console.log(`\n👑 ===============================================================`);
  console.log(`👑 MYTRADA STRATEGY 5G: INDEPENDENT GOLD FLASH SCALPER DAEMON`);
  console.log(`👑 Active Asset: ${GOLD_NAME} (${GOLD_SYMBOL}) | Timeframe: M1`);
  console.log(`👑 Telegram Notifications: ENABLED`);
  console.log(`👑 ===============================================================\n`);

  await sendTelegramMessage([
    `🚀 <b>[MYTRADA GOLD SCALPER ONLINE]</b>`,
    `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
    `• <b>Asset:</b> <code>${GOLD_NAME}</code>`,
    `• <b>Timeframe:</b> <code>1-Minute (M1 Flash Scalp)</code>`,
    `• <b>Strategy:</b> <code>Liquidity Sweep & Elastic Rebound</code>`,
    `• <b>Risk Model:</b> <code>1:1.3 R:R (Target: +$1.30 - $2.00 pts)</code>`,
    `• <b>Status:</b> <b>INDEPENDENT DAEMON ACTIVE & SCANNING</b>`,
    `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`
  ].join('\n'));

  // Polling loop: Runs every 15 seconds to catch live M1 candle closes
  setInterval(async () => {
    await runGoldScanCycle();
  }, 15000);

  // Initial immediate scan
  await runGoldScanCycle();
}

if (require.main === module) {
  startGoldDaemon();
}

module.exports = {
  startGoldDaemon,
  runGoldScanCycle
};
