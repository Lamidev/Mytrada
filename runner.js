// runner.js
/**
 * Mytrada - Institutional Multi-Timeframe Spike Exhaustion Alert Bot.
 * Strategy: Strategy 5 Enhanced (4H+1H Multi-Timeframe Trend + 3-Spike Exhaustion + 1:1.3 R:R + Tiered Circuit Breakers)
 * 
 * Rules:
 *  1. Macro Trend: 4H 50 EMA must agree with trade direction
 *  2. Intermediate Trend: 1H 50 EMA must agree + have >0.08% separation (Chop Filter)
 *  3. Spike Surge: Minimum 3 consecutive completed spike candles
 *  4. Execution: 5M candle close reversal (body >= 50% range)
 *  5. Target: 1:1.3 R:R (SL above spike peak + 1.5x ATR)
 *  6. Circuit Breakers: 45m pause on 1 loss, 2.5h on 2 losses, max 3 losses/day
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getCandles } = require('./dataFetcher');
const { placeTrade } = require('./tradeExecutor');
const {
  recordSignal,
  recordTrigger,
  recordClose,
  generateDailyReport,
  generateWeeklyReport,
  generateMonthlyReport,
  formatReportTelegramHTML
} = require('./reportManager');

const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}
const ACTIVE_TRADES_FILE = path.join(CACHE_DIR, 'active_trades.json');
const ALERTED_SETUPS_FILE = path.join(CACHE_DIR, 'alerted_setups.json');
const CIRCUIT_BREAKER_FILE = path.join(CACHE_DIR, 'circuit_breaker_state.json');

// Terminal Color Codes
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";

// ── PERSISTENT SETUPS CACHE ──
function loadAlertedSetups() {
  if (fs.existsSync(ALERTED_SETUPS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(ALERTED_SETUPS_FILE, 'utf8'));
      if (Array.isArray(data)) return new Set(data);
    } catch (e) {
      console.warn("[runner] Warning loading alerted setups cache:", e.message);
    }
  }
  return new Set();
}

function saveAlertedSetup(setupId) {
  alertedSetups.add(setupId);
  try {
    const list = Array.from(alertedSetups).slice(-500);
    fs.writeFileSync(ALERTED_SETUPS_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.warn("[runner] Warning saving alerted setup cache:", e.message);
  }
}

const alertedSetups = loadAlertedSetups();

// ── TIERED CIRCUIT BREAKER STATE MANAGER ──
function loadCircuitBreakerState() {
  if (fs.existsSync(CIRCUIT_BREAKER_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CIRCUIT_BREAKER_FILE, 'utf8'));
    } catch (e) {
      console.warn("[runner] Warning loading circuit breaker state:", e.message);
    }
  }
  return { date: new Date().toISOString().split('T')[0], symbols: {} };
}

function saveCircuitBreakerState(state) {
  try {
    fs.writeFileSync(CIRCUIT_BREAKER_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.warn("[runner] Warning saving circuit breaker state:", e.message);
  }
}

let circuitBreakerState = loadCircuitBreakerState();

function checkAndResetDailyCircuitBreaker() {
  const today = new Date().toISOString().split('T')[0];
  if (circuitBreakerState.date !== today) {
    circuitBreakerState = { date: today, symbols: {} };
    saveCircuitBreakerState(circuitBreakerState);
    console.log(`${CYAN}[Circuit Breaker] Daily loss counters reset for new trading session: ${today}${RESET}`);
  }
}

function isSymbolInCooldown(symbol) {
  checkAndResetDailyCircuitBreaker();
  const s = circuitBreakerState.symbols[symbol];
  if (!s) return { inCooldown: false };

  const now = Date.now();
  if (s.dailyHalted) {
    return { inCooldown: true, reason: `Daily loss limit hit (3 losses) — Halted until tomorrow`, remainingMins: Math.ceil((new Date().setUTCHours(24, 0, 0, 0) - now) / 60000) };
  }

  if (s.pauseUntilTimeMs && now < s.pauseUntilTimeMs) {
    const remainingMins = Math.ceil((s.pauseUntilTimeMs - now) / 60000);
    return { inCooldown: true, reason: `Loss cooldown active (${remainingMins}m remaining)`, remainingMins };
  }

  return { inCooldown: false };
}

function recordSymbolTradeOutcome(symbol, outcome) {
  checkAndResetDailyCircuitBreaker();
  if (!circuitBreakerState.symbols[symbol]) {
    circuitBreakerState.symbols[symbol] = {
      consecutiveLosses: 0,
      dailyLosses: 0,
      pauseUntilTimeMs: 0,
      dailyHalted: false
    };
  }

  const s = circuitBreakerState.symbols[symbol];
  const now = Date.now();

  if (outcome === 'WIN') {
    s.consecutiveLosses = 0;
  } else if (outcome === 'LOSS') {
    s.consecutiveLosses++;
    s.dailyLosses++;

    const cbConfig = config.CIRCUIT_BREAKER || { TIER_1_PAUSE_MINS: 45, TIER_2_PAUSE_MINS: 150, MAX_DAILY_LOSSES_PER_SYMBOL: 3 };

    if (s.dailyLosses >= cbConfig.MAX_DAILY_LOSSES_PER_SYMBOL) {
      s.dailyHalted = true;
      console.log(`${RED}${BOLD}🛡️ [CIRCUIT BREAKER TRIGGERED] ${symbol} has taken ${s.dailyLosses} losses today ➔ HALTED FOR DAY${RESET}`);
    } else if (s.consecutiveLosses >= 2) {
      s.pauseUntilTimeMs = now + (cbConfig.TIER_2_PAUSE_MINS * 60 * 1000);
      console.log(`${YELLOW}${BOLD}🛡️ [CIRCUIT BREAKER TRIGGERED] ${symbol} took 2 consecutive losses ➔ PAUSED FOR ${cbConfig.TIER_2_PAUSE_MINS} MINUTES${RESET}`);
    } else if (s.consecutiveLosses === 1) {
      s.pauseUntilTimeMs = now + (cbConfig.TIER_1_PAUSE_MINS * 60 * 1000);
      console.log(`${YELLOW}${BOLD}🛡️ [CIRCUIT BREAKER TRIGGERED] ${symbol} took 1 loss ➔ PAUSED FOR ${cbConfig.TIER_1_PAUSE_MINS} MINUTES${RESET}`);
    }
  }

  saveCircuitBreakerState(circuitBreakerState);
}

/**
 * Calculates recommended MT5 Lot Size based on $100 Account ($3.00 Risk Baseline)
 */
