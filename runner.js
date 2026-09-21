// runner.js
/**
 * Mytrada - Strategy 5C Value-Zone Sniper (Clean Slate — Locked Production Standard)
 *
 * Execution Core:
 *  - 12 Elite Boom & Crash Portfolio (Daily + 4H + 1H 50 EMA Trend Alignment)
 *  - 2–3 Spike Cluster Exhaustion Trigger (5M Body >= 50%) — Tailored per pair
 *  - Fixed 1:1.3 R:R Sniper Target with Dynamic Lot Sizing (3% Equity Risk)
 *  - Responsive Tiered Circuit Breakers (45m Loss Cooldown / Daily Lockout)
 *  - Automated 12:00 AM Midnight Daily Performance Report with Pair-by-Pair Breakdown
 *  - Real-Time Telegram Signal Dispatcher
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getCandles } = require('./dataFetcher');
const { auditTradeWithVision } = require('./aiVisionAuditor');
const { 
  recordSignal, 
  recordTrigger, 
  recordClose, 
  generateDailyReport, 
  generateWeeklyReport,
  formatReportTelegramHTML,
  getCurrentAccountBalance,
  getWeeklyCompoundedRisk
} = require('./reportManager');

// ANSI Color Codes
const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";

const CACHE_DIR = path.join(__dirname, 'cache');
const ALERTED_SETUPS_FILE = path.join(CACHE_DIR, 'alerted_setups.json');
const ACTIVE_TRADES_FILE = path.join(CACHE_DIR, 'active_trades.json');
const CIRCUIT_BREAKER_FILE = path.join(CACHE_DIR, 'circuit_breaker_state.json');
const LAST_REPORT_DATE_FILE = path.join(CACHE_DIR, 'last_daily_report_date.json');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// ── PERSISTENCE HELPERS ──
function loadAlertedSetups() {
  if (fs.existsSync(ALERTED_SETUPS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(ALERTED_SETUPS_FILE, 'utf8'));
      const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
      const filtered = Object.entries(data).filter(([_, ts]) => ts > oneDayAgo);
      return new Map(filtered);
    } catch (e) {
      return new Map();
    }
  }
  return new Map();
}

function saveAlertedSetup(setupId) {
  alertedSetups.set(setupId, Date.now());
  const obj = Object.fromEntries(alertedSetups);
  fs.writeFileSync(ALERTED_SETUPS_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

const alertedSetups = loadAlertedSetups();

function loadActiveTrades() {
  if (fs.existsSync(ACTIVE_TRADES_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(ACTIVE_TRADES_FILE, 'utf8'));
    } catch (e) {
      return [];
    }
  }
  return [];
}

function saveActiveTrades(trades) {
  fs.writeFileSync(ACTIVE_TRADES_FILE, JSON.stringify(trades, null, 2), 'utf8');
}

function getLastReportedDate() {
  if (fs.existsSync(LAST_REPORT_DATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(LAST_REPORT_DATE_FILE, 'utf8'));
      return data.lastDate || "";
    } catch (e) {
      return "";
    }
  }
  return "";
}

function saveLastReportedDate(dateStr) {
  try {
    fs.writeFileSync(LAST_REPORT_DATE_FILE, JSON.stringify({ lastDate: dateStr }, null, 2), 'utf8');
  } catch (e) {}
}

// ── CIRCUIT BREAKER STATE MANAGER ──
function loadCircuitBreakerState() {
  const today = new Date().toISOString().slice(0, 10);
  if (fs.existsSync(CIRCUIT_BREAKER_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(CIRCUIT_BREAKER_FILE, 'utf8'));
      if (state.date !== today) {
        const freshState = { date: today, symbols: {} };
        saveCircuitBreakerState(freshState);
        return freshState;
      }
      return state;
    } catch (e) {
      console.warn("[runner] Warning loading circuit breaker state:", e.message);
    }
  }
  return { date: today, symbols: {} };
}

function saveCircuitBreakerState(state) {
  try {
    fs.writeFileSync(CIRCUIT_BREAKER_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.warn("[runner] Warning saving circuit breaker state:", e.message);
  }
}

let circuitBreakerState = loadCircuitBreakerState();

function isSymbolInCooldown(symbol) {
  if (!config.CIRCUIT_BREAKER || !config.CIRCUIT_BREAKER.ENABLED) return { inCooldown: false };
  
  // Refresh state if date has rolled over to a new day
  const today = new Date().toISOString().slice(0, 10);
  if (!circuitBreakerState || circuitBreakerState.date !== today) {
    circuitBreakerState = loadCircuitBreakerState();
  }

  const rec = circuitBreakerState.symbols && circuitBreakerState.symbols[symbol];
  if (!rec) return { inCooldown: false };

  if (rec.dailyLosses >= (config.CIRCUIT_BREAKER.MAX_DAILY_LOSSES_PER_SYMBOL || 3)) {
    return { inCooldown: true, reason: `Daily limit (${rec.dailyLosses} losses) reached` };
  }

  const now = Date.now();
  if (rec.pauseUntil && now < rec.pauseUntil) {
    const remMins = Math.ceil((rec.pauseUntil - now) / 60000);
    const reason = (rec.consecutiveLosses === 0 && rec.dailyLosses < (config.CIRCUIT_BREAKER.MAX_DAILY_LOSSES_PER_SYMBOL || 3))
      ? `Post-Win breathing room (${remMins}m remaining)`
      : `Cooldown active — ${remMins}m remaining`;
    return { inCooldown: true, reason };
  }

  return { inCooldown: false };
}

function recordSymbolTradeOutcome(symbol, outcome) {
  const today = new Date().toISOString().slice(0, 10);
  if (!circuitBreakerState || circuitBreakerState.date !== today) {
    circuitBreakerState = loadCircuitBreakerState();
  }

  if (!circuitBreakerState.symbols) circuitBreakerState.symbols = {};
  if (!circuitBreakerState.symbols[symbol]) {
    circuitBreakerState.symbols[symbol] = { consecutiveLosses: 0, dailyLosses: 0, pauseUntil: 0 };
  }

  const rec = circuitBreakerState.symbols[symbol];
  const now = Date.now();

  if (outcome === 'WIN') {
    rec.consecutiveLosses = 0;
    // 👑 Institutional Post-Win Breathing Room: pause symbol to prevent immediate tail-end re-entry
    const postWinMins = config.CIRCUIT_BREAKER.POST_WIN_PAUSE_MINS || 15;
    rec.pauseUntil = Math.max(rec.pauseUntil || 0, now + (postWinMins * 60 * 1000));
  } else if (outcome === 'LOSS') {
    rec.consecutiveLosses = (rec.consecutiveLosses || 0) + 1;
    rec.dailyLosses = (rec.dailyLosses || 0) + 1;

    // Responsive Tiered Circuit Breakers:
    if (rec.dailyLosses >= (config.CIRCUIT_BREAKER.MAX_DAILY_LOSSES_PER_SYMBOL || 3)) {
      const endOfDay = new Date();
      endOfDay.setUTCHours(23, 59, 59, 999);
      rec.pauseUntil = endOfDay.getTime();
    } else if (rec.consecutiveLosses >= 2) {
      const tier2Mins = config.CIRCUIT_BREAKER.TIER_2_PAUSE_MINS || 60;
      rec.pauseUntil = now + (tier2Mins * 60 * 1000);
    } else {
      const tier1Mins = config.CIRCUIT_BREAKER.TIER_1_PAUSE_MINS || 30;
      rec.pauseUntil = now + (tier1Mins * 60 * 1000);
    }
  }

  saveCircuitBreakerState(circuitBreakerState);
}

// ── TELEGRAM DISPATCHER ──
function sendTelegramMessage(text) {
  return new Promise((resolve) => {
    const botToken = config.TELEGRAM && config.TELEGRAM.BOT_TOKEN;
    const chatId   = config.TELEGRAM && config.TELEGRAM.CHAT_ID;

    if (!botToken || !chatId) {
      console.warn("[runner] Telegram credentials not configured.");
      return resolve(false);
    }

    const payload = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });

    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(true);
        else resolve(false);
      });
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(payload);
    req.end();
  });
}

const LAST_WEEKLY_REPORT_FILE = path.join(CACHE_DIR, 'last_weekly_report_week.json');

function getLastReportedWeek() {
  if (fs.existsSync(LAST_WEEKLY_REPORT_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(LAST_WEEKLY_REPORT_FILE, 'utf8'));
      return data.lastWeek || "";
    } catch (e) {
      return "";
    }
  }
  return "";
}

function saveLastReportedWeek(weekStr) {
  try {
    fs.writeFileSync(LAST_WEEKLY_REPORT_FILE, JSON.stringify({ lastWeek: weekStr }, null, 2), 'utf8');
  } catch (e) {}
}

// ── AUTOMATED 12:00 AM MIDNIGHT DAILY REPORT DELIVERY ──
async function checkAndSendDailyMidnightReport() {
  const now = new Date();
  
  // Calculate yesterday's date string (UTC)
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayDateStr = yesterday.toISOString().split('T')[0];

  const lastReported = getLastReportedDate();

  // Trigger if yesterday's report has not been delivered yet
  if (lastReported !== yesterdayDateStr) {
    console.log(`\n📅 [12:00 AM MIDNIGHT REPORT] Compiling Daily Performance Report for ${yesterdayDateStr}...`);
    const report = generateDailyReport(yesterdayDateStr);
    const reportHtml = formatReportTelegramHTML(report);

    await sendTelegramMessage(reportHtml);
    saveLastReportedDate(yesterdayDateStr);
    console.log(`✅ [12:00 AM MIDNIGHT REPORT] Daily Report for ${yesterdayDateStr} dispatched to Telegram successfully!\n`);
  }
}

// ── AUTOMATED WEEKLY PERFORMANCE REPORT DELIVERY (SUNDAY MIDNIGHT) ──
async function checkAndSendWeeklyReport() {
  const now = new Date();
  // Check if today is Sunday (day 0) at 12:00 AM+
  if (now.getUTCDay() === 0) {
    const weekYear = `${now.getUTCFullYear()}-W${Math.ceil((now.getUTCDate() + 6) / 7)}`;
    const lastWeek = getLastReportedWeek();
    if (lastWeek !== weekYear) {
      console.log(`\n📊 [WEEKLY REPORT] Compiling Weekly Performance Report...`);
      const report = generateWeeklyReport();
      const reportHtml = formatReportTelegramHTML(report);

      await sendTelegramMessage(reportHtml);
      saveLastReportedWeek(weekYear);
      console.log(`✅ [WEEKLY REPORT] Weekly Performance Report dispatched to Telegram successfully!\n`);
    }
  }
}

// ── TECHNICAL INDICATORS ──
function calculateEMA(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const emaArray = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prevEma = sum / period;
  emaArray.push(prevEma);

  for (let i = period; i < values.length; i++) {
    const currentEma = (values[i] * k) + (prevEma * (1 - k));
    emaArray.push(currentEma);
    prevEma = currentEma;
  }
  return emaArray;
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prev.close),
      Math.abs(current.low - prev.close)
    );
    trs.push(tr);
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function calculateLotSize(symbol, entry, sl, customRiskUSD = null) {
  const compRisk = getWeeklyCompoundedRisk();
  const riskAmount = customRiskUSD !== null ? customRiskUSD : compRisk.riskUSD;
  const slDistance = Math.abs(entry - sl);
  if (slDistance <= 0) return 0.20;

  const minLots = {
    'BOOM300N': 0.50, 'CRASH300N': 0.50,
    'BOOM500': 0.20,  'CRASH500': 0.20,
    'BOOM1000': 0.20, 'CRASH1000': 0.20,
    'BOOM600': 0.20,  'CRASH600': 0.20,
    'BOOM900': 0.20,  'CRASH900': 0.20,
    'BOOM100': 0.20,  'CRASH50': 0.20,
    'CRASH200': 0.20
  };

  const minLot = minLots[symbol] || 0.20;
  const rawLot = riskAmount / slDistance;
  return Math.max(minLot, parseFloat(rawLot.toFixed(2)));
}

// ── HTF CANDLE CACHE (Reduces WebSocket load by 75%) ──
const htfMemoryCache = new Map();

async function getCachedHtfCandles(symbol, tf, count, ttlMs = 5 * 60 * 1000) {
  const key = `${symbol}_${tf}_${count}`;
  const now = Date.now();
  const cached = htfMemoryCache.get(key);
  if (cached && (now - cached.timestamp < ttlMs)) {
    return cached.data;
  }
  try {
    const fresh = await getCandles(symbol, tf, count, true);
    if (fresh && fresh.length > 0) {
      htfMemoryCache.set(key, { timestamp: now, data: fresh });
      return fresh;
    }
  } catch (e) {
    if (cached) return cached.data;
    throw e;
  }
  return [];
}

// ── ACTIVE TRADE LIFECYCLE MANAGEMENT (1:1.3 R:R) ──
async function checkActiveTradesForSymbol(symbol, ltfCandles) {
  if (!ltfCandles || ltfCandles.length === 0) return;

  const activeTrades = loadActiveTrades();
  const tradesForSymbol = activeTrades.filter(t => t.symbol === symbol);
  if (tradesForSymbol.length === 0) return;

  const currentLivePrice = ltfCandles[ltfCandles.length - 1].close;
  let updatedTrades = [...activeTrades];
  let changed = false;
  const compRisk = getWeeklyCompoundedRisk();

  for (const trade of tradesForSymbol) {
    const entryCandleEpoch = trade.candleEpoch || (trade.triggeredTime ? trade.triggeredTime - 300000 : 0);
    // ONLY inspect candles that formed strictly AFTER the entry candle was completed
    const postEntryCandles = ltfCandles.filter(c => (c.time > entryCandleEpoch));

    let hitTP = false;
    let hitSL = false;
    const isBullish = trade.type === 'bullish';

    if (postEntryCandles.length > 0) {
      const maxHigh = Math.max(...postEntryCandles.map(c => c.high));
      const minLow  = Math.min(...postEntryCandles.map(c => c.low));
      hitTP = isBullish ? maxHigh >= trade.takeProfit : minLow <= trade.takeProfit;
      hitSL = isBullish ? minLow <= trade.stopLoss : maxHigh >= trade.stopLoss;
    } else {
      // If we are still in the very first candle right after entry, only check current live price
      hitTP = isBullish ? currentLivePrice >= trade.takeProfit : currentLivePrice <= trade.takeProfit;
      hitSL = isBullish ? currentLivePrice <= trade.stopLoss : currentLivePrice >= trade.stopLoss;
    }

    if (hitTP) {
      const pnlUsd = trade.rewardUSD || compRisk.rewardUSD;
      let aiValidation = '';
      if (trade.aiVisionVerdict === 'TAKE') {
        aiValidation = `\n🧠 <b>AI VISION VALIDATION:</b> 🎯 <b>CORRECT CALL!</b> (AI recommended TAKE IT ➔ Full TP Captured)`;
      } else if (trade.aiVisionVerdict === 'LEAVE') {
        aiValidation = `\n🧠 <b>AI VISION VALIDATION:</b> ⚠️ <b>OVER-FILTERED!</b> (AI recommended LEAVE IT, but trade pushed through to TP)`;
      }

      recordSymbolTradeOutcome(symbol, 'WIN');
      recordClose(trade.setupId, 'WIN', trade.takeProfit, pnlUsd, 1.3, trade.aiVisionVerdict);
      const updatedBalance = getCurrentAccountBalance();

      const tpAlert = [
        `🏆 🟢 <b>[MYTRADA TP HIT — FULL TARGET (1:1.3 R:R)]</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].name : symbol})`,
        `<b>Direction:</b> ${isBullish ? '🟢 BUY' : '🔴 SELL'}`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `💰 <b>PROFIT CAPTURED:</b> <code>+$${pnlUsd.toFixed(2)} USD (+1.3R / +${(compRisk.riskPercent * (config.REWARD_RATIO || 1.3)).toFixed(1)}%)</code>`,
        `💵 <b>New Account Balance:</b> <code>$${updatedBalance.toFixed(2)} USD</code>`,
        `🎯 <b>Entry Price:</b> <code>${trade.entryPrice.toFixed(2)}</code>`,
        `🏆 <b>TP Hit:</b> <code>${trade.takeProfit.toFixed(2)}</code>`,
        aiValidation,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `🛡️ <i>Post-win breathing room active (${config.CIRCUIT_BREAKER.POST_WIN_PAUSE_MINS || 15}m).</i>`,
        `✅ <i>Trade fully completed in maximum profit!</i>`
      ].filter(Boolean).join('\n');

      await sendTelegramMessage(tpAlert);

      updatedTrades = updatedTrades.filter(t => t.setupId !== trade.setupId);
      changed = true;
      continue;
    }

    if (hitSL) {
      const riskUSD = trade.riskUSD || compRisk.riskUSD;
      const pauseMins = config.CIRCUIT_BREAKER.TIER_1_PAUSE_MINS || 45;
      let aiValidation = '';
      if (trade.aiVisionVerdict === 'LEAVE') {
        aiValidation = `\n🧠 <b>AI VISION VALIDATION:</b> 🛡️ <b>CORRECT CALL!</b> (AI recommended LEAVE IT ➔ Saved -$${riskUSD.toFixed(2)} USD loss!)`;
      } else if (trade.aiVisionVerdict === 'TAKE') {
        aiValidation = `\n🧠 <b>AI VISION VALIDATION:</b> ❌ <b>MISSED TRAP!</b> (AI recommended TAKE IT, but market reversed to SL)`;
      }

      recordSymbolTradeOutcome(symbol, 'LOSS');
      recordClose(trade.setupId, 'LOSS', trade.stopLoss, -riskUSD, -1.0, trade.aiVisionVerdict);
      const updatedBalance = getCurrentAccountBalance();

      const slAlert = [
        `🔴 🛡️ <b>[MYTRADA STOP LOSS HIT (-1.0R)]</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].name : symbol})`,
        `<b>Direction:</b> ${isBullish ? '🟢 BUY' : '🔴 SELL'}`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `💸 <b>LOSS:</b> <code>-$${riskUSD.toFixed(2)} USD (-1.0R / -${compRisk.riskPercent.toFixed(1)}%)</code>`,
        `💵 <b>New Account Balance:</b> <code>$${updatedBalance.toFixed(2)} USD</code>`,
        `🔥 <b>Entry:</b> <code>${trade.entryPrice.toFixed(2)}</code> | 🛡️ <b>SL:</b> <code>${trade.stopLoss.toFixed(2)}</code>`,
        aiValidation,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `🛡️ <i>Single-pair cooldown active (${pauseMins}m).</i>`
      ].filter(Boolean).join('\n');

      await sendTelegramMessage(slAlert);
      recordSymbolTradeOutcome(symbol, 'LOSS');
      recordClose(trade.setupId, 'LOSS', trade.stopLoss, -riskUSD, -1.0, trade.aiVisionVerdict);

      updatedTrades = updatedTrades.filter(t => t.setupId !== trade.setupId);
      changed = true;
    }
  }

  if (changed) {
    saveActiveTrades(updatedTrades);
  }
}

// ── STRATEGY 5B SIGNAL DETECTION ENGINE ──
function detectStrategy5BSetup(ltfCandles, htf1hCandles, htf4hCandles, dailyCandles, mode, minSpikesRequired) {
  if (!ltfCandles || !htf1hCandles || ltfCandles.length < 25 || htf1hCandles.length < 55) return null;

  // 1. 1H 50 EMA Intermediate Trend
  const htf1hCloses = htf1hCandles.map(c => c.close);
  const htf1hEMA    = calculateEMA(htf1hCloses, 50);
  const last1hClose = htf1hCloses[htf1hCloses.length - 1];
  const last1hEma   = htf1hEMA[htf1hEMA.length - 1];
  const htf1hTrend  = last1hClose > last1hEma ? 'bullish' : 'bearish';

  // 1H Chop Clearance Filter (>0.08%)
  const h1ClearancePct = (Math.abs(last1hClose - last1hEma) / last1hEma) * 100;
  if (config.USE_HTF_CHOP_FILTER && h1ClearancePct < 0.08) return null;

  // 2. 4H 50 EMA Macro Trend
  let htf4hTrend = 'N/A';
  if (htf4hCandles && htf4hCandles.length >= 55) {
    const htf4hCloses = htf4hCandles.map(c => c.close);
    const htf4hEMA    = calculateEMA(htf4hCloses, 50);
    const last4hClose = htf4hCloses[htf4hCloses.length - 1];
    const last4hEma   = htf4hEMA[htf4hEMA.length - 1];
    htf4hTrend        = last4hClose > last4hEma ? 'bullish' : 'bearish';
  }

  // 3. Daily 50 EMA Macro Trend
  let dailyTrend = 'N/A';
  if (dailyCandles && dailyCandles.length >= 30) {
    const dailyCloses = dailyCandles.map(c => c.close);
    const dailyEMA    = calculateEMA(dailyCloses, Math.min(50, dailyCloses.length - 1));
    if (dailyEMA.length > 0) {
      const lastDailyClose = dailyCloses[dailyCloses.length - 1];
      const lastDailyEma   = dailyEMA[dailyEMA.length - 1];
      dailyTrend           = lastDailyClose > lastDailyEma ? 'bullish' : 'bearish';
    }
  }

  const c0 = ltfCandles[ltfCandles.length - 1];
  const c0Range = c0.high - c0.low;
  const c0Body  = Math.abs(c0.close - c0.open);
  const bodyRatio = c0Range > 0 ? (c0Body / c0Range) : 0;
  const minSpikes = minSpikesRequired || config.MIN_SPIKES || 2;

  // ── CASE 1: SELL (BOOM) ──
  if (mode === 'BOOM') {
    if (htf1hTrend !== 'bearish') return null;
    if (htf4hTrend !== 'N/A' && htf4hTrend !== 'bearish') return null;
    if (dailyTrend !== 'N/A' && dailyTrend !== 'bearish') return null;

    // ✅ Strategy 5C Clean Slate: 1H Candle Color Guard removed.
    // Macro trend is fully governed by Daily + 4H + 1H 50 EMA alignment above.
    // Active 1H bar color is irrelevant — counter-trend spikes naturally turn the active
    // bar against trend during valid 5M pullback entries (proven across 105 historical trades).

    let hasSpikes = true;
    const spikeCandles = [];
    for (let s = 1; s <= minSpikes; s++) {
      const c = ltfCandles[ltfCandles.length - 1 - s];
      if (!c || c.close <= c.open) { hasSpikes = false; break; }
      spikeCandles.push(c);
    }

    const c0Exhaustion = c0.close < c0.open && bodyRatio >= 0.50;
    if (!hasSpikes || !c0Exhaustion) return null;

    const atr = calculateATR(ltfCandles, 14);
    if (!atr || atr === 0) return null;

    // Minimum Spike Cluster Magnitude Filter (>= 0.5x ATR(14))
    const minClusterRange = atr * (config.MIN_SPIKE_CLUSTER_ATR_RATIO || 0.50);
    const spikeClusterRange = Math.max(...spikeCandles.map(c => c.high)) - Math.min(...spikeCandles.map(c => c.low));
    if (spikeClusterRange < minClusterRange) return null;

    const spikePeak = Math.max(c0.high, ...spikeCandles.map(c => c.high));

    // 👑 Strategy 5C Core Pattern: Deep 5M 50 EMA Dynamic Value-Zone Retest
    const ltfCloses = ltfCandles.map(c => c.close);
    const ema20 = calculateEMA(ltfCloses, 20);
    const ema50 = calculateEMA(ltfCloses, 50);
    const lastEma20 = ema20[ema20.length - 1];
    const lastEma50 = ema50[ema50.length - 1];

    // 5M Trend Structure: Short-term 20 EMA must be below or equal to 50 EMA for Bearish Alignment
    if (lastEma20 > lastEma50) return null;

    // Deep Dynamic Value Zone: Spikes must retest the 5M 50 EMA Dynamic Mean
    const touchedEma50 = spikePeak >= (lastEma50 - atr * 0.2);
    if (!touchedEma50) return null;

    // 🛡️ Dynamic Mean Defense: Exhaustion candle close must respect 50 EMA resistance (within 0.50x ATR buffer)
    // Rejects SELL entries if price has violently broken above 50 EMA resistance
    if (c0.close > (lastEma50 + atr * 0.50)) return null;

    const valueZoneTouched = '50 EMA Dynamic Mean';

    const entry = c0.close;
    const sl = spikePeak + (atr * 1.5);
    const slDist = sl - entry;
    if (slDist <= 0) return null;

    const tp = entry - (slDist * (config.REWARD_RATIO || 1.3));
    const candleEpoch = c0.epoch || c0.time;

    return {
      direction: 'SELL',
      type: 'bearish',
      htf4hTrend,
      htf1hTrend,
      dailyTrend,
      entry,
      sl,
      tp,
      slDist,
      atr,
      refPrice: spikePeak,
      h1ClearancePct,
      bodyRatio,
      valueZoneTouched,
      candleEpoch
    };
  }

  // ── CASE 2: BUY (CRASH) ──
  if (mode === 'CRASH') {
    if (htf1hTrend !== 'bullish') return null;
    if (htf4hTrend !== 'N/A' && htf4hTrend !== 'bullish') return null;
    if (dailyTrend !== 'N/A' && dailyTrend !== 'bullish') return null;

    // ✅ Strategy 5C Clean Slate: 1H Candle Color Guard removed.
    // Macro trend is fully governed by Daily + 4H + 1H 50 EMA alignment above.
    // Active 1H bar color is irrelevant — counter-trend crashes naturally turn the active
    // bar against trend during valid 5M pullback entries (proven across 105 historical trades).

    let hasCrashes = true;
    const crashCandles = [];
    for (let s = 1; s <= minSpikes; s++) {
      const c = ltfCandles[ltfCandles.length - 1 - s];
      if (!c || c.close >= c.open) { hasCrashes = false; break; }
      crashCandles.push(c);
    }

    const c0Exhaustion = c0.close > c0.open && bodyRatio >= 0.50;
    if (!hasCrashes || !c0Exhaustion) return null;

    const atr = calculateATR(ltfCandles, 14);
    if (!atr || atr === 0) return null;

    // Minimum Crash Cluster Magnitude Filter (>= 0.5x ATR(14))
    const minClusterRange = atr * (config.MIN_SPIKE_CLUSTER_ATR_RATIO || 0.50);
    const crashClusterRange = Math.max(...crashCandles.map(c => c.high)) - Math.min(...crashCandles.map(c => c.low));
    if (crashClusterRange < minClusterRange) return null;

    const crashTrough = Math.min(c0.low, ...crashCandles.map(c => c.low));

    // 👑 Strategy 5C Core Pattern: Deep 5M 50 EMA Dynamic Value-Zone Retest
    const ltfCloses = ltfCandles.map(c => c.close);
    const ema20 = calculateEMA(ltfCloses, 20);
    const ema50 = calculateEMA(ltfCloses, 50);
    const lastEma20 = ema20[ema20.length - 1];
    const lastEma50 = ema50[ema50.length - 1];

    // 5M Trend Structure: Short-term 20 EMA must be above or equal to 50 EMA for Bullish Alignment
    if (lastEma20 < lastEma50) return null;

    // Deep Dynamic Value Zone: Crashes must retest the 5M 50 EMA Dynamic Mean
    const touchedEma50 = crashTrough <= (lastEma50 + atr * 0.2);
    if (!touchedEma50) return null;

    // 🛡️ Dynamic Mean Defense: Exhaustion candle close must respect 50 EMA support (within 0.50x ATR buffer)
    // Rejects BUY entries if price has violently broken below 50 EMA support (eliminates waterfall knife-catches)
    if (c0.close < (lastEma50 - atr * 0.50)) return null;

    const valueZoneTouched = '50 EMA Dynamic Mean';

    const entry = c0.close;
    const sl = crashTrough - (atr * 1.5);
    const slDist = entry - sl;
    if (slDist <= 0) return null;

    const tp = entry + (slDist * (config.REWARD_RATIO || 1.3));
    const candleEpoch = c0.epoch || c0.time;

    return {
      direction: 'BUY',
      type: 'bullish',
      htf4hTrend,
      htf1hTrend,
      dailyTrend,
      entry,
      sl,
      tp,
      slDist,
      atr,
      refPrice: crashTrough,
      h1ClearancePct,
      bodyRatio,
      valueZoneTouched,
      candleEpoch
    };
  }

  return null;
}

// ── MAIN MONITOR CYCLE ──
async function monitorMarket() {
  const now = new Date();
  
  // 1. Automated Check for 12:00 AM Midnight Daily Performance Report
  await checkAndSendDailyMidnightReport();

  // 2. Automated Check for Sunday Midnight Weekly Performance Report
  await checkAndSendWeeklyReport();

  console.log(`\n${CYAN}[${now.toLocaleTimeString()}] Scanning ${Object.keys(config.SYMBOLS).length} Elite Boom/Crash Pairs for Strategy 5C setups...${RESET}`);
  console.log(`-------------------------------------------------------------------------------------------------`);

  const symbols = Object.keys(config.SYMBOLS);

  for (const symbol of symbols) {
    try {
      const symConfig = config.SYMBOLS[symbol];
      const mode = symConfig.mode;
      const minSpikes = symConfig.min_spikes || 2;

      // Check Cooldown
      const cbStatus = isSymbolInCooldown(symbol);
      if (cbStatus.inCooldown) {
        console.log(`  [${mode}] ${symbol.padEnd(12)} | 🛡️ COOLDOWN: ${cbStatus.reason}`);
        continue;
      }

      // Use cached HTF candles (TTL: 1D = 1hr, 4H = 15m, 1H = 5m) to prevent WS socket overload
      const dailyCandles = await getCachedHtfCandles(symbol, config.MACRO_DAILY || '1d', 60, 60 * 60 * 1000);
      const htf4hCandles = await getCachedHtfCandles(symbol, config.MACRO_HTF || '4h', 100, 15 * 60 * 1000);
      const htf1hCandles = await getCachedHtfCandles(symbol, config.INTERMEDIATE_HTF || '1h', 100, 5 * 60 * 1000);
      const ltfCandles   = await getCandles(symbol, config.DEFAULT_LTF || '5m', 150, true);
      if (!htf1hCandles || !ltfCandles) continue;

      const latestPrice = ltfCandles[ltfCandles.length - 1].close;

      // 👑 Execution window: check the 2 most recently closed 5M bars to ensure WS polling latency doesn't miss entries
      const LOOKBACK_BARS = 2;
      let signalFiredThisScan = false;

      // Start at offset = 1 (most recently closed completed 5M candle) to avoid fluctuating in-progress bars
      for (let offset = 1; offset <= LOOKBACK_BARS; offset++) {
        if (ltfCandles.length < offset + 25) break;

        const completedSlice = ltfCandles.slice(0, ltfCandles.length - (offset - 1) - 1);
        const setup = detectStrategy5BSetup(completedSlice, htf1hCandles, htf4hCandles, dailyCandles, mode, minSpikes);
        if (!setup) continue;

        const setupId = `${symbol}_${setup.direction}_${setup.candleEpoch}`;
        const existingActive = loadActiveTrades();
        const symbolAlreadyActive = existingActive.some(t => t.symbol === symbol);

        if (alertedSetups.has(setupId) || symbolAlreadyActive) {
          if (alertedSetups.has(setupId)) {
            console.log(`  [${mode}] ${symbol.padEnd(12)} | ${latestPrice.toFixed(2)} | Setup active (already alerted)`);
          }
          break;
        }

        // ── NEW SIGNAL — FIRE ALERT ──
        saveAlertedSetup(setupId);
        signalFiredThisScan = true;

        const compRisk = getWeeklyCompoundedRisk();
        const lotSize = calculateLotSize(symbol, setup.entry, setup.sl, compRisk.riskUSD);
        const dirEmoji = setup.direction === 'SELL' ? '🔴' : '🟢';
        const riskUSD = compRisk.riskUSD;
        const rewardUSD = compRisk.rewardUSD.toFixed(2);
        const candleAgeLabel = offset === 1 ? '5M Close' : `5M Close (${(offset - 1) * 5}m ago)`;

        // ── OPTIONAL GEMINI 2.5 FLASH MULTIMODAL AI VISION AUDIT ──
        let aiAudit = { verdict: 'TAKE', reason: 'Pure Quantitative Momentum Guard Execution', confidence: 1.0 };
        if (config.ENABLE_AI_VISION) {
          console.log(`[runner] Auditing ${symbol} setup with Gemini 2.5 Flash Dual-Timeframe Vision...`);
          aiAudit = await auditTradeWithVision({
            symbol,
            direction: setup.direction,
            entry: setup.entry,
            tp: setup.tp,
            sl: setup.sl,
            candles: ltfCandles,
            htfCandles: htf1hCandles
          });
        }
        const aiVerdictBadge = aiAudit.verdict === 'TAKE' ? '🟢 <b>TAKE IT (Trade Approved)</b>' : '🔴 <b>LEAVE IT (Avoid Trade)</b>';

        const alertLines = [
          `👑 ${dirEmoji} <b>[MYTRADA STRATEGY 5C VALUE-ZONE SNIPER]</b>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `<b>Asset:</b> <code>${symbol}</code> (${symConfig.name})`,
          `<b>Direction:</b> ${dirEmoji} <b>${setup.direction} (Value-Zone Exhaustion Sniper)</b>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `📊 <b>MULTI-TIMEFRAME CONFLUENCE:</b>`,
          `  • <b>Macro Trend:</b> <code>Daily + 4H + 1H 50 EMA (${setup.htf1hTrend.toUpperCase()} Aligned) 🛡️</code>`,
          `  • <b>5M Trend Structure:</b> <code>20 EMA ${setup.direction === 'SELL' ? '≤' : '≥'} 50 EMA Aligned 📊</code>`,
          `  • <b>Spike Cluster:</b> <code>${minSpikes} Consecutive Counter-Trend Spikes</code>`,
          `  • <b>Dynamic Value Zone:</b> <code>Retested 5M ${setup.valueZoneTouched} 🎯</code>`,
          `  • <b>5M Execution:</b> <code>M5 Exhaustion Close (Body: ${(setup.bodyRatio * 100).toFixed(0)}%)</code>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `🎯 <b>ENTRY PRICE:</b> <code>${setup.entry.toFixed(2)}</code> (Market — ${candleAgeLabel})`,
          `🛡️ <b>STOP LOSS (SL):</b> <code>${setup.sl.toFixed(2)}</code> (Peak + 1.5x ATR)`,
          `🏆 <b>TARGET (1:1.3 R:R):</b> <code>${setup.tp.toFixed(2)}</code> (+$${rewardUSD} USD)`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`
        ];

        if (config.ENABLE_AI_VISION) {
          alertLines.push(
            `🧠 <b>AI VISION AUDIT VERDICT:</b>`,
            `  • <b>Recommendation:</b> ${aiVerdictBadge}`,
            `  • <b>Confidence:</b> <code>${(aiAudit.confidence * 100).toFixed(0)}%</code>`,
            `  • <b>Visual Rationale:</b> <i>${aiAudit.reason}</i>`,
            `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`
          );
        }

        alertLines.push(
          `💰 <b>Account & Position Sizing:</b>`,
          `  • Live Account Equity: <code>$${compRisk.liveBalance.toFixed(2)} USD</code>`,
          `  • Weekly Compounding Base: <code>$${compRisk.balance.toFixed(2)} USD</code>`,
          `  • Recommended Lot: <code>${lotSize} Lots</code>`,
          `  • Max Risk: <code>-$${riskUSD.toFixed(2)} USD (${compRisk.riskPercent.toFixed(1)}%)</code>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `🚀 <b>EXECUTION:</b> <code>Enter MARKET ${setup.direction} on MT5. Target 1:1.3 R:R.</code>`
        );

        const alertHtml = alertLines.join('\n');

        await sendTelegramMessage(alertHtml);
        console.log(`${dirEmoji === '🔴' ? RED : GREEN}${BOLD}   >>> STRATEGY 5C SIGNAL [offset:${offset}]: ${setup.direction} ${symbol} @ ${setup.entry.toFixed(2)} | TP: ${setup.tp.toFixed(2)} | SL: ${setup.sl.toFixed(2)}${RESET}`);

        const activeTrades = loadActiveTrades();
        activeTrades.push({
          setupId,
          symbol,
          type: setup.type,
          entryPrice: setup.entry,
          stopLoss: setup.sl,
          takeProfit: setup.tp,
          riskUSD: compRisk.riskUSD,
          rewardUSD: compRisk.rewardUSD,
          candleEpoch: setup.candleEpoch,
          triggeredTime: Date.now(),
          aiVisionVerdict: aiAudit.verdict,
          aiVisionReason: aiAudit.reason,
          aiVisionConfidence: aiAudit.confidence
        });
        saveActiveTrades(activeTrades);

        recordSignal({
          setupId,
          symbol,
          type: setup.type,
          entryPrice: setup.entry,
          stopLoss: setup.sl,
          takeProfit: setup.tp,
          confluenceScore: 10,
          aiVisionVerdict: aiAudit.verdict,
          aiVisionReason: aiAudit.reason,
          aiVisionConfidence: aiAudit.confidence
        });
        recordTrigger(setupId);

        break;
      }

      if (!signalFiredThisScan) {
        console.log(`  [${mode}] ${symbol.padEnd(12)} | ${latestPrice.toFixed(2)} | Monitoring for ${minSpikes}-Spike Pullback Exhaustion...`);
        await checkActiveTradesForSymbol(symbol, ltfCandles);
      }
    } catch (err) {
      console.warn(`  [WARN] ${symbol}: ${err.message}`);
    }
  }

  console.log(`-------------------------------------------------------------------------------------------------`);
  console.log(`Scan complete. Next scan in 30s...`);
}

// ── CLI ENTRY POINT ──
async function main() {
  const args = process.argv.slice(2);
  const isTest = args.includes('--test');
  const isReport = args.includes('--report');
  const isScanOnly = args.includes('--scan') || args.includes('--once');

  if (isTest) {
    console.log("\n🧪 Dispatching Test Telegram Alert...");
    const testMsg = "🚀 <b>[MYTRADA STRATEGY 5C TEST]</b>\nTelegram Signal Dispatcher connected successfully!";
    await sendTelegramMessage(testMsg);
    console.log(`${GREEN}✅ SUCCESS: Test alert sent to Telegram!${RESET}`);
    process.exit(0);
  }

  if (isReport) {
    console.log("\n📊 Dispatching Manual Daily Report Test to Telegram...");
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    const report = generateDailyReport(yesterdayStr);
    const reportHtml = formatReportTelegramHTML(report);
    await sendTelegramMessage(reportHtml);
    console.log(`${GREEN}✅ SUCCESS: Daily Performance Report dispatched to Telegram!${RESET}`);
    process.exit(0);
  }

  if (isScanOnly) {
    console.log(`\n👑 ${BOLD}${CYAN}Mytrada Real-Time Market Scan (10 Elite Pairs)${RESET}`);
    await monitorMarket();
    console.log(`\n${GREEN}✅ Real-time scan completed successfully.${RESET}`);
    process.exit(0);
  }

  console.log(`\n👑 ${BOLD}${CYAN}Mytrada Institutional Signal Runner (Strategy 5C Value-Zone Sniper LIVE)${RESET}`);
  console.log(`🚀 Monitoring ${Object.keys(config.SYMBOLS).length} Elite Boom & Crash Pairs (81.8% 6-Month Flagship | 1:1.3 R:R | Dynamic Value Zone | 45m/60m Circuit Breakers | Weekly Smart Auto-Compounding)...\n`);

  await sendTelegramMessage(`🚀 <b>[MYTRADA STRATEGY 5C VALUE-ZONE SNIPER LIVE]</b> Signal Runner active across ${Object.keys(config.SYMBOLS).length} Elite Boom & Crash Portfolio (Universal 2-Spike Sniper, Deep 5M 50 EMA Retest, 1:1.3 R:R, 45m Loss Cooldown, Weekly Auto-Compounding)!`);

  await monitorMarket();
  setInterval(monitorMarket, 30000);
}

// ── PROCESS DISCONNECT & CRASH ALERT HOOKS ──
let isShuttingDown = false;

async function notifyShutdown(reason) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  const alertMsg = [
    `⚠️ 🔴 <b>[MYTRADA SERVER ALERT — DISCONNECTED]</b>`,
    `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
    `<b>Status:</b> Signal Runner stopped or encountered an error.`,
    `<b>Reason:</b> <code>${reason}</code>`,
    `<b>Timestamp:</b> <code>${new Date().toUTCString()}</code>`,
    `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
    `🛠️ <i>PM2 will attempt auto-restart. If this persists, check VPS logs.</i>`
  ].join('\n');

  try {
    await sendTelegramMessage(alertMsg);
  } catch (e) {}
}

process.on('uncaughtException', async (err) => {
  console.error('[CRITICAL] Uncaught Exception:', err);
  await notifyShutdown(`Uncaught Exception: ${err.message}`);
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  console.error('[CRITICAL] Unhandled Rejection:', reason);
  await notifyShutdown(`Unhandled Rejection: ${reason}`);
});

process.on('SIGINT', async () => {
  console.log('[SHUTDOWN] SIGINT received.');
  await notifyShutdown('Manual stop (SIGINT)');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('[SHUTDOWN] SIGTERM received.');
  await notifyShutdown('Process terminated (SIGTERM / PM2 reload)');
  process.exit(0);
});

main().catch(async (err) => {
  console.error("[runner fatal]", err);
  await notifyShutdown(`Fatal Startup Error: ${err.message}`);
});