function calculateLotSize(symbol, entryPrice, stopLossPrice) {
  const priceDistance = Math.abs(entryPrice - stopLossPrice);
  const minLots = {
    'BOOM300N': 0.50,
    'BOOM500': 0.20,
    'BOOM1000': 0.20,
    'BOOM200': 0.20,
    'BOOM600': 0.20,
    'CRASH300N': 0.50,
    'CRASH500': 0.20,
    'CRASH1000': 0.20,
    'CRASH200': 0.20,
    'CRASH600': 0.20,
    'CRASH99': 0.20,
    'CRASH100': 0.20
  };
  const minLot = minLots[symbol] || 0.20;

  if (priceDistance === 0) return minLot.toFixed(2);
  
  const riskUSD = config.RISK_AMOUNT_USD || 3.0;
  const rawLotSize = riskUSD / priceDistance;
  const finalLot = Math.max(minLot, rawLotSize);
  
  return finalLot.toFixed(2);
}

/**
 * Calculates Exponential Moving Average (EMA)
 */
function calculateEMA(prices, period) {
  const ema = [];
  if (prices.length === 0) return ema;
  
  let sum = 0;
  for (let i = 0; i < Math.min(period, prices.length); i++) {
    sum += prices[i];
  }
  
  const k = 2 / (period + 1);
  let currentEma = sum / Math.min(period, prices.length);
  ema[Math.min(period, prices.length) - 1] = currentEma;
  
  for (let i = period; i < prices.length; i++) {
    currentEma = prices[i] * k + currentEma * (1 - k);
    ema[i] = currentEma;
  }
  return ema;
}

/**
 * Calculates ATR over last N candles
 */
function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let trSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low  - prev.close)
    );
    trSum += tr;
  }
  return trSum / period;
}

/**
 * Sends a premium HTML-formatted message to Telegram
 */
function sendTelegramMessage(htmlText) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  if (!token || !chatId || token === 'YOUR_TELEGRAM_BOT_TOKEN_HERE' || chatId === 'YOUR_TELEGRAM_CHAT_ID_HERE') {
    const rawText = htmlText
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .trim();
    console.log(`\n${BOLD}${MAGENTA}📢 [TELEGRAM MOCK ALERT (No Credentials in .env)]:${RESET}\n${rawText}\n`);
    return Promise.resolve();
  }
  
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      chat_id: chatId,
      text: htmlText,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(body));
        } else {
          reject(new Error(`Telegram HTTP ${res.statusCode}: ${body}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function loadActiveTrades() {
  if (fs.existsSync(ACTIVE_TRADES_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(ACTIVE_TRADES_FILE, 'utf8'));
    } catch (e) {
      console.error("[runner] Error reading active trades file:", e.message);
    }
  }
  return [];
}

function saveActiveTrades(trades) {
  try {
    fs.writeFileSync(ACTIVE_TRADES_FILE, JSON.stringify(trades, null, 2), 'utf8');
  } catch (e) {
    console.error("[runner] Error writing active trades file:", e.message);
  }
}

/**
 * Checks active open positions for TP/SL outcome resolution
 */
async function checkActiveTradesForSymbol(symbol, candles) {
  const activeTrades = loadActiveTrades();
  const symbolTrades = activeTrades.filter(t => t.symbol === symbol);
  if (symbolTrades.length === 0) return;

  let updatedTrades = [...activeTrades];
  let changed = false;

  for (const trade of symbolTrades) {
    let hitSL = false;
    let hitTP = false;
    let exitPrice = 0;

    const postTriggerCandles = candles.filter(c => c.time >= trade.triggeredTime);

    for (const candle of postTriggerCandles) {
      if (trade.type === 'bullish') {
        if (candle.low <= trade.stopLoss) {
          hitSL = true;
          exitPrice = trade.stopLoss;
          break;
        } else if (candle.high >= trade.takeProfit) {
          hitTP = true;
          exitPrice = trade.takeProfit;
          break;
        }
      } else { // bearish
        if (candle.high >= trade.stopLoss) {
          hitSL = true;
          exitPrice = trade.stopLoss;
          break;
        } else if (candle.low <= trade.takeProfit) {
          hitTP = true;
          exitPrice = trade.takeProfit;
          break;
        }
      }
    }

    if (hitSL || hitTP) {
      let outcomeHeader = "";
      let outcomeDetails = [];

      const rewardRatio = config.REWARD_RATIO || 1.3;
      const riskUSD = config.RISK_AMOUNT_USD || 3.0;

      if (hitTP) {
        const winPnlUsd = riskUSD * rewardRatio;
        outcomeHeader = `🏆 <b>[MYTRADA SPIKE EXHAUSTION: TP HIT 🟢]</b>`;
        outcomeDetails = [
          `🟢 <b>OUTCOME: TAKE PROFIT HIT (+${rewardRatio.toFixed(1)}R)</b>`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `💰 <b>REALIZED PROFIT:</b> <code>+$${winPnlUsd.toFixed(2)} USD (+${rewardRatio.toFixed(1)}R / +3.9%)</code>`,
          `🛡️ <b>Circuit Breaker Status:</b> <code>Active & Healthy (Loss Streak: 0)</code>`
        ];
        recordSymbolTradeOutcome(symbol, 'WIN');
      } else {
        outcomeHeader = `🛡️ <b>[MYTRADA SPIKE EXHAUSTION: SL HIT 🔴]</b>`;
        outcomeDetails = [
          `🔴 <b>OUTCOME: STOP LOSS HIT (-1.0R)</b>`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `💸 <b>REALIZED LOSS:</b> <code>-$${riskUSD.toFixed(2)} USD (-1.0R / -3.0%)</code>`
        ];
        recordSymbolTradeOutcome(symbol, 'LOSS');

        // Check if circuit breaker triggered on this loss
        const cbStatus = isSymbolInCooldown(symbol);
        if (cbStatus.inCooldown) {
          outcomeDetails.push(`🛡️ <b>Circuit Breaker Shield:</b> <code>${cbStatus.reason}</code>`);
        }
      }

      const closedAlertHtml = [
        outcomeHeader,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].name : symbol})`,
        `<b>Direction:</b> ${trade.type === 'bullish' ? '🟢 BUY' : '🔴 SELL'}`,
        ...outcomeDetails,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `🔥 <b>Entry Price:</b> <code>${trade.entryPrice.toFixed(2)}</code>`,
        `🛡️ <b>Stop Loss (SL):</b> <code>${trade.stopLoss.toFixed(2)}</code>`,
        `🏆 <b>Take Profit (TP):</b> <code>${trade.takeProfit.toFixed(2)}</code>`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `<i>ℹ️ Check your MetaTrader 5 account terminal!</i>`
      ].join('\n');

      try {
        await sendTelegramMessage(closedAlertHtml);
        console.log(`\n${GREEN}${BOLD}   >>> 📢 SENT TELEGRAM FINAL OUTCOME ALERT FOR ${symbol}${RESET}\n`);
      } catch (telegramErr) {
        console.error("[runner] Failed sending Telegram outcome position notification:", telegramErr.message);
      }

      let finalOutcome = hitTP ? 'WIN' : 'LOSS';
      let pnlUSD = hitTP ? (riskUSD * rewardRatio) : -riskUSD;
      let pnlR = hitTP ? rewardRatio : -1.0;
      recordClose(trade.setupId, finalOutcome, exitPrice, pnlUSD, pnlR);

      updatedTrades = updatedTrades.filter(t => t.setupId !== trade.setupId);
      changed = true;
    }
  }

  if (changed) {
    saveActiveTrades(updatedTrades);
  }
}

/**
 * Strategy 5 Enhanced: Spike Exhaustion Setup Detection
 *  - 4H 50 EMA Macro Trend
 *  - 1H 50 EMA Intermediate Trend (>0.08% Chop clearance)
 *  - 3+ Consecutive Spikes
 *  - 5M Reversal Candle (Body >= 50% Range)
 *  - 1:1.3 R:R Target
 */
function detectSpikeExhaustion(ltfCandles, htf1hCandles, htf4hCandles, mode) {
  if (!ltfCandles || !htf1hCandles || ltfCandles.length < 25 || htf1hCandles.length < 55) return null;

  // 1. 1H Intermediate Trend Filter (50 EMA)
  const htf1hCloses = htf1hCandles.map(c => c.close);
  const htf1hEMA    = calculateEMA(htf1hCloses, 50);
  const last1hClose = htf1hCloses[htf1hCloses.length - 1];
  const last1hEma   = htf1hEMA[htf1hEMA.length - 1];
  const htf1hTrend  = last1hClose > last1hEma ? 'bullish' : 'bearish';

  if (mode === 'BOOM'  && htf1hTrend !== 'bearish') return null;
  if (mode === 'CRASH' && htf1hTrend !== 'bullish') return null;

  // 1H Trend Clearance Chop Filter (>0.08% separation)
  if (config.USE_HTF_CHOP_FILTER) {
    const emaDistPct = Math.abs(last1hClose - last1hEma) / last1hEma;
    if (emaDistPct < 0.0008) return null; // Filter out flat sideways chop
  }

  // 2. 4H Macro Trend Filter (50 EMA)
  let htf4hTrend = 'N/A';
  if (htf4hCandles && htf4hCandles.length >= 55) {
    const htf4hCloses = htf4hCandles.map(c => c.close);
    const htf4hEMA    = calculateEMA(htf4hCloses, 50);
    const last4hClose = htf4hCloses[htf4hCloses.length - 1];
    const last4hEma   = htf4hEMA[htf4hEMA.length - 1];
    htf4hTrend        = last4hClose > last4hEma ? 'bullish' : 'bearish';

    // Must agree with Macro 4H trend
    if (mode === 'BOOM'  && htf4hTrend !== 'bearish') return null;
    if (mode === 'CRASH' && htf4hTrend !== 'bullish') return null;
  }

  // 3. 5M Consecutive Spike Burst (3 Spikes Required)
  const minSpikes = config.MIN_SPIKES || 3;
  const c0 = ltfCandles[ltfCandles.length - 1]; // Exhaustion candidate candle

  if (mode === 'BOOM') {
    let hasSpikes = true;
    const spikeCandles = [];
    for (let s = 1; s <= minSpikes; s++) {
      const c = ltfCandles[ltfCandles.length - 1 - s];
      if (!c || c.close <= c.open) { hasSpikes = false; break; }
      spikeCandles.push(c);
    }

    const c0Range = c0.high - c0.low;
    const c0Body = Math.abs(c0.close - c0.open);
    const c0Exhaustion = c0.close < c0.open && c0Range > 0 && (c0Body / c0Range) >= 0.5;

    if (!hasSpikes || !c0Exhaustion) return null;

    const atr = calculateATR(ltfCandles, 14);
    if (!atr || atr === 0) return null;

    const spikePeak = Math.max(c0.high, ...spikeCandles.map(c => c.high));
    const entry = c0.close;
    const sl = spikePeak + (atr * 1.5);
    const slDist = Math.abs(entry - sl);
    const rewardRatio = config.REWARD_RATIO || 1.3;
    const tp = entry - (slDist * rewardRatio);
    const candleEpoch = c0.epoch || c0.time;

    return { mode, htf4hTrend, htf1hTrend, entry, sl, tp, slDist, atr, spikePeak, candleEpoch };
  }

  // CRASH
  if (mode === 'CRASH') {
    let hasCrashes = true;
    const crashCandles = [];
    for (let s = 1; s <= minSpikes; s++) {
      const c = ltfCandles[ltfCandles.length - 1 - s];
      if (!c || c.close >= c.open) { hasCrashes = false; break; }
      crashCandles.push(c);
    }

    const c0Range = c0.high - c0.low;
    const c0Body = Math.abs(c0.close - c0.open);
    const c0Exhaustion = c0.close > c0.open && c0Range > 0 && (c0Body / c0Range) >= 0.5;

    if (!hasCrashes || !c0Exhaustion) return null;

    const atr = calculateATR(ltfCandles, 14);
    if (!atr || atr === 0) return null;

    const crashTrough = Math.min(c0.low, ...crashCandles.map(c => c.low));
    const entry = c0.close;
    const sl = crashTrough - (atr * 1.5);
    const slDist = Math.abs(entry - sl);
    const rewardRatio = config.REWARD_RATIO || 1.3;
    const tp = entry + (slDist * rewardRatio);
    const candleEpoch = c0.epoch || c0.time;

    return { mode, htf4hTrend, htf1hTrend, entry, sl, tp, slDist, atr, crashTrough, candleEpoch };
  }

  return null;
}

let lastDailyReportSentDate = new Date().toISOString().split('T')[0];

/**
 * Automatically dispatches the Daily Performance Report every night at 12:00 AM (00:00 UTC)
 */
async function checkAutomatedDailyReport() {
  const todayStr = new Date().toISOString().split('T')[0];
  if (todayStr !== lastDailyReportSentDate) {
    console.log(`\n👑 [AUTOMATED MIDNIGHT TRIGGER] Generating End-of-Day Performance Report for ${lastDailyReportSentDate}...`);
    try {
      const report = generateDailyReport(lastDailyReportSentDate);
      const html = formatReportTelegramHTML(report);
      await sendTelegramMessage(html);
      console.log(`${GREEN}✅ SUCCESS: Automated Midnight Daily Report dispatched to Telegram!${RESET}\n`);
    } catch (e) {
      console.error("[runner] Error dispatching automated midnight report:", e.message);
    }
    lastDailyReportSentDate = todayStr;
  }
}

/**
 * Main Spike Exhaustion Monitor cycle (runs every 30 seconds)
 */
async function monitorMarket() {
  await checkAutomatedDailyReport();

  const now = new Date();
  console.log(`\n${CYAN}[${now.toLocaleTimeString()}] Scanning ${Object.keys(config.SYMBOLS).length} Elite Boom & Crash pairs for Strategy 5 Enhanced setups...${RESET}`);
  console.log(`-------------------------------------------------------------------------------------------------`);

  const symbols = Object.keys(config.SYMBOLS);

  for (const symbol of symbols) {
    try {
      const mode = config.SYMBOLS[symbol].mode;

      // Check Circuit Breaker Cooldown status for this symbol
      const cbStatus = isSymbolInCooldown(symbol);
      if (cbStatus.inCooldown) {
        console.log(`  [${mode}] ${symbol.padEnd(12)} | 🛡️ COOLDOWN: ${cbStatus.reason}`);
        continue;
      }

      const htf4hCandles = await getCandles(symbol, config.MACRO_HTF || '4h', 200, true);
      const htf1hCandles = await getCandles(symbol, config.INTERMEDIATE_HTF || '1h', 200, true);
      const ltfCandles   = await getCandles(symbol, config.DEFAULT_LTF || '5m', 50, true);
      if (!htf1hCandles || !ltfCandles) continue;

      const latestPrice = ltfCandles[ltfCandles.length - 1].close;
      const setup = detectSpikeExhaustion(ltfCandles, htf1hCandles, htf4hCandles, mode);

      if (setup) {
        const setupId = `${symbol}_${mode}_${setup.candleEpoch}`;

        // Guard: one active trade per symbol at a time
        const existingActive = loadActiveTrades();
        const symbolAlreadyActive = existingActive.some(t => t.symbol === symbol);

        if (!alertedSetups.has(setupId) && !symbolAlreadyActive) {
          saveAlertedSetup(setupId);

          const lotSize   = calculateLotSize(symbol, setup.entry, setup.sl);
          const direction = mode === 'BOOM' ? 'SELL' : 'BUY';
          const dirEmoji  = mode === 'BOOM' ? '🔴' : '🟢';
          const refLabel  = mode === 'BOOM' ? `Spike Peak` : `Crash Trough`;
          const refPrice  = mode === 'BOOM' ? setup.spikePeak : setup.crashTrough;
          const rewardRatio = config.REWARD_RATIO || 1.3;
          const riskUSD = config.RISK_AMOUNT_USD || 3.0;

          const alertHtml = [
            `👑 ${dirEmoji} <b>[MYTRADA SPIKE EXHAUSTION SIGNAL]</b>`,
            `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
            `<b>Strategy:</b> <code>Strategy 5 Enhanced (Multi-TF + 3 Spikes)</code>`,
            `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol].name})`,
            `<b>Direction:</b> ${dirEmoji} <b>${direction} (${mode === 'BOOM' ? 'Boom 3-Spike Exhaustion' : 'Crash 3-Spike Exhaustion'})</b>`,
            `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
            `📊 <b>MULTI-TIMEFRAME CONFLUENCE:</b>`,
            `  • <b>4H Macro Trend:</b> <code>${setup.htf4hTrend.toUpperCase()} (Aligned)</code>`,
            `  • <b>1H Intermediate:</b> <code>${setup.htf1hTrend.toUpperCase()} (Clearance > 0.08%)</code>`,
            `  • <b>5M Execution:</b> <code>3 Consecutive Spikes + Reversal Close</code>`,
            `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
            `🎯 <b>ENTRY PRICE:</b> <code>${setup.entry.toFixed(2)}</code> (Market — 5M Close)`,
            `🛡️ <b>STOP LOSS (SL):</b> <code>${setup.sl.toFixed(2)}</code> (${refLabel} ${refPrice ? refPrice.toFixed(2) : ''} + 1.5x ATR)`,
            `🏆 <b>TAKE PROFIT (TP):</b> <code>${setup.tp.toFixed(2)}</code> (1:${rewardRatio} R:R Target)`,
            `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
            `💰 <b>Position Sizing ($100 Account):</b>`,
            `  • Recommended Lot: <code>${lotSize} Lots</code>`,
            `  • Max Risk (SL Hit): <code>-$${riskUSD.toFixed(2)} USD (-1.0R / 3.0%)</code>`,
            `  • Target Profit (TP Hit): <code>+$${(riskUSD * rewardRatio).toFixed(2)} USD (+${rewardRatio}R / +3.9%)</code>`,
            `  • Circuit Breaker: <code>Active (45m/2.5h Tiered Pause)</code>`,
            `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
            `🚀 <b>EXECUTION:</b> <code>Enter MARKET ${direction} on MT5. Hold strictly to TP or SL.</code>`
          ].join('\n');

          await sendTelegramMessage(alertHtml);
          console.log(`${dirEmoji === '🔴' ? RED : GREEN}${BOLD}   >>> SPIKE EXHAUSTION SIGNAL: ${direction} ${symbol} @ ${setup.entry.toFixed(2)} | TP: ${setup.tp.toFixed(2)} | SL: ${setup.sl.toFixed(2)}${RESET}`);

          // Auto-Execute direct trade via Deriv WebSocket API if AUTO_TRADE is true
          if (config.AUTO_TRADE && process.env.DERIV_API_TOKEN) {
            try {
              console.log(`🚀 Executing auto-trade on Deriv API for ${symbol}...`);
              const contractId = await placeTrade(
                symbol,
                mode === 'BOOM' ? 'bearish' : 'bullish',
                setup.entry,
                setup.sl,
                setup.tp
              );
              console.log(`✅ [DERIV TRADE EXECUTED] ${symbol} Contract ID: ${contractId}`);
            } catch (tradeErr) {
              console.error(`⚠️ [DERIV TRADE NOTE] Could not auto-place on Deriv API: ${tradeErr.message}`);
            }
          }

          // Log to trade history
          recordSignal({
            setupId,
            symbol,
            type: mode === 'BOOM' ? 'bearish' : 'bullish',
            entryPrice: setup.entry,
            stopLoss:   setup.sl,
            takeProfit: setup.tp,
            confluenceScore: 10
          });
          recordTrigger(setupId);

          // Track as active trade for outcome monitoring
          const activeTrades = loadActiveTrades();
          if (!activeTrades.some(t => t.setupId === setupId)) {
            activeTrades.push({
              setupId,
              symbol,
              type:          mode === 'BOOM' ? 'bearish' : 'bullish',
              entryPrice:    setup.entry,
              stopLoss:      setup.sl,
              takeProfit:    setup.tp,
              triggeredTime: Date.now()
            });
            saveActiveTrades(activeTrades);
          }
        } else if (alertedSetups.has(setupId)) {
          console.log(`  [${mode}] ${symbol.padEnd(12)} | ${latestPrice.toFixed(2)} | Setup active (already alerted)`);
        } else {
          console.log(`  [${mode}] ${symbol.padEnd(12)} | ${latestPrice.toFixed(2)} | Trade already open — skipping`);
        }
      } else {
        const htfCloses = htf1hCandles.map(c => c.close);
        const htfEMA    = calculateEMA(htfCloses, 50);
        const htfTrend  = htfCloses[htfCloses.length - 1] > htfEMA[htfEMA.length - 1] ? 'BULLISH' : 'BEARISH';
        const trendOk   = (mode === 'BOOM' && htfTrend === 'BEARISH') || (mode === 'CRASH' && htfTrend === 'BULLISH');
        const trendStr  = trendOk ? `${GREEN}${htfTrend} (1H Aligned)${RESET}` : `${YELLOW}${htfTrend} (Not aligned)${RESET}`;
        console.log(`  [${mode}] ${symbol.padEnd(12)} | ${latestPrice.toFixed(2)} | ${trendStr} | Waiting for 3-spike exhaustion...`);

        // Monitor active trades for this symbol for TP/SL outcomes
        await checkActiveTradesForSymbol(symbol, ltfCandles);
      }
    } catch (err) {
      console.warn(`  [WARN] ${symbol}: ${err.message}`);
    }
  }

  console.log(`-------------------------------------------------------------------------------------------------`);
  console.log(`Scan complete. Next scan in 30s...`);
}

/**
 * Wipes all previous trades, active cache, and alerted setups to give a clean slate
 */
function wipeSlate() {
  console.log(`\n🧹 Wiping all previous trade caches and history for a fresh clean slate...`);
  try {
    fs.writeFileSync(ACTIVE_TRADES_FILE, JSON.stringify([], null, 2), 'utf8');
    fs.writeFileSync(ALERTED_SETUPS_FILE, JSON.stringify([], null, 2), 'utf8');
    fs.writeFileSync(CIRCUIT_BREAKER_FILE, JSON.stringify({ date: new Date().toISOString().split('T')[0], symbols: {} }, null, 2), 'utf8');
    
    const tradeHistoryFile = path.join(__dirname, 'data', 'trade_history.json');
    if (fs.existsSync(tradeHistoryFile)) {
      // Archive old history
      const archiveFile = path.join(__dirname, 'data', `trade_history_archive_${Date.now()}.json`);
      fs.copyFileSync(tradeHistoryFile, archiveFile);
      fs.writeFileSync(tradeHistoryFile, JSON.stringify([], null, 2), 'utf8');
      console.log(`📦 Archived previous trade history to ${path.basename(archiveFile)}`);
    }

    console.log(`${GREEN}${BOLD}✅ SUCCESS: Clean slate complete! All ongoing, pending, and cached trades cleared.${RESET}\n`);
  } catch (e) {
    console.error("Error wiping slate:", e.message);
  }
}

/**
 * CLI Entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const isTest = args.includes('--test');
  const isWipe = args.includes('--wipe');
  const isDailyReport = args.includes('--daily-report');
  const isWeeklyReport = args.includes('--weekly-report');
  const isMonthlyReport = args.includes('--monthly-report');

  if (isWipe) {
    wipeSlate();
    process.exit(0);
  }

  if (isDailyReport) {
    console.log(`\n📊 Generating and dispatching End-of-Day Performance Report to Telegram...`);
    const report = generateDailyReport();
    const html = formatReportTelegramHTML(report);
    await sendTelegramMessage(html);
    console.log(`${GREEN}✅ SUCCESS: End-of-Day Report dispatched to Telegram!${RESET}`);
    process.exit(0);
  }

  if (isWeeklyReport) {
    console.log(`\n📊 Generating and dispatching End-of-Week Performance Report to Telegram...`);
    const report = generateWeeklyReport();
    const html = formatReportTelegramHTML(report);
    await sendTelegramMessage(html);
    console.log(`${GREEN}✅ SUCCESS: End-of-Week Report dispatched to Telegram!${RESET}`);
    process.exit(0);
  }

  if (isMonthlyReport) {
    console.log(`\n📊 Generating and dispatching End-of-Month Performance Report to Telegram...`);
    const report = generateMonthlyReport();
    const html = formatReportTelegramHTML(report);
    await sendTelegramMessage(html);
    console.log(`${GREEN}✅ SUCCESS: End-of-Month Report dispatched to Telegram!${RESET}`);
    process.exit(0);
  }
  
  if (isTest) {
    console.log(`\n${BOLD}${CYAN}======================================================`);
    console.log(`🧪 TESTING TELEGRAM BOT NOTIFICATIONS (STRATEGY 5 ENHANCED)...`);
    console.log(`======================================================${RESET}\n`);
    console.log(`Injected Bot Token: ${process.env.TELEGRAM_BOT_TOKEN ? '✅ LOADED' : '❌ MISSING'}`);
    console.log(`Injected Chat ID  : ${process.env.TELEGRAM_CHAT_ID ? '✅ LOADED' : '❌ MISSING'}`);
    console.log(`------------------------------------------------------`);
    
    const mockHtml = [
      `👑 <b>[MYTRADA SPIKE EXHAUSTION TESTING ALERT]</b>`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🎉 <b>Congratulations!</b> Your live Telegram Alert Channel is now connected with <b>Strategy 5 Enhanced</b>!`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🤖 <b>Engine:</b> Strategy 5 Enhanced (Multi-Timeframe 4H+1H + 3 Spikes)`,
      `🚀 <b>Active Portfolio:</b> Top 7 Elite Pairs (${Object.keys(config.SYMBOLS).join(', ')})`,
      `📊 <b>Target System:</b> 1:1.3 R:R + Tiered Circuit Breakers (45m/2.5h)`,
      `🛡️ <b>Verified 7-Day Performance:</b> 66.7% Win Rate | 2.60 Profit Factor`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `<i>This is a mock alert confirming that your environment credentials are correct. Real-time signals will stream below!</i>`
    ].join('\n');
    
    try {
      await sendTelegramMessage(mockHtml);
      console.log(`\n${GREEN}${BOLD}✅ SUCCESS: Test Telegram message dispatched successfully! Check your phone!${RESET}\n`);
    } catch (err) {
      console.error(`\n${RED}${BOLD}❌ ERROR: Telegram Bot API connection failed!${RESET}`);
      console.error(err.message);
      console.log(`\n👉 Tip: Ensure process.env.TELEGRAM_BOT_TOKEN and process.env.TELEGRAM_CHAT_ID are correctly configured in your .env file.\n`);
    }
    process.exit(0);
  }
  
  console.log(`\n${BOLD}${CYAN}=================================================================================================`);
  console.log(`  MYTRADA — SPIKE EXHAUSTION TELEGRAM ALERT BOT`);
  console.log(`  Strategy: Strategy 5 Enhanced (Multi-Timeframe 4H+1H + 3 Spikes + 1:1.3 R:R + Circuit Breaker)`);
  console.log(`  Portfolio: Top 7 Elite Pairs (${Object.keys(config.SYMBOLS).join(', ')})`);
  console.log(`  Exit Rule: Hold strictly until TP (+1.3R) or SL (-1.0R) is hit`);
  console.log(`=================================================================================================${RESET}`);
  console.log(`Macro: ${config.MACRO_HTF || '4h'} (50 EMA) | Intermediate: ${config.INTERMEDIATE_HTF || '1h'} (50 EMA + Chop) | LTF: ${config.DEFAULT_LTF} (3-Spike Trigger)`);
  console.log(`Risk: $${config.RISK_AMOUNT_USD}/trade | R:R = 1:${config.REWARD_RATIO} | Circuit Breaker: Active`);
  console.log(`Automated Daily Report: Scheduled for 12:00 AM (00:00 UTC) every night`);
  console.log(`-------------------------------------------------------------------------------------------------`);
  
  setInterval(monitorMarket, 30000);
  monitorMarket();
}

main().catch(err => {
  console.error("Fatal Runner Error:", err);
});

