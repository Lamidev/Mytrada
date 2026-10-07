// runner.js
/**
 * Mytrada - Strategy 5B/5C Institutional Momentum Guard (Upgraded Production Standard)
 *
 * Execution Core:
 *  - 11 Elite Boom & Crash Portfolio (Daily + 4H + 1H 50 EMA Trend Alignment)
 *  - 2–3 Spike Cluster Exhaustion Trigger (5M Body >= 50%) — Tailored per pair (3 spikes on fast Boom 300 / Boom 200)
 *  - Fixed 1:1.3 R:R Sniper Target with Dynamic Lot Sizing (3% Equity Risk)
 *  - Responsive Tiered Circuit Breakers (45m Loss Cooldown / 2-Loss Daily Lockout / 3-Loss Portfolio Pause)
 *  - Dynamic Daily Profit Target & Lockout Engine with Auto-Resume at 12:00 AM UTC
 *  - Interactive Telegram Remote Control & Inbound Command Center (/status, /trades, /target, /lock, /pause, /resume, /risk, /be)
 *  - Automated 12:00 AM Midnight Daily Performance Report with Pair-by-Pair Breakdown
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getCandles } = require('./dataFetcher');
const { auditTradeWithVision } = require('./aiVisionAuditor');
const { sendTelegramMessage, startTelegramListener } = require('./telegramBot');
const { 
  recordSignal, 
  recordTrigger, 
  recordClose, 
  generateDailyReport, 
  generateWeeklyReport,
  formatReportTelegramHTML,
  getCurrentAccountBalance,
  getWeeklyCompoundedRisk,
  loadShadowHistory,
  recordShadowOutcome,
  loadIncubationHistory,
  recordIncubationOutcome
} = require('./reportManager');
const {
  evaluateMacroExhaustion,
  recordGodEyesOutcome,
  runMidnightGitSync
} = require('./godeyesMemory');

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
const SHADOW_TRADES_FILE = path.join(CACHE_DIR, 'shadow_trades.json');
const CIRCUIT_BREAKER_FILE = path.join(CACHE_DIR, 'circuit_breaker_state.json');
const PAIR_HEALTH_FILE = path.join(CACHE_DIR, 'pair_health_state.json');
const DYNAMIC_STATE_FILE = path.join(CACHE_DIR, 'dynamic_state.json');
const LAST_REPORT_DATE_FILE = path.join(CACHE_DIR, 'last_daily_report_date.json');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function loadShadowTrades() {
  if (fs.existsSync(SHADOW_TRADES_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SHADOW_TRADES_FILE, 'utf8'));
    } catch (e) {
      return [];
    }
  }
  return [];
}

function saveShadowTrades(trades) {
  try {
    fs.writeFileSync(SHADOW_TRADES_FILE, JSON.stringify(trades, null, 2), 'utf8');
  } catch (e) {}
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

// ── TIMEZONE HELPERS (TRADER LOCAL TIMEZONE) ──
function getLocalTime(date = new Date()) {
  const offset = config.TIMEZONE_OFFSET_HOURS !== undefined ? config.TIMEZONE_OFFSET_HOURS : 1;
  return new Date(date.getTime() + offset * 60 * 60 * 1000);
}

function getLocalDateStr(date = new Date()) {
  return getLocalTime(date).toISOString().split('T')[0];
}

// ── DYNAMIC STATE & DAILY TARGET MANAGER ──
function loadDynamicState() {
  const today = getLocalDateStr();
  const defaultTarget = config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.DEFAULT_DAILY_PROFIT_TARGET_USD !== undefined
    ? config.CIRCUIT_BREAKER.DEFAULT_DAILY_PROFIT_TARGET_USD
    : 0.0;
  const defaultMaxLoss = config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.DEFAULT_DAILY_MAX_LOSS_USD !== undefined
    ? config.CIRCUIT_BREAKER.DEFAULT_DAILY_MAX_LOSS_USD
    : 0.0;

  if (fs.existsSync(DYNAMIC_STATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(DYNAMIC_STATE_FILE, 'utf8'));
      if (data.date !== today) {
        data.date = today;
        data.dailyTargetLocked = false;
        data.dailyTargetUSD = defaultTarget;
        data.dailyLossLocked = false;
        data.dailyMaxLossUSD = defaultMaxLoss;
        data.portfolioConsecutiveLosses = 0;
        data.portfolioPauseUntil = 0;
        saveDynamicState(data);
      }
      if (data.dailyTargetUSD === 250 || data.dailyTargetUSD === undefined) {
        data.dailyTargetUSD = defaultTarget;
        data.dailyTargetLocked = false;
        saveDynamicState(data);
      }
      if (data.dailyMaxLossUSD === undefined) {
        data.dailyMaxLossUSD = defaultMaxLoss;
        data.dailyLossLocked = false;
        saveDynamicState(data);
      }
      if (!data.activeStrategy) {
        data.activeStrategy = 'NONE';
        saveDynamicState(data);
      }
      if (!data.executionMode) {
        data.executionMode = 'LIVE';
        saveDynamicState(data);
      }
      if (!data.mode5b) {
        data.mode5b = 'PAPER';
        saveDynamicState(data);
      }
      if (!data.mode6pro) {
        data.mode6pro = 'LIVE';
        saveDynamicState(data);
      }
      if (data.is5bPaused === undefined) data.is5bPaused = false;
      if (data.is6proPaused === undefined) data.is6proPaused = false;
      return data;
    } catch (e) {
      console.warn("[runner] Warning loading dynamic state:", e.message);
    }
  }

  const freshState = {
    date: today,
    dailyTargetUSD: defaultTarget,
    dailyTargetLocked: false,
    dailyMaxLossUSD: defaultMaxLoss,
    dailyLossLocked: false,
    isManuallyPaused: false,
    customRiskPercent: null,
    portfolioConsecutiveLosses: 0,
    portfolioPauseUntil: 0,
    activeStrategy: 'BOTH',
    executionMode: 'LIVE',
    mode5b: 'PAPER',
    mode6pro: 'LIVE',
    is5bPaused: false,
    is6proPaused: false
  };
  saveDynamicState(freshState);
  return freshState;
}

function saveDynamicState(state) {
  try {
    fs.writeFileSync(DYNAMIC_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.warn("[runner] Warning saving dynamic state:", e.message);
  }
}

// ── AUTO-RECONCILIATION FOR 6 PRO LIVE LAUNCH ──
const RECONCILED_FLAG_FILE = path.join(CACHE_DIR, 'reconciled_6pro_oct7.json');
if (!fs.existsSync(RECONCILED_FLAG_FILE)) {
  try {
    const { reconcileLedger } = require('./reconcile6ProLedger');
    reconcileLedger();
  } catch (err) {
    console.warn("[runner] Auto-reconciliation notice:", err.message);
  }
}

let dynamicState = loadDynamicState();

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

// ── SMART PAIR HEALTH & AUTO-QUARANTINE MANAGER ──
function loadPairHealthState() {
  if (fs.existsSync(PAIR_HEALTH_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(PAIR_HEALTH_FILE, 'utf8'));
      if (state && Object.keys(state).length > 0) return state;
    } catch (e) {
      console.warn("[runner] Warning loading pair health state:", e.message);
    }
  }
  const defaultState = {
    "BOOM300N": {
      symbol: "BOOM300N",
      consecutiveLosses: 2,
      consecutivePaperWins: 0,
      weeklyNetR: -4.8,
      isQuarantined: true,
      quarantineReason: "Pre-quarantined for New Week (29% WR last week — Needs 2 paper wins to graduate)",
      quarantinedAt: new Date().toISOString(),
      totalRealWins: 4,
      totalRealLosses: 10
    },
    "BOOM900": {
      symbol: "BOOM900",
      consecutiveLosses: 2,
      consecutivePaperWins: 0,
      weeklyNetR: -3.5,
      isQuarantined: true,
      quarantineReason: "Pre-quarantined for New Week (29% WR last week — Needs 2 paper wins to graduate)",
      quarantinedAt: new Date().toISOString(),
      totalRealWins: 5,
      totalRealLosses: 10
    }
  };
  savePairHealthState(defaultState);
  return defaultState;
}

function savePairHealthState(state) {
  try {
    fs.writeFileSync(PAIR_HEALTH_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.warn("[runner] Warning saving pair health state:", e.message);
  }
}

let pairHealthState = loadPairHealthState();

function getPairHealth(symbol) {
  if (!pairHealthState[symbol]) {
    pairHealthState[symbol] = {
      symbol,
      consecutiveLosses: 0,
      consecutivePaperWins: 0,
      weeklyNetR: 0.0,
      isQuarantined: false,
      quarantineReason: null,
      quarantinedAt: null,
      totalRealWins: 0,
      totalRealLosses: 0
    };
  }
  return pairHealthState[symbol];
}

async function updatePairHealthOnLiveClose(symbol, outcome) {
  const rec = getPairHealth(symbol);
  if (outcome === 'WIN') {
    rec.consecutiveLosses = 0;
    rec.weeklyNetR = (rec.weeklyNetR || 0) + 1.3;
    rec.totalRealWins = (rec.totalRealWins || 0) + 1;
  } else if (outcome === 'LOSS') {
    rec.consecutiveLosses = (rec.consecutiveLosses || 0) + 1;
    rec.weeklyNetR = (rec.weeklyNetR || 0) - 1.0;
    rec.totalRealLosses = (rec.totalRealLosses || 0) + 1;

    // 🛡️ SMART 2-LOSS AUTO-QUARANTINE RULES:
    // Rule 1: 2 consecutive losses with thin/negative profit buffer (< 1.0R) ➔ Instant Demotion (Locks in profit & prevents flip to negative)
    // Rule 2: 3 consecutive losses (hard safety floor for all pairs) ➔ Instant Demotion
    const isBufferThin = rec.weeklyNetR < 1.0;
    const shouldQuarantine = (rec.consecutiveLosses >= 2 && isBufferThin) || (rec.consecutiveLosses >= 3);

    if (shouldQuarantine && !rec.isQuarantined) {
      rec.isQuarantined = true;
      rec.quarantineReason = (rec.consecutiveLosses >= 2 && isBufferThin)
        ? `2 Consecutive Losses with Thin Profit Buffer (${rec.weeklyNetR >= 0 ? '+' : ''}${rec.weeklyNetR.toFixed(1)}R < 1.0R)`
        : `3 Consecutive Losses (Hard Safety Floor)`;
      rec.quarantinedAt = new Date().toISOString();
      rec.consecutivePaperWins = 0;

      savePairHealthState(pairHealthState);

      const alertMsg = [
        `⚠️ 🛡️ <b>[MYTRADA AUTO-QUARANTINE ACTIVATED]</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].name : symbol})`,
        `<b>Trigger:</b> <code>${rec.quarantineReason}</code>`,
        `<b>Action:</b> <b>Demoted to Paper Test Mode ($0 Real Risk)</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `📊 <b>Pair Record:</b> <code>${rec.totalRealWins}W / ${rec.totalRealLosses}L (${rec.weeklyNetR >= 0 ? '+' : ''}${rec.weeklyNetR.toFixed(1)}R)</code>`,
        `💵 <b>Live Account Balance Protected:</b> <code>$${getCurrentAccountBalance().toFixed(2)} USD</code>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `💡 <i>Bot will safely forward-test this pair in paper sandbox until it scores 1 winning paper setup, or send /unquarantine ${symbol} to override.</i>`
      ].join('\n');

      await sendTelegramMessage(alertMsg);
      console.log(`\n⚠️ [AUTO-QUARANTINE] ${symbol} demoted to Paper Mode: ${rec.quarantineReason}\n`);
    }
  }

  savePairHealthState(pairHealthState);
}

async function updatePairHealthOnPaperClose(symbol, outcome) {
  const rec = getPairHealth(symbol);
  if (!rec.isQuarantined) return;

  if (outcome === 'WIN') {
    rec.consecutivePaperWins = (rec.consecutivePaperWins || 0) + 1;
    if (rec.consecutivePaperWins >= 1) {
      // 🏆 Proof-of-Health Achieved: Restore to Live Trading!
      rec.isQuarantined = false;
      rec.consecutiveLosses = 0;
      rec.consecutivePaperWins = 0;
      rec.quarantineReason = null;
      rec.quarantinedAt = null;

      savePairHealthState(pairHealthState);

      const cbRec = circuitBreakerState.symbols && circuitBreakerState.symbols[symbol];
      const isDailyLocked = cbRec && cbRec.dailyLosses >= (config.CIRCUIT_BREAKER.MAX_DAILY_LOSSES_PER_SYMBOL || 2);

      const actionLine = isDailyLocked
        ? `<b>Action:</b> <b>Restored for Tomorrow Morning!</b>`
        : `<b>Action:</b> <b>Restored to Live Real Trading Universe!</b>`;

      const noteLine = isDailyLocked
        ? `🛡️ <i>Proof of health achieved! Cleared for Live trading upon 12:00 AM UTC rollover (today's daily 2-loss limit shields real balance until then).</i>`
        : `🚀 <i>Market structure & trend clarity have stabilized. Real execution re-enabled.</i>`;

      const alertMsg = [
        `🏆 🟢 <b>[PAIR GRADUATION: RESTORED TO LIVE]</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].name : symbol})`,
        `<b>Achievement:</b> <code>1 Winning Paper Setup (+1.3R)</code>`,
        actionLine,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        noteLine
      ].join('\n');

      await sendTelegramMessage(alertMsg);
      console.log(`\n🏆 [PAIR GRADUATION] ${symbol} achieved 1 winning paper trade -> Restored to Live Trading${isDailyLocked ? ' (active tomorrow after rollover)' : ''}!\n`);
    }
  } else if (outcome === 'LOSS') {
    rec.consecutivePaperWins = 0;
  }

  savePairHealthState(pairHealthState);
}

function manualSetQuarantine(symbol, isQuarantined, reason = 'Manual update via Telegram') {
  if (!config.SYMBOLS[symbol]) {
    return { success: false, error: `Symbol ${symbol} not in configured universe.` };
  }
  const rec = getPairHealth(symbol);
  rec.isQuarantined = isQuarantined;
  if (isQuarantined) {
    rec.quarantineReason = reason;
    rec.quarantinedAt = new Date().toISOString();
    rec.consecutivePaperWins = 0;
  } else {
    rec.consecutiveLosses = 0;
    rec.consecutivePaperWins = 0;
    rec.quarantineReason = null;
    rec.quarantinedAt = null;
  }
  savePairHealthState(pairHealthState);
  return { success: true };
}

function formatHealthTelegramHTML() {
  const symbols = Object.keys(config.SYMBOLS);
  const lines = [
    `🏥 <b>[MYTRADA MULTI-PAIR HEALTH SCORECARD]</b>`,
    `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`
  ];

  let liveCount = 0;
  let quarantinedCount = 0;

  for (const sym of symbols) {
    const symConfig = config.SYMBOLS[sym];
    const rec = getPairHealth(sym);
    const isIncub = symConfig.monitorOnly;

    let badge = '🟢 <b>HEALTHY</b>';
    let statusText = 'Live Trading';

    if (isIncub) {
      badge = '🔬 <b>INCUBATION</b>';
      statusText = 'Permanent Sandbox';
    } else if (rec.isQuarantined) {
      badge = '🔴 <b>QUARANTINED</b>';
      statusText = `Paper Mode (${rec.consecutivePaperWins || 0}/1 Win to Graduate)`;
      quarantinedCount++;
    } else if (rec.consecutiveLosses === 1) {
      badge = '🟡 <b>PROBATION</b>';
      statusText = `1 Loss (Watching)`;
      liveCount++;
    } else {
      liveCount++;
    }

    const netR = rec.weeklyNetR || 0.0;
    const rSign = netR >= 0 ? '+' : '';

    lines.push(`• <b>${sym}:</b> ${badge}`);
    lines.push(`  ├ <b>Status:</b> <code>${statusText}</code>`);
    lines.push(`  └ <b>Weekly Net:</b> <code>${rSign}${netR.toFixed(1)}R (${rec.totalRealWins || 0}W / ${rec.totalRealLosses || 0}L)</code>`);
  }

  lines.push(`<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`);
  lines.push(`📊 <b>Summary:</b> <code>${liveCount} Live Pairs | ${quarantinedCount} Quarantined</code>`);
  lines.push(`💡 <i>Use /quarantine &lt;sym&gt; or /unquarantine &lt;sym&gt; to manage.</i>`);

  return lines.join('\n');
}

function isSymbolInCooldown(symbol) {
  if (!config.CIRCUIT_BREAKER || !config.CIRCUIT_BREAKER.ENABLED) return { inCooldown: false };
  
  // Always load fresh state from disk to guarantee instant cross-monitor synchronization
  circuitBreakerState = loadCircuitBreakerState();

  const rec = circuitBreakerState.symbols && circuitBreakerState.symbols[symbol];
  if (!rec) return { inCooldown: false };

  if (rec.dailyLosses >= (config.CIRCUIT_BREAKER.MAX_DAILY_LOSSES_PER_SYMBOL || 2)) {
    return { inCooldown: true, reason: `Daily limit (${rec.dailyLosses} losses) reached` };
  }

  const now = Date.now();
  if (rec.pauseUntil && now < rec.pauseUntil) {
    const remMins = Math.ceil((rec.pauseUntil - now) / 60000);
    const reason = (rec.consecutiveLosses === 0 && rec.dailyLosses < (config.CIRCUIT_BREAKER.MAX_DAILY_LOSSES_PER_SYMBOL || 2))
      ? `Post-Win breathing room (${remMins}m remaining)`
      : `Cooldown active — ${remMins}m remaining`;
    return { inCooldown: true, reason };
  }

  return { inCooldown: false };
}

function recordSymbolTradeOutcome(symbol, outcome, isPaper = false) {
  const today = new Date().toISOString().slice(0, 10);
  if (!circuitBreakerState || circuitBreakerState.date !== today) {
    circuitBreakerState = loadCircuitBreakerState();
  }
  if (!dynamicState || dynamicState.date !== today) {
    dynamicState = loadDynamicState();
  }

  if (!circuitBreakerState.symbols) circuitBreakerState.symbols = {};
  if (!circuitBreakerState.symbols[symbol]) {
    circuitBreakerState.symbols[symbol] = { consecutiveLosses: 0, dailyLosses: 0, pauseUntil: 0 };
  }

  const rec = circuitBreakerState.symbols[symbol];
  const now = Date.now();

  if (outcome === 'WIN') {
    rec.consecutiveLosses = 0;
    dynamicState.portfolioConsecutiveLosses = 0;

    // 👑 Institutional Post-Win Breathing Room: pause symbol to prevent immediate tail-end re-entry
    const postWinMins = config.CIRCUIT_BREAKER.POST_WIN_PAUSE_MINS || 35;
    rec.pauseUntil = Math.max(rec.pauseUntil || 0, now + (postWinMins * 60 * 1000));
  } else if (outcome === 'LOSS') {
    rec.consecutiveLosses = (rec.consecutiveLosses || 0) + 1;
    rec.dailyLosses = (rec.dailyLosses || 0) + 1;
    dynamicState.portfolioConsecutiveLosses = (dynamicState.portfolioConsecutiveLosses || 0) + 1;

    // Symbol-Level Responsive Tiered Circuit Breakers:
    if (rec.dailyLosses >= (config.CIRCUIT_BREAKER.MAX_DAILY_LOSSES_PER_SYMBOL || 2)) {
      const endOfDay = new Date();
      endOfDay.setUTCHours(23, 59, 59, 999);
      rec.pauseUntil = endOfDay.getTime();
      sendTelegramMessage([
        `🛑 🛡️ <b>[SYMBOL DAILY LOSS LIMIT REACHED]</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].name : symbol})`,
        `<b>Trigger:</b> <code>${rec.dailyLosses} losses today</code> (${isPaper ? 'Paper Sandbox' : 'Live Trading'}).`,
        `<b>Action:</b> Trading paused on <b>${symbol}</b> until <b>12:00 AM UTC</b> to protect performance.`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `<i>Remaining healthy pairs will continue scanning normally.</i>`
      ].join('\n')).catch(() => null);
    } else if (rec.consecutiveLosses >= 2) {
      const tier2Mins = config.CIRCUIT_BREAKER.TIER_2_PAUSE_MINS || 60;
      rec.pauseUntil = now + (tier2Mins * 60 * 1000);
    } else {
      const tier1Mins = config.CIRCUIT_BREAKER.TIER_1_PAUSE_MINS || 45;
      rec.pauseUntil = now + (tier1Mins * 60 * 1000);
    }

    // Portfolio-Wide Consecutive Loss Breaker (e.g. 3 consecutive losses across ANY pairs):
    const maxPortfolioLosses = config.CIRCUIT_BREAKER.PORTFOLIO_CONSECUTIVE_LOSS_LIMIT || 3;
    if (dynamicState.portfolioConsecutiveLosses >= maxPortfolioLosses) {
      const pauseMins = config.CIRCUIT_BREAKER.PORTFOLIO_LOSS_PAUSE_MINS || 60;
      dynamicState.portfolioPauseUntil = now + (pauseMins * 60 * 1000);
      dynamicState.portfolioConsecutiveLosses = 0; // Reset counter so subsequent trades don't keep firing immediately
      sendTelegramMessage([
        `⚠️ 🛡️ <b>[MYTRADA PORTFOLIO CIRCUIT BREAKER]</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `<b>Trigger:</b> <code>${maxPortfolioLosses} consecutive losses</code> hit across portfolio (${isPaper ? 'Paper Sandbox' : 'Live Trading'}).`,
        `<b>Action:</b> Entire bot paused for <b>${pauseMins} minutes</b> to let market turbulence settle.`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `<i>Active positions will continue monitoring to TP/SL. Send /resume to override.</i>`
      ].join('\n')).catch(() => null);
    }
  }

  saveCircuitBreakerState(circuitBreakerState);
  saveDynamicState(dynamicState);
}

// ── AUTO BREAKEVEN & MANUAL CLOSE ENGINE ──
async function autoBreakevenProfitableTrades() {
  const activeTrades = loadActiveTrades();
  if (!activeTrades || activeTrades.length === 0) return [];

  const summary = [];
  let updated = false;

  for (const trade of activeTrades) {
    try {
      const candles = await getCandles(trade.symbol, config.DEFAULT_LTF || '5m', 5, true);
      if (!candles || candles.length === 0) continue;
      const livePrice = candles[candles.length - 1].close;
      const isBullish = trade.type === 'bullish';
      const inProfit = isBullish ? (livePrice > trade.entryPrice) : (livePrice < trade.entryPrice);

      if (inProfit) {
        trade.stopLoss = trade.entryPrice;
        trade.isBreakeven = true;
        updated = true;
        summary.push(`• 🟢 <b>${trade.symbol}</b>: In Profit @ ${livePrice.toFixed(2)} ➔ 🛡️ <b>SL moved to Breakeven ($0 risk)</b>`);
      } else {
        summary.push(`• 🔴 <b>${trade.symbol}</b>: In Drawdown @ ${livePrice.toFixed(2)} ➔ 🛡️ <i>SL protected at ${trade.stopLoss.toFixed(2)}</i>`);
      }
    } catch (e) {
      summary.push(`• ⚪ <b>${trade.symbol}</b>: Active position monitoring`);
    }
  }

  if (updated) {
    saveActiveTrades(activeTrades);
  }
  return summary;
}

async function closeTradeManually(symbol, skipTargetCheck = false) {
  const activeTrades = loadActiveTrades();
  const trade = activeTrades.find(t => t.symbol === symbol);
  if (!trade) {
    return { success: false, message: `⚠️ No active trade found for <code>${symbol}</code>.` };
  }

  let livePrice = trade.entryPrice;
  try {
    const candles = await getCandles(symbol, config.DEFAULT_LTF || '5m', 5, true);
    if (candles && candles.length > 0) {
      livePrice = candles[candles.length - 1].close;
    }
  } catch (e) {}

  const isBullish = trade.type === 'bullish';
  const slDist = Math.abs(trade.entryPrice - trade.stopLoss);
  const priceDiff = isBullish ? (livePrice - trade.entryPrice) : (trade.entryPrice - livePrice);
  const compRisk = getWeeklyCompoundedRisk();
  const riskUSD = trade.riskUSD || compRisk.riskUSD;
  const pnlR = slDist > 0 ? (priceDiff / slDist) : 0;
  const pnlUSD = pnlR * riskUSD;
  const outcome = pnlUSD >= 0 ? 'WIN' : 'LOSS';

  recordSymbolTradeOutcome(symbol, outcome);
  recordClose(trade.setupId, outcome, livePrice, pnlUSD, pnlR, 'MANUAL_CLOSE');

  const updatedTrades = activeTrades.filter(t => t.setupId !== trade.setupId);
  saveActiveTrades(updatedTrades);
  if (!skipTargetCheck) {
    await checkDailyTargetLock();
    await checkDailyMaxLossLock();
  }

  const newBalance = getCurrentAccountBalance();
  const pnlSign = pnlUSD >= 0 ? '+' : '-';
  const statusEmoji = pnlUSD >= 0 ? '🟢' : '🔴';

  return {
    success: true,
    message: [
      `✂️ ${statusEmoji} <b>[MYTRADA MANUAL TRADE CLOSED]</b>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `<b>Asset:</b> <code>${symbol}</code> (${isBullish ? 'BUY' : 'SELL'})`,
      `<b>Exit Price:</b> <code>${livePrice.toFixed(2)}</code> (Entry: ${trade.entryPrice.toFixed(2)})`,
      `💰 <b>Realized PnL:</b> <code>${pnlSign}$${Math.abs(pnlUSD).toFixed(2)} USD (${pnlSign}${Math.abs(pnlR).toFixed(2)}R)</code>`,
      `💵 <b>New Balance:</b> <code>$${newBalance.toFixed(2)} USD</code>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`
    ].join('\n')
  };
}

async function closeAllTradesManually() {
  const activeTrades = loadActiveTrades();
  if (!activeTrades || activeTrades.length === 0) {
    return { success: false, message: `⚠️ No active positions currently open.`, results: [] };
  }

  const results = [];
  for (const t of activeTrades) {
    const res = await closeTradeManually(t.symbol, true);
    results.push(res.message);
  }

  return {
    success: true,
    message: `✂️ <b>[CLOSED ALL POSITIONS]</b>\n\n${results.join('\n\n')}`,
    results
  };
}

// ── DAILY PROFIT TARGET CIRCUIT BREAKER ──
async function checkDailyTargetLock() {
  const todayStr = getLocalDateStr();
  if (!dynamicState || dynamicState.date !== todayStr) {
    dynamicState = loadDynamicState();
  }

  if (dynamicState.dailyTargetLocked || !dynamicState.dailyTargetUSD || dynamicState.dailyTargetUSD <= 0) {
    return;
  }

  const todayReport = generateDailyReport(todayStr);
  const targetThreshold = dynamicState.dailyTargetUSD * 0.90;
  const remainingNeeded = dynamicState.dailyTargetUSD - todayReport.netUSD;
  const riskPct = dynamicState.customRiskPercent || 2.5;
  const currentBal = todayReport.newBalance || 3000;
  const standardRiskUSD = currentBal * (riskPct / 100);

  const isExactTargetReached = todayReport.netUSD >= dynamicState.dailyTargetUSD;
  const isNearTargetSecured = todayReport.netUSD >= targetThreshold && remainingNeeded <= (standardRiskUSD * 1.3);

  if (isExactTargetReached || isNearTargetSecured) {
    dynamicState.dailyTargetLocked = true;
    saveDynamicState(dynamicState);

    // 👑 Auto-close ALL active positions at current market to bank floating profit & eliminate all open risk
    const closeRes = await closeAllTradesManually();
    const finalReport = generateDailyReport(todayStr);

    const isNearLock = !isExactTargetReached && finalReport.netUSD < dynamicState.dailyTargetUSD;
    const title = isNearLock 
      ? `🎯 🛡️ <b>[MYTRADA TARGET ZONE SECURED (90%+ ACHIEVED)]</b>`
      : `🎯 🟢 <b>[MYTRADA DAILY PROFIT TARGET REACHED!]</b>`;

    const alertLines = [
      title,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `💰 <b>Final Realized Today:</b> <code>+$${finalReport.netUSD.toFixed(2)} USD (${finalReport.netR >= 0 ? '+' : ''}${finalReport.netR.toFixed(1)}R)</code>`,
      `🎯 <b>Target Goal:</b> <code>+$${dynamicState.dailyTargetUSD.toFixed(2)} USD</code>` + (isNearLock ? ` <i>(${((finalReport.netUSD / dynamicState.dailyTargetUSD) * 100).toFixed(1)}% bagged)</i>` : ``),
      `📊 <b>Today's Record:</b> <code>${finalReport.wins}W / ${finalReport.losses}L (${finalReport.winRate}% WR)</code>`,
      `💵 <b>Final Account Equity:</b> <code>$${finalReport.newBalance.toFixed(2)} USD</code>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      isNearLock 
        ? `🛡️ <b>Asymmetric Target Protection:</b> Remaining gap ($${Math.max(0, dynamicState.dailyTargetUSD - finalReport.netUSD).toFixed(2)}) is smaller than 1 trade risk ($${standardRiskUSD.toFixed(2)}). Profit bagged & protected!`
        : `✂️ <b>All active positions closed at market to lock in 100% of profits.</b>`,
      `🔒 <b>Status:</b> <b>TRADING HALTED FOR THE DAY (0 Open Risk)</b>`
    ];

    if (closeRes.success && closeRes.results && closeRes.results.length > 0) {
      alertLines.push(`<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`);
      alertLines.push(`📂 <b>POSITIONS CLOSED AT TARGET:</b>`);
      alertLines.push(...closeRes.results);
    }

    alertLines.push(`<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`);
    alertLines.push(`⏳ <i>Zero market exposure. Bot will automatically reset & resume tomorrow at 12:00 AM UTC. Send /resume to override now.</i>`);

    await sendTelegramMessage(alertLines.join('\n'));
    console.log(`\n🎯 [TARGET HIT] Daily profit target (+$${dynamicState.dailyTargetUSD}) achieved or secured at 90%+! All active trades closed and trading locked for remainder of day.\n`);
  }
}

async function checkDailyMaxLossLock() {
  const todayStr = getLocalDateStr();
  if (!dynamicState || dynamicState.date !== todayStr) {
    dynamicState = loadDynamicState();
  }

  if (dynamicState.dailyLossLocked || !dynamicState.dailyMaxLossUSD || dynamicState.dailyMaxLossUSD <= 0) {
    return;
  }

  const todayReport = generateDailyReport(todayStr);
  // Trigger ONLY if NET Realized PnL today drops below starting balance by dailyMaxLossUSD
  if (todayReport.netUSD <= -dynamicState.dailyMaxLossUSD) {
    dynamicState.dailyLossLocked = true;
    saveDynamicState(dynamicState);

    const closeRes = await closeAllTradesManually();
    const finalReport = generateDailyReport(todayStr);

    const alertLines = [
      `🛑 🛡️ <b>[MYTRADA DAILY MAX LOSS SHIELD ACTIVATED]</b>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `💸 <b>Final Realized Today:</b> <code>-$${Math.abs(finalReport.netUSD).toFixed(2)} USD (${finalReport.netR >= 0 ? '+' : ''}${finalReport.netR.toFixed(1)}R)</code>`,
      `🛡️ <b>Max Loss Floor:</b> <code>-$${dynamicState.dailyMaxLossUSD.toFixed(2)} USD</code>`,
      `📊 <b>Today's Record:</b> <code>${finalReport.wins}W / ${finalReport.losses}L (${finalReport.winRate}% WR)</code>`,
      `💵 <b>Preserved Account Equity:</b> <code>$${finalReport.newBalance.toFixed(2)} USD</code>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `✂️ <b>All active positions closed at market to eliminate floating risk.</b>`,
      `🛑 <b>Status:</b> <b>TRADING HALTED FOR THE DAY (Capital Preserved)</b>`
    ];

    if (closeRes.success && closeRes.results && closeRes.results.length > 0) {
      alertLines.push(`<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`);
      alertLines.push(`📂 <b>POSITIONS CLOSED AT SHIELD:</b>`);
      alertLines.push(...closeRes.results);
    }

    alertLines.push(`<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`);
    alertLines.push(`⏳ <i>Zero market exposure. Bot will automatically reset & resume tomorrow at 12:00 AM UTC. Send /resume to override now.</i>`);

    await sendTelegramMessage(alertLines.join('\n'));
    console.log(`\n🛑 [LOSS SHIELD HIT] Daily max loss floor (-$${dynamicState.dailyMaxLossUSD}) reached! Trading locked for remainder of day.\n`);
  }
}

// ── TELEGRAM INBOUND COMMAND HANDLERS ──
const telegramHandlers = {
  getStatus: async () => {
    const todayStr = getLocalDateStr();
    const report = generateDailyReport(todayStr);
    const compRisk = getWeeklyCompoundedRisk();
    const activeTrades = loadActiveTrades();
    const now = Date.now();

    // Check pair cooldowns
    const cooldowns = [];
    if (circuitBreakerState && circuitBreakerState.symbols) {
      for (const [sym, rec] of Object.entries(circuitBreakerState.symbols)) {
        if (rec.pauseUntil && now < rec.pauseUntil) {
          const rem = Math.ceil((rec.pauseUntil - now) / 60000);
          cooldowns.push(`• <code>${sym}</code>: ${rem}m remaining (${rec.dailyLosses || 0} losses today)`);
        }
      }
    }

    let stateBadge = '🟢 <b>ACTIVE & SCANNING</b>';
    if (dynamicState.isManuallyPaused) stateBadge = '⏸️ <b>MANUALLY PAUSED (/resume to restart)</b>';
    else if (dynamicState.dailyTargetLocked) stateBadge = '🎯 <b>DAILY TARGET LOCKED (Resumes 12 AM)</b>';
    else if (dynamicState.dailyLossLocked) stateBadge = '🛑 <b>DAILY MAX LOSS LOCKED (Resumes 12 AM)</b>';
    else if (dynamicState.portfolioPauseUntil && now < dynamicState.portfolioPauseUntil) {
      const rem = Math.ceil((dynamicState.portfolioPauseUntil - now) / 60000);
      stateBadge = `⚠️ <b>PORTFOLIO COOLDOWN (${rem}m remaining)</b>`;
    }

    const pnlSign = report.netUSD >= 0 ? '+' : '-';
    const targetStatus = (dynamicState.dailyTargetUSD && dynamicState.dailyTargetUSD > 0)
      ? `$${dynamicState.dailyTargetUSD.toFixed(2)} USD ${dynamicState.dailyTargetLocked ? '🔒 (HIT)' : `(Need: $${Math.max(0, dynamicState.dailyTargetUSD - report.netUSD).toFixed(2)})`}`
      : 'Disabled (Full Session)';

    const maxLossStatus = (dynamicState.dailyMaxLossUSD && dynamicState.dailyMaxLossUSD > 0)
      ? `-$${dynamicState.dailyMaxLossUSD.toFixed(2)} USD ${dynamicState.dailyLossLocked ? '🛑 (HIT)' : `(Remaining Buffer: $${Math.max(0, dynamicState.dailyMaxLossUSD + report.netUSD).toFixed(2)})`}`
      : 'Disabled (No Floor)';

    let stratBadge = '🟡 <b>STANDBY (Awaiting /strategy command)</b>';
    if (dynamicState.activeStrategy === 'BOTH') {
      const mode5bLabel = dynamicState.is5bPaused ? '⏸️ PAUSED' : (dynamicState.mode5b === 'PAPER' ? '🔬 PAPER' : '🟢 LIVE');
      const mode6Label = dynamicState.is6proPaused ? '⏸️ PAUSED' : (dynamicState.mode6pro === 'PAPER' ? '🔬 PAPER' : '🟢 LIVE');
      stratBadge = `⚡ <b>DUAL ENGINE</b> (6 Pro: ${mode6Label} | 5B: ${mode5bLabel})`;
    } else if (dynamicState.activeStrategy === 'STRATEGY_6_PRO') {
      const mode6Label = dynamicState.is6proPaused ? '⏸️ PAUSED' : (dynamicState.executionMode === 'PAPER' ? '🔬 PAPER' : '🟢 LIVE');
      stratBadge = `👑 <b>Strategy 6 Pro</b> (${mode6Label})`;
    } else if (dynamicState.activeStrategy === 'STRATEGY_5B') {
      const mode5bLabel = dynamicState.is5bPaused ? '⏸️ PAUSED' : (dynamicState.executionMode === 'PAPER' ? '🔬 PAPER' : '🟢 LIVE');
      stratBadge = `🚀 <b>Strategy 5B Enhanced</b> (${mode5bLabel})`;
    }

    const maxLiveLimit = config.MAX_CONCURRENT_LIVE_TRADES || 3;
    const posLabel = paperTradesCount > 0 
      ? `${liveTradesCount}/${maxLiveLimit} Live | ${paperTradesCount} Paper`
      : `${liveTradesCount}/${maxLiveLimit} Live Trade(s)`;

    const lines = [
      `👑 <b>[MYTRADA LIVE STATUS MONITOR]</b>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `💵 <b>Starting Balance:</b> <code>$${(report.startingBalance || 100.0).toFixed(2)} USD</code>`,
      `💰 <b>Current Balance:</b> <code>$${(report.newBalance || 100.0).toFixed(2)} USD</code>`,
      `📈 <b>Today's Realized PnL:</b> <code>${pnlSign}$${Math.abs(report.netUSD).toFixed(2)} USD (${pnlSign}${report.netR.toFixed(1)}R)</code>`,
      `📊 <b>Today's Record:</b> <code>${report.wins} Wins / ${report.losses} Losses (${report.winRate}% WR)</code>`,
      `🎯 <b>Daily Profit Target:</b> <code>${targetStatus}</code>`,
      `🛡️ <b>Daily Max Loss Floor:</b> <code>${maxLossStatus}</code>`,
      `🛡️ <b>Risk Per Trade:</b> <code>$${compRisk.riskUSD.toFixed(2)} USD (${(dynamicState.customRiskPercent || config.RISK_PERCENT || 3.0).toFixed(1)}%)</code>`,
      `🏛️ <b>Strategy Configuration:</b> ${stratBadge}`,
      `🧠 <b>GodEyes Memory Brain:</b> 🟢 <b>ACTIVE (15%/85% Armor + Multi-Day Anchors)</b>`,
      `📂 <b>Active Positions:</b> <code>${posLabel}</code>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `🤖 <b>Engine State:</b> ${stateBadge}`
    ];

    if (cooldowns.length > 0) {
      lines.push(`<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`);
      lines.push(`⏳ <b>ACTIVE PAIR COOLDOWNS:</b>`);
      lines.push(...cooldowns);
    }

    lines.push(`<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`);
    return lines.join('\n');
  },

  getActiveTrades: async () => {
    let activeTrades = loadActiveTrades();
    if (!activeTrades || activeTrades.length === 0) {
      return `📂 <b>[MYTRADA ACTIVE POSITIONS]</b>\n\nNo active trades currently open. Bot is monitoring for new setups.`;
    }

    // Refresh live candles and evaluate TP/SL for all active trades immediately
    for (const t of activeTrades) {
      try {
        const ltf = await getCandles(t.symbol, config.DEFAULT_LTF || '5m', 10, true);
        if (ltf && ltf.length > 0) {
          await checkActiveTradesForSymbol(t.symbol, ltf);
        }
      } catch (e) {}
    }

    activeTrades = loadActiveTrades();
    if (!activeTrades || activeTrades.length === 0) {
      return `📂 <b>[MYTRADA ACTIVE POSITIONS]</b>\n\nAll open positions reached target or closed. No active trades currently open.`;
    }

    const lines = [
      `📂 <b>[MYTRADA ACTIVE POSITIONS (${activeTrades.length})]</b>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`
    ];

    for (const t of activeTrades) {
      const isBullish = t.type === 'bullish';
      const dirLabel = isBullish ? '🟢 BUY' : '🔴 SELL';
      const symName = config.SYMBOLS[t.symbol] ? config.SYMBOLS[t.symbol].name : t.symbol;
      const slDist = Math.abs(t.entryPrice - t.stopLoss).toFixed(2);
      const tpDist = Math.abs(t.entryPrice - t.takeProfit).toFixed(2);

      let statusTag = t.isBreakeven ? ' 🛡️ [BREAKEVEN]' : '';
      lines.push(`<b>${t.symbol}</b> (${symName})${statusTag}`);
      lines.push(`• <b>Action:</b> ${dirLabel} @ <code>${t.entryPrice.toFixed(2)}</code>`);
      lines.push(`• 🎯 <b>TP:</b> <code>${t.takeProfit.toFixed(2)}</code> (+${tpDist} pts • +$${(t.rewardUSD || 0).toFixed(2)})`);
      lines.push(`• 🛡️ <b>SL:</b> <code>${t.stopLoss.toFixed(2)}</code> (-${slDist} pts • -$${(t.riskUSD || 0).toFixed(2)})`);
      lines.push(`• 💡 <i>To close this trade now: /close ${t.symbol}</i>`);
      lines.push(`<code>──────────────────────────</code>`);
    }

    return lines.join('\n');
  },

  getDailyTarget: () => {
    return dynamicState.dailyTargetUSD || 0;
  },

  setDailyTarget: async (val) => {
    dynamicState.dailyTargetUSD = val;
    dynamicState.dailyTargetLocked = false;
    const todayStr = getLocalDateStr();
    const report = generateDailyReport(todayStr);
    let alreadyHit = false;
    if (val > 0 && report.netUSD >= val) {
      dynamicState.dailyTargetLocked = true;
      alreadyHit = true;
      await closeAllTradesManually();
    }
    saveDynamicState(dynamicState);
    const finalReport = generateDailyReport(todayStr);
    return { alreadyHit, todayNet: finalReport.netUSD };
  },

  getDailyMaxLoss: () => {
    return dynamicState.dailyMaxLossUSD || 0;
  },

  setDailyMaxLoss: async (val) => {
    dynamicState.dailyMaxLossUSD = val;
    dynamicState.dailyLossLocked = false;
    const todayStr = getLocalDateStr();
    const report = generateDailyReport(todayStr);
    let alreadyHit = false;
    if (val > 0 && report.netUSD <= -val) {
      dynamicState.dailyLossLocked = true;
      alreadyHit = true;
      await closeAllTradesManually();
    }
    saveDynamicState(dynamicState);
    const finalReport = generateDailyReport(todayStr);
    return { alreadyHit, todayNet: finalReport.netUSD };
  },

  lockDailyProfit: async () => {
    dynamicState.dailyTargetLocked = true;
    saveDynamicState(dynamicState);
    await closeAllTradesManually();
    const todayStr = getLocalDateStr();
    const report = generateDailyReport(todayStr);
    return {
      todayNet: report.netUSD,
      todayR: report.netR,
      liveBalance: report.newBalance
    };
  },

  pauseBot: () => {
    dynamicState.isManuallyPaused = true;
    saveDynamicState(dynamicState);
  },

  resumeBot: () => {
    dynamicState.isManuallyPaused = false;
    dynamicState.dailyTargetLocked = false;
    dynamicState.dailyTargetUSD = 0; // Clear target so it does not immediately re-lock
    dynamicState.dailyLossLocked = false;
    dynamicState.dailyMaxLossUSD = 0; // Clear max loss so it does not immediately re-lock
    dynamicState.portfolioPauseUntil = 0;
    dynamicState.portfolioConsecutiveLosses = 0;

    const today = getLocalDateStr();
    if (!circuitBreakerState || circuitBreakerState.date !== today) {
      circuitBreakerState = loadCircuitBreakerState();
    }

    // Unpause symbols that have not breached their daily limit,
    // but PRESERVE dailyLosses and keep symbols with >= MAX_DAILY_LOSSES halted for the day!
    const maxLosses = config.CIRCUIT_BREAKER.MAX_DAILY_LOSSES_PER_SYMBOL || 2;
    if (circuitBreakerState.symbols) {
      for (const sym of Object.keys(circuitBreakerState.symbols)) {
        const rec = circuitBreakerState.symbols[sym];
        if (rec.dailyLosses < maxLosses) {
          rec.pauseUntil = 0;
          rec.consecutiveLosses = 0;
        }
      }
    }

    saveCircuitBreakerState(circuitBreakerState);
    saveDynamicState(dynamicState);
    return { symbolsCount: Object.keys(config.SYMBOLS).length };
  },

  closeTrade: async (sym) => {
    return await closeTradeManually(sym);
  },

  closeAllTrades: async () => {
    return await closeAllTradesManually();
  },

  setRiskPercent: (pct) => {
    dynamicState.customRiskPercent = pct;
    saveDynamicState(dynamicState);
  },

  setSymbolCooldown: (sym, mins) => {
    if (!circuitBreakerState.symbols) circuitBreakerState.symbols = {};
    if (!circuitBreakerState.symbols[sym]) {
      circuitBreakerState.symbols[sym] = { consecutiveLosses: 0, dailyLosses: 0, pauseUntil: 0 };
    }
    circuitBreakerState.symbols[sym].pauseUntil = Date.now() + (mins * 60 * 1000);
    saveCircuitBreakerState(circuitBreakerState);
  },

  getActiveStrategy: () => {
    return dynamicState.activeStrategy || 'NONE';
  },

  setActiveStrategy: (strat) => {
    dynamicState.activeStrategy = strat;
    dynamicState.is5bPaused = false;
    dynamicState.is6proPaused = false;
    if (strat === 'BOTH') {
      dynamicState.mode5b = 'PAPER';
      dynamicState.mode6pro = 'LIVE';
    }
    saveDynamicState(dynamicState);
  },

  pauseStrategy: (strat) => {
    if (strat === '5b') dynamicState.is5bPaused = true;
    if (strat === '6pro') dynamicState.is6proPaused = true;
    saveDynamicState(dynamicState);
  },

  resumeStrategy: (strat) => {
    if (strat === '5b') dynamicState.is5bPaused = false;
    if (strat === '6pro') dynamicState.is6proPaused = false;
    if (dynamicState.activeStrategy === 'NONE') {
      dynamicState.activeStrategy = strat === '5b' ? 'STRATEGY_5B' : 'STRATEGY_6_PRO';
    }
    saveDynamicState(dynamicState);
  },

  setStrategyMode: (strat, mode) => {
    if (strat === '5b') dynamicState.mode5b = mode;
    if (strat === '6pro') dynamicState.mode6pro = mode;
    saveDynamicState(dynamicState);
  },

  getExecutionMode: () => {
    return dynamicState.executionMode || 'LIVE';
  },

  setExecutionMode: (mode) => {
    dynamicState.executionMode = mode;
    dynamicState.mode5b = mode;
    dynamicState.mode6pro = mode;
    saveDynamicState(dynamicState);
  },

  getDailyReport: (targetDate) => {
    let dateStr = targetDate;
    if (!dateStr) {
      dateStr = getLocalDateStr();
    }
    const report = generateDailyReport(dateStr);
    return formatReportTelegramHTML(report);
  },

  moveToBreakeven: () => {
    const activeTrades = loadActiveTrades();
    let count = 0;
    activeTrades.forEach(t => {
      t.stopLoss = t.entryPrice;
      t.isBreakeven = true;
      count++;
    });
    saveActiveTrades(activeTrades);
    return count;
  },

  getShadowAudit: async () => {
    const shadowTrades = loadShadowTrades();
    const shadowHistory = loadShadowHistory();
    const todayStr = getLocalDateStr();
    const shadowToday = shadowHistory.filter(s => (s.time || '').startsWith(todayStr));

    const savedLosses = shadowToday.filter(s => s.outcome === 'SAVED_LOSS');
    const missedWins = shadowToday.filter(s => s.outcome === 'MISSED_WIN');
    const totalSavedUSD = savedLosses.reduce((acc, s) => acc + (s.savedUSD || 0), 0);
    const totalMissedUSD = missedWins.reduce((acc, s) => acc + (s.missedUSD || 0), 0);
    const netAdvantage = totalSavedUSD - totalMissedUSD;

    const lines = [
      `🛡️ <b>[MYTRADA COUNTERFACTUAL FILTER AUDIT]</b>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `📊 <b>Today's Blocked Setups:</b> <code>${shadowToday.length + shadowTrades.length} Total</code>`,
      `🛡️ <b>Losses Prevented:</b> <code>${savedLosses.length} Trades (+$${totalSavedUSD.toFixed(2)} USD Saved)</code>`,
      `⚠️ <b>Missed Wins:</b> <code>${missedWins.length} Trades (-$${totalMissedUSD.toFixed(2)} USD Missed)</code>`,
      `📈 <b>Net Guard Advantage:</b> <code>${netAdvantage >= 0 ? '+' : ''}$${netAdvantage.toFixed(2)} USD Preserved</code>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`
    ];

    if (shadowTrades.length === 0) {
      lines.push(`🔍 <b>Active Shadow Tracking:</b> <i>No blocked setups currently in flight.</i>`);
    } else {
      lines.push(`🔍 <b>ACTIVE SHADOW TRADES IN FLIGHT (${shadowTrades.length}):</b>`);
      shadowTrades.forEach(st => {
        lines.push(`• <b>${st.symbol}</b> (${st.direction}): Entry ${st.entryPrice.toFixed(2)} | SL ${st.stopLoss.toFixed(2)} | TP ${st.takeProfit.toFixed(2)}`);
        lines.push(`  🛑 <i>Filter: ${st.blockedReason}</i>`);
      });
    }

    return lines.join('\n');
  },

  getHealth: async () => {
    return formatHealthTelegramHTML();
  },

  quarantinePair: (symbol, reason) => {
    return manualSetQuarantine(symbol, true, reason);
  },

  unquarantinePair: (symbol) => {
    return manualSetQuarantine(symbol, false);
  }
};

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
  const localNow = getLocalTime(now);
  const localHour = localNow.getUTCHours();
  const localMinute = localNow.getUTCMinutes();

  // Only fire the midnight report within the 00:00–00:04 local midnight window (12:00 AM - 12:04 AM)
  if (localHour !== 0 || localMinute > 4) return;

  // Calculate yesterday's date string in trader local timezone
  const yesterday = new Date(localNow.getTime() - 24 * 60 * 60 * 1000);
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
  const localNow = getLocalTime(now);
  // Check if today is Sunday (day 0) at 12:00 AM+ local time
  if (localNow.getUTCDay() === 0) {
    const weekYear = `${localNow.getUTCFullYear()}-W${Math.ceil((localNow.getUTCDate() + 6) / 7)}`;
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
  let riskAmount = customRiskUSD !== null ? customRiskUSD : compRisk.riskUSD;
  if (dynamicState && dynamicState.customRiskPercent && dynamicState.customRiskPercent > 0) {
    riskAmount = compRisk.liveBalance * (dynamicState.customRiskPercent / 100);
  }
  const slDistance = Math.abs(entry - sl);
  if (slDistance <= 0) return 0.20;

  const minLots = {
    'BOOM300N': 0.50, 'CRASH300N': 0.50,
    'BOOM200': 0.20,
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
      const maxHigh = Math.max(...postEntryCandles.map(c => c.high), currentLivePrice);
      const minLow  = Math.min(...postEntryCandles.map(c => c.low), currentLivePrice);
      hitTP = isBullish ? maxHigh >= trade.takeProfit : minLow <= trade.takeProfit;
      hitSL = isBullish ? minLow <= trade.stopLoss : maxHigh >= trade.stopLoss;
    } else {
      // If we are still in the very first candle right after entry, only check current live price
      hitTP = isBullish ? currentLivePrice >= trade.takeProfit : currentLivePrice <= trade.takeProfit;
      hitSL = isBullish ? currentLivePrice <= trade.stopLoss : currentLivePrice >= trade.stopLoss;
    }

    if (trade.isIncubation) {
      if (hitTP) {
        recordIncubationOutcome({
          setupId: trade.setupId,
          symbol: trade.symbol,
          type: trade.type,
          entryPrice: trade.entryPrice,
          exitPrice: trade.takeProfit,
          outcome: 'WIN',
          rMultiple: 1.3,
          pnlUSD: compRisk.rewardUSD
        });
        recordGodEyesOutcome({
          setupId: trade.setupId,
          symbol: trade.symbol,
          type: trade.type,
          entryPrice: trade.entryPrice,
          exitPrice: trade.takeProfit,
          outcome: 'WIN',
          rMultiple: 1.3
        });

        await updatePairHealthOnPaperClose(symbol, 'WIN');
        recordSymbolTradeOutcome(symbol, 'WIN', true);

        const tpAlert = [
          `🔬 🟢 <b>[MYTRADA INCUBATION OUTCOME — TP HIT (+1.3R)]</b>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].name : symbol})`,
          `<b>Direction:</b> ${isBullish ? '🟢 BUY' : '🔴 SELL'}`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `🎯 <b>Outcome:</b> <code>+1.3R (+$${compRisk.rewardUSD.toFixed(2)} USD Paper Return)</code>`,
          `🎯 <b>Entry:</b> <code>${trade.entryPrice.toFixed(2)}</code> ➔ 🏆 <b>TP:</b> <code>${trade.takeProfit.toFixed(2)}</code>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `🧪 <i>Paper Incubation trade closed. Real account equity ($${getCurrentAccountBalance().toFixed(2)}) unaffected.</i>`
        ].join('\n');

        await sendTelegramMessage(tpAlert);

        updatedTrades = updatedTrades.filter(t => t.setupId !== trade.setupId);
        changed = true;
        continue;
      }

      if (hitSL) {
        recordIncubationOutcome({
          setupId: trade.setupId,
          symbol: trade.symbol,
          type: trade.type,
          entryPrice: trade.entryPrice,
          exitPrice: trade.stopLoss,
          outcome: 'LOSS',
          rMultiple: -1.0,
          pnlUSD: -compRisk.riskUSD
        });
        recordGodEyesOutcome({
          setupId: trade.setupId,
          symbol: trade.symbol,
          type: trade.type,
          entryPrice: trade.entryPrice,
          exitPrice: trade.stopLoss,
          outcome: 'LOSS',
          rMultiple: -1.0
        });

        await updatePairHealthOnPaperClose(symbol, 'LOSS');
        recordSymbolTradeOutcome(symbol, 'LOSS', true);

        const slAlert = [
          `🔬 🔴 <b>[MYTRADA INCUBATION OUTCOME — SL HIT (-1.0R)]</b>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].name : symbol})`,
          `<b>Direction:</b> ${isBullish ? '🟢 BUY' : '🔴 SELL'}`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `💸 <b>Outcome:</b> <code>-1.0R (-$${compRisk.riskUSD.toFixed(2)} USD Paper Loss)</code>`,
          `🔥 <b>Entry:</b> <code>${trade.entryPrice.toFixed(2)}</code> ➔ 🛡️ <b>SL:</b> <code>${trade.stopLoss.toFixed(2)}</code>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `🧪 <i>Paper Incubation trade closed. Real account equity ($${getCurrentAccountBalance().toFixed(2)}) unaffected.</i>`
        ].join('\n');

        await sendTelegramMessage(slAlert);

        updatedTrades = updatedTrades.filter(t => t.setupId !== trade.setupId);
        changed = true;
        continue;
      }

      continue;
    }

    if (hitTP) {
      const pnlUsd = trade.rewardUSD || compRisk.rewardUSD;

      recordSymbolTradeOutcome(symbol, 'WIN');
      await updatePairHealthOnLiveClose(symbol, 'WIN');
      recordClose(trade.setupId, 'WIN', trade.takeProfit, pnlUsd, 1.3, trade.aiVisionVerdict);
      const updatedBalance = getCurrentAccountBalance();

      const tpAlert = [
        `🏆 🟢 <b>[MYTRADA TP HIT (+1.3R)]</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].name : symbol})`,
        `<b>Direction:</b> ${isBullish ? '🟢 BUY' : '🔴 SELL'}`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `💰 <b>Profit:</b> <code>+$${pnlUsd.toFixed(2)} USD (+1.3R)</code>`,
        `💵 <b>New Balance:</b> <code>$${updatedBalance.toFixed(2)} USD</code>`,
        `🎯 <b>Entry:</b> <code>${trade.entryPrice.toFixed(2)}</code> ➔ 🏆 <b>TP:</b> <code>${trade.takeProfit.toFixed(2)}</code>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `🛡️ <i>Post-win cooldown active (${config.CIRCUIT_BREAKER.POST_WIN_PAUSE_MINS || 35}m).</i>`
      ].filter(Boolean).join('\n');

      await sendTelegramMessage(tpAlert);

      updatedTrades = updatedTrades.filter(t => t.setupId !== trade.setupId);
      changed = true;
      continue;
    }

    if (hitSL) {
      const isBreakevenExit = trade.isBreakeven || Math.abs(trade.stopLoss - trade.entryPrice) < 0.001;
      const riskUSD = trade.riskUSD || compRisk.riskUSD;
      const pauseMins = config.CIRCUIT_BREAKER.TIER_1_PAUSE_MINS || 45;

      if (isBreakevenExit) {
        // Breakeven Exit: Zero Loss / 0.0R — Capital preserved
        recordClose(trade.setupId, 'BREAKEVEN', trade.stopLoss, 0.0, 0.0, trade.aiVisionVerdict);
        const updatedBalance = getCurrentAccountBalance();

        const beAlert = [
          `🛡️ 🟡 <b>[MYTRADA BREAKEVEN EXIT ($0 RISK)]</b>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].name : symbol})`,
          `<b>Direction:</b> ${isBullish ? '🟢 BUY' : '🔴 SELL'}`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `💸 <b>Outcome:</b> <code>$0.00 USD (0.0R Breakeven)</code>`,
          `💵 <b>Account Balance:</b> <code>$${updatedBalance.toFixed(2)} USD</code>`,
          `🎯 <b>Entry:</b> <code>${trade.entryPrice.toFixed(2)}</code> ➔ 🛡️ <b>Exit:</b> <code>${trade.stopLoss.toFixed(2)}</code>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `👌 <i>Capital fully protected. Position closed at breakeven without loss.</i>`
        ].filter(Boolean).join('\n');

        await sendTelegramMessage(beAlert);
      } else {
        recordSymbolTradeOutcome(symbol, 'LOSS');
        await updatePairHealthOnLiveClose(symbol, 'LOSS');
        recordClose(trade.setupId, 'LOSS', trade.stopLoss, -riskUSD, -1.0, trade.aiVisionVerdict);
        const updatedBalance = getCurrentAccountBalance();

        const slAlert = [
          `🔴 🛡️ <b>[MYTRADA STOP LOSS HIT (-1.0R)]</b>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].name : symbol})`,
          `<b>Direction:</b> ${isBullish ? '🟢 BUY' : '🔴 SELL'}`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `💸 <b>Loss:</b> <code>-$${riskUSD.toFixed(2)} USD (-1.0R)</code>`,
          `💵 <b>New Balance:</b> <code>$${updatedBalance.toFixed(2)} USD</code>`,
          `🔥 <b>Entry:</b> <code>${trade.entryPrice.toFixed(2)}</code> ➔ 🛡️ <b>SL:</b> <code>${trade.stopLoss.toFixed(2)}</code>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `🛡️ <i>Defensive cooldown active (${pauseMins}m).</i>`
        ].filter(Boolean).join('\n');

        await sendTelegramMessage(slAlert);
      }

      updatedTrades = updatedTrades.filter(t => t.setupId !== trade.setupId);
      changed = true;
    }
  }

  if (changed) {
    saveActiveTrades(updatedTrades);
    await checkDailyTargetLock();
    await checkDailyMaxLossLock();
  }
}

// ── SHADOW / COUNTERFACTUAL TRADE MONITOR ──
async function checkShadowTradesForSymbol(symbol, ltfCandles) {
  if (!ltfCandles || ltfCandles.length === 0) return;
  const shadowTrades = loadShadowTrades();
  const tradesForSymbol = shadowTrades.filter(t => t.symbol === symbol);
  if (tradesForSymbol.length === 0) return;

  const currentLivePrice = ltfCandles[ltfCandles.length - 1].close;
  let updatedShadows = [...shadowTrades];
  let changed = false;

  for (const trade of tradesForSymbol) {
    const entryCandleEpoch = trade.candleEpoch || (trade.triggeredTime ? trade.triggeredTime - 300000 : 0);
    const postEntryCandles = ltfCandles.filter(c => (c.time > entryCandleEpoch));

    let hitTP = false;
    let hitSL = false;
    const isBullish = trade.type === 'bullish';

    if (postEntryCandles.length > 0) {
      const maxHigh = Math.max(...postEntryCandles.map(c => c.high), currentLivePrice);
      const minLow  = Math.min(...postEntryCandles.map(c => c.low), currentLivePrice);
      hitTP = isBullish ? maxHigh >= trade.takeProfit : minLow <= trade.takeProfit;
      hitSL = isBullish ? minLow <= trade.stopLoss : maxHigh >= trade.stopLoss;
    } else {
      hitTP = isBullish ? currentLivePrice >= trade.takeProfit : currentLivePrice <= trade.takeProfit;
      hitSL = isBullish ? currentLivePrice <= trade.stopLoss : currentLivePrice >= trade.stopLoss;
    }

    if (hitSL) {
      // 🛡️ Filter SUCCESS: Saved the user from a loss!
      recordShadowOutcome({
        setupId: trade.setupId,
        symbol: trade.symbol,
        direction: trade.direction,
        entryPrice: trade.entryPrice,
        stopLoss: trade.stopLoss,
        takeProfit: trade.takeProfit,
        outcome: 'SAVED_LOSS',
        blockedReason: trade.blockedReason,
        savedUSD: trade.riskUSD || 65.0
      });

      // Shadow outcome logged silently without sending Telegram message
      console.log(`\n🛡️ [SHADOW AUDIT] ${trade.symbol} blocked setup hit Stop Loss. Filter saved $${(trade.riskUSD || 65.0).toFixed(2)}!\n`);

      updatedShadows = updatedShadows.filter(t => t.setupId !== trade.setupId);
      changed = true;
      continue;
    }

    if (hitTP) {
      // ⚠️ Filter MISSED WIN: Setup hit TP despite filter
      recordShadowOutcome({
        setupId: trade.setupId,
        symbol: trade.symbol,
        direction: trade.direction,
        entryPrice: trade.entryPrice,
        stopLoss: trade.stopLoss,
        takeProfit: trade.takeProfit,
        outcome: 'MISSED_WIN',
        blockedReason: trade.blockedReason,
        missedUSD: trade.rewardUSD || 84.50
      });

      // Shadow outcome logged silently without sending Telegram message
      console.log(`\n⚠️ [SHADOW AUDIT] ${trade.symbol} blocked setup hit Take Profit. Missed: +$${(trade.rewardUSD || 84.50).toFixed(2)}.\n`);

      updatedShadows = updatedShadows.filter(t => t.setupId !== trade.setupId);
      changed = true;
      continue;
    }

    // Auto-expire stale shadow trades after 6 hours
    if (trade.triggeredTime && (Date.now() - trade.triggeredTime) > 6 * 60 * 60 * 1000) {
      updatedShadows = updatedShadows.filter(t => t.setupId !== trade.setupId);
      changed = true;
    }
  }

  if (changed) {
    saveShadowTrades(updatedShadows);
  }
}

// ── DEDICATED HIGH-SPEED POSITION MONITOR (Every 3 seconds) ──
let isFastMonitoring = false;

async function monitorActivePositionsFast() {
  if (isFastMonitoring) return;
  isFastMonitoring = true;
  try {
    const activeTrades = loadActiveTrades();
    const shadowTrades = loadShadowTrades();

    const symbolsToMonitor = Array.from(new Set([
      ...activeTrades.map(t => t.symbol),
      ...shadowTrades.map(t => t.symbol)
    ]));

    if (symbolsToMonitor.length === 0) {
      isFastMonitoring = false;
      return;
    }

    for (const sym of symbolsToMonitor) {
      try {
        const ltf = await getCandles(sym, config.DEFAULT_LTF || '5m', 15, true);
        if (ltf && ltf.length > 0) {
          await checkActiveTradesForSymbol(sym, ltf);
          await checkShadowTradesForSymbol(sym, ltf);
        }
      } catch (err) {
        // Silent catch to prevent console spam in high frequency loop
      }
    }
  } catch (e) {
    console.warn("[fastMonitor] Warning:", e.message);
  } finally {
    isFastMonitoring = false;
  }
}

// ── STRATEGY 5B SIGNAL DETECTION ENGINE ──
function detectStrategy5BSetup(ltfCandles, htf1hCandles, htf4hCandles, dailyCandles, mode, minSpikesRequired, symbol) {
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

  const confirmCount = (symbol && config.SYMBOLS[symbol] && config.SYMBOLS[symbol].confirm_candles) || config.CONFIRMATION_CANDLES || 2;
  const minSpikes = minSpikesRequired || config.MIN_SPIKES || 2;

  // ── CASE 1: SELL (BOOM) ──
  if (mode === 'BOOM') {
    if (htf1hTrend !== 'bearish') return null;
    if (htf4hTrend !== 'N/A' && htf4hTrend !== 'bearish') return null;
    if (config.REQUIRE_DAILY_CONFLUENCE && dailyTrend !== 'N/A' && dailyTrend !== 'bearish') return null;

    // 1. Multi-Candle Confirmation: Last confirmCount candles must all be closed RED (close < open)
    let hasConfirm = true;
    const confirmCandles = [];
    for (let cIdx = 0; cIdx < confirmCount; cIdx++) {
      const c = ltfCandles[ltfCandles.length - 1 - cIdx];
      if (!c || c.close >= c.open) { hasConfirm = false; break; }
      confirmCandles.push(c);
    }
    if (!hasConfirm || confirmCandles.length < confirmCount) return null;

    const c0 = confirmCandles[0];
    const c0Range = c0.high - c0.low;
    const c0Body = Math.abs(c0.close - c0.open);
    const bodyRatio = c0Range > 0 ? (c0Body / c0Range) : 0;
    if (bodyRatio < 0.40) return null;

    const atr = calculateATR(ltfCandles, 14);
    if (!atr || atr === 0) return null;

    // 2. Dynamic Spike Exhaustion: 1 Monster Spike (>=1.5x ATR) OR 2-3 Spike Cluster (>=1.2x ATR)
    const s0 = ltfCandles[ltfCandles.length - 1 - confirmCount];
    if (!s0 || s0.close <= s0.open) return null;
    const spikeCandles = [s0];
    const s0Range = s0.high - s0.low;

    for (let s = 1; s <= 2; s++) {
      const c = ltfCandles[ltfCandles.length - 1 - confirmCount - s];
      if (c && c.close > c.open) {
        spikeCandles.push(c);
      } else {
        break;
      }
    }

    const spikePeak = Math.max(...confirmCandles.map(c => c.high), ...spikeCandles.map(c => c.high));
    const spikeClusterRange = Math.max(...spikeCandles.map(c => c.high)) - Math.min(...spikeCandles.map(c => c.low));

    const isSingleMonster = spikeCandles.length === 1 && s0Range >= (atr * 1.50);
    const isMultiCluster = spikeCandles.length >= 2 && spikeClusterRange >= (atr * (config.MIN_SPIKE_CLUSTER_ATR_RATIO || 1.20));

    if (!isSingleMonster && !isMultiCluster) return null;

    const spikeCountLabel = isSingleMonster ? '1 Monster Spike' : `${spikeCandles.length} Spikes`;

    // 👑 5M 50 EMA Value Zone Guard: reject if price has not pulled back near the value zone
    const ltfCloses = ltfCandles.map(c => c.close);
    const ltfEMA = calculateEMA(ltfCloses, 50);
    const lastLtfEma = ltfEMA && ltfEMA.length > 0 ? ltfEMA[ltfEMA.length - 1] : null;
    const maxAtrDist = (config.VALUE_ZONE_MAX_ATR_DIST || 2.5) * atr;
    if (lastLtfEma && (lastLtfEma - spikePeak) > maxAtrDist) return null;

    // 👑 Cumulative Displacement Confirmation: Combined recovery bodies must be >= 20% of preceding spike
    const lastBoomSpike = spikeCandles[0];
    const lastSpikeRange = Math.abs(lastBoomSpike.close - lastBoomSpike.open);
    const totalRecoveryBody = confirmCandles.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0);
    const minDisplacementRatio = config.MIN_CANDLE0_DISPLACEMENT_RATIO || 0.20;
    if (totalRecoveryBody < (lastSpikeRange * minDisplacementRatio)) return null;

    const valueZoneTouched = `Price Action Displacement (${confirmCount}x 5M Recovery >=20%)`;

    const entry = c0.close;
    const sl = spikePeak + (atr * 1.5);
    const slDist = sl - entry;
    if (slDist <= 0) return null;

    const tp = entry - (slDist * (config.REWARD_RATIO || 1.3));
    const candleEpoch = c0.epoch || c0.time;

    let isBlocked = false;
    let blockedReason = null;

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
      candleEpoch,
      confirmCount,
      spikeCountLabel,
      isBlocked,
      blockedReason
    };
  }

  // ── CASE 2: BUY (CRASH) ──
  if (mode === 'CRASH') {
    if (htf1hTrend !== 'bullish') return null;
    if (htf4hTrend !== 'N/A' && htf4hTrend !== 'bullish') return null;
    if (config.REQUIRE_DAILY_CONFLUENCE && dailyTrend !== 'N/A' && dailyTrend !== 'bullish') return null;

    // 1. Multi-Candle Confirmation: Last confirmCount candles must all be closed GREEN (close > open)
    let hasConfirm = true;
    const confirmCandles = [];
    for (let cIdx = 0; cIdx < confirmCount; cIdx++) {
      const c = ltfCandles[ltfCandles.length - 1 - cIdx];
      if (!c || c.close <= c.open) { hasConfirm = false; break; }
      confirmCandles.push(c);
    }
    if (!hasConfirm || confirmCandles.length < confirmCount) return null;

    const c0 = confirmCandles[0];
    const c0Range = c0.high - c0.low;
    const c0Body = Math.abs(c0.close - c0.open);
    const bodyRatio = c0Range > 0 ? (c0Body / c0Range) : 0;
    if (bodyRatio < 0.40) return null;

    const atr = calculateATR(ltfCandles, 14);
    if (!atr || atr === 0) return null;

    // 2. Dynamic Crash Exhaustion: 1 Monster Crash (>=1.5x ATR) OR 2-3 Crash Cluster (>=1.2x ATR)
    const s0 = ltfCandles[ltfCandles.length - 1 - confirmCount];
    if (!s0 || s0.close >= s0.open) return null;
    const crashCandles = [s0];
    const s0Range = s0.high - s0.low;

    for (let s = 1; s <= 2; s++) {
      const c = ltfCandles[ltfCandles.length - 1 - confirmCount - s];
      if (c && c.close < c.open) {
        crashCandles.push(c);
      } else {
        break;
      }
    }

    const crashTrough = Math.min(...confirmCandles.map(c => c.low), ...crashCandles.map(c => c.low));
    const crashClusterRange = Math.max(...crashCandles.map(c => c.high)) - Math.min(...crashCandles.map(c => c.low));

    const isSingleMonster = crashCandles.length === 1 && s0Range >= (atr * 1.50);
    const isMultiCluster = crashCandles.length >= 2 && crashClusterRange >= (atr * (config.MIN_SPIKE_CLUSTER_ATR_RATIO || 1.20));

    if (!isSingleMonster && !isMultiCluster) return null;

    const spikeCountLabel = isSingleMonster ? '1 Monster Spike' : `${crashCandles.length} Spikes`;

    // 👑 5M 50 EMA Value Zone Guard: reject if price has not pulled back near the value zone (overbought ceiling)
    const ltfCloses = ltfCandles.map(c => c.close);
    const ltfEMA = calculateEMA(ltfCloses, 50);
    const lastLtfEma = ltfEMA && ltfEMA.length > 0 ? ltfEMA[ltfEMA.length - 1] : null;
    const maxAtrDist = (config.VALUE_ZONE_MAX_ATR_DIST || 2.5) * atr;
    if (lastLtfEma && (crashTrough - lastLtfEma) > maxAtrDist) return null;

    // 👑 Cumulative Displacement Confirmation: Combined recovery bodies must be >= 20% of preceding crash
    const lastCrashSpike = crashCandles[0];
    const lastSpikeRange = Math.abs(lastCrashSpike.close - lastCrashSpike.open);
    const totalRecoveryBody = confirmCandles.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0);
    const minDisplacementRatio = config.MIN_CANDLE0_DISPLACEMENT_RATIO || 0.20;
    if (totalRecoveryBody < (lastSpikeRange * minDisplacementRatio)) return null;

    const valueZoneTouched = `Price Action Displacement (${confirmCount}x 5M Recovery >=20%)`;

    const entry = c0.close;
    const sl = crashTrough - (atr * 1.5);
    const slDist = entry - sl;
    if (slDist <= 0) return null;

    const tp = entry + (slDist * (config.REWARD_RATIO || 1.3));
    const candleEpoch = c0.epoch || c0.time;

    let isBlocked = false;
    let blockedReason = null;

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
      candleEpoch,
      confirmCount,
      spikeCountLabel,
      isBlocked,
      blockedReason
    };
  }

  return null;
}

// ── STRATEGY 6 PRO: GODEYES INSTITUTIONAL SMC MEMORY BRAIN ──
function detectStrategy6ProSetup(ltfCandles, htf1hCandles, htf4hCandles, dailyCandles, mode, minSpikesRequired, symbol) {
  // 1. Evaluate baseline spike exhaustion & 5M confirmation trigger (identical to 5B so it's a true A/B twin)
  const baseSetup = detectStrategy5BSetup(ltfCandles, htf1hCandles, htf4hCandles, dailyCandles, mode, minSpikesRequired, symbol);
  if (!baseSetup) return null;

  // 2. Evaluate GodEyes 15% / 85% Macro Exhaustion Guard (using multi-day anchors)
  const exhaustion = evaluateMacroExhaustion(symbol, baseSetup.entry, baseSetup.direction, htf1hCandles);

  const isBlocked = exhaustion.isExhausted;
  const blockedReason = exhaustion.reason;

  return {
    ...baseSetup,
    strategy: 'Strategy 6 Pro',
    valuationLabel: `Macro Range: ${exhaustion.rangePct.toFixed(1)}% (SMC Dealing Zone)`,
    liquidityLabel: `SMC Anchor (PDH/PDL Range)`,
    isBlocked,
    blockedReason
  };
}

// ── MAIN MONITOR CYCLE ──
async function monitorMarket() {
  const now = new Date();
  const todayStr = getLocalDateStr(now);

  // Refresh dynamic state on date rollover
  if (!dynamicState || dynamicState.date !== todayStr) {
    // 👑 1. Send yesterday's midnight report FIRST (if not already delivered)
    const localNow = getLocalTime(now);
    const yesterday = new Date(localNow.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayDateStr = yesterday.toISOString().split('T')[0];
    const lastReported = getLastReportedDate();

    if (lastReported !== yesterdayDateStr) {
      console.log(`\n📅 [12:00 AM MIDNIGHT REPORT] Compiling Daily Performance Report for ${yesterdayDateStr}...`);
      const report = generateDailyReport(yesterdayDateStr);
      const reportHtml = formatReportTelegramHTML(report);
      await sendTelegramMessage(reportHtml);
      saveLastReportedDate(yesterdayDateStr);
      console.log(`✅ [12:00 AM MIDNIGHT REPORT] Daily Report for ${yesterdayDateStr} dispatched to Telegram successfully!\n`);
      // Brief pause to guarantee Telegram chat ordering (Report first, Banner second)
      await new Promise(resolve => setTimeout(resolve, 2000));
      // 👑 Automated midnight GitHub archive sync
      await runMidnightGitSync(yesterdayDateStr);
    }

    // 👑 2. Load dynamic state for the new day
    dynamicState = loadDynamicState();
    const compRisk = getWeeklyCompoundedRisk();

    // 👑 3. Send NEW TRADING DAY banner SECOND
    const newDayTargetLabel = (dynamicState.dailyTargetUSD && dynamicState.dailyTargetUSD > 0)
      ? `$${dynamicState.dailyTargetUSD.toFixed(2)} USD`
      : 'Not Set — Use /target to set today\'s goal';
    await sendTelegramMessage([
      `🌅 <b>[NEW TRADING DAY ACTIVATED]</b>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `💵 <b>Starting Balance:</b> <code>$${compRisk.liveBalance.toFixed(2)} USD</code>`,
      `🎯 <b>Daily Profit Target:</b> <code>${newDayTargetLabel}</code>`,
      `🚀 <b>Status:</b> <b>ONLINE & SCANNING ${Object.keys(config.SYMBOLS).length} PAIRS</b>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`
    ].join('\n'));
  }

  // 1. Automated Check for 12:00 AM Midnight Daily Performance Report
  await checkAndSendDailyMidnightReport();

  // 2. Automated Check for Sunday Midnight Weekly Performance Report
  await checkAndSendWeeklyReport();

  // 3. Check for Daily Profit Target & Max Loss Shield Reach
  await checkDailyTargetLock();
  await checkDailyMaxLossLock();

  const nowMs = Date.now();

  // Check if bot is in Standby mode (activeStrategy === 'NONE')
  if (dynamicState.activeStrategy === 'NONE') {
    console.log(`\n⏸️ [MYTRADA STANDBY] Bot is online & connected to Telegram. Awaiting /strategy command (/strategy 6pro, /strategy 5b, /strategy both)...`);
    for (const sym of Object.keys(config.SYMBOLS)) {
      const ltf = await getCandles(sym, config.DEFAULT_LTF || '5m', 20, true).catch(() => null);
      if (ltf) {
        await checkActiveTradesForSymbol(sym, ltf);
        await checkShadowTradesForSymbol(sym, ltf);
      }
    }
    return;
  }

  // Check if system is in global manual pause mode
  if (dynamicState.isManuallyPaused) {
    console.log(`\n⏸️ [MYTRADA PAUSED] Bot is manually paused via Telegram (/resume to continue). Monitoring active positions...`);
    for (const sym of Object.keys(config.SYMBOLS)) {
      const ltf = await getCandles(sym, config.DEFAULT_LTF || '5m', 20, true).catch(() => null);
      if (ltf) {
        await checkActiveTradesForSymbol(sym, ltf);
        await checkShadowTradesForSymbol(sym, ltf);
      }
    }
    return;
  }

  // Check if daily profit target is locked for the rest of the day
  const hasPaperEngineActive = (dynamicState.activeStrategy === 'BOTH' && !dynamicState.is6proPaused) || (dynamicState.activeStrategy === 'STRATEGY_6_PRO' && dynamicState.mode6pro === 'PAPER');

  if (dynamicState.dailyTargetLocked && !hasPaperEngineActive) {
    console.log(`\n🎯 [DAILY TARGET LOCKED] Profit target reached! Paused until midnight. Monitoring active positions...`);
    for (const sym of Object.keys(config.SYMBOLS)) {
      const ltf = await getCandles(sym, config.DEFAULT_LTF || '5m', 20, true).catch(() => null);
      if (ltf) {
        await checkActiveTradesForSymbol(sym, ltf);
        await checkShadowTradesForSymbol(sym, ltf);
      }
    }
    return;
  }

  // Check if portfolio is in global consecutive loss cooldown
  if (dynamicState.portfolioPauseUntil && nowMs < dynamicState.portfolioPauseUntil) {
    const remMins = Math.ceil((dynamicState.portfolioPauseUntil - nowMs) / 60000);
    console.log(`\n⚠️ [PORTFOLIO COOLDOWN] 3 consecutive losses hit across bot. Paused for ${remMins}m more. Monitoring active positions...`);
    for (const sym of Object.keys(config.SYMBOLS)) {
      const ltf = await getCandles(sym, config.DEFAULT_LTF || '5m', 20, true).catch(() => null);
      if (ltf) {
        await checkActiveTradesForSymbol(sym, ltf);
        await checkShadowTradesForSymbol(sym, ltf);
      }
    }
    return;
  }

  const isBoth = dynamicState.activeStrategy === 'BOTH';
  const scanStratLabel = isBoth
    ? 'Dual Engine (5B + 6 Pro)'
    : (dynamicState.activeStrategy === 'STRATEGY_6_PRO' ? 'Strategy 6 Pro' : 'Strategy 5B Enhanced');

  console.log(`\n${CYAN}[${now.toLocaleTimeString()}] Scanning ${Object.keys(config.SYMBOLS).length} Elite Boom/Crash Pairs for ${scanStratLabel}...${RESET}`);
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
        const ltf = await getCandles(symbol, config.DEFAULT_LTF || '5m', 20, true).catch(() => null);
        if (ltf && ltf.length > 0) {
          await checkActiveTradesForSymbol(symbol, ltf);
          await checkShadowTradesForSymbol(symbol, ltf);
        }
        continue;
      }

      // Use cached HTF candles (TTL: 1D = 1hr, 4H = 15m, 1H = 5m) to prevent WS socket overload
      const dailyCandles = config.REQUIRE_DAILY_CONFLUENCE
        ? await getCachedHtfCandles(symbol, config.MACRO_DAILY || '1d', 60, 60 * 60 * 1000)
        : null;
      const htf4hCandles = await getCachedHtfCandles(symbol, config.MACRO_HTF || '4h', 100, 15 * 60 * 1000);
      await new Promise(r => setTimeout(r, 150));
      const htf1hCandles = await getCachedHtfCandles(symbol, config.INTERMEDIATE_HTF || '1h', 100, 5 * 60 * 1000);
      await new Promise(r => setTimeout(r, 150));
      const ltfCandles   = await getCandles(symbol, config.DEFAULT_LTF || '5m', 150, true);
      if (!htf1hCandles || !ltfCandles) continue;

      const latestPrice = ltfCandles[ltfCandles.length - 1].close;

      const symHealth = getPairHealth(symbol);
      const isQuarantined = symHealth.isQuarantined === true;

      // Build active strategies for this scan
      const strategiesToRun = [];
      if (isBoth) {
        const is5bLocked = dynamicState.dailyTargetLocked || dynamicState.dailyLossLocked;
        if (!dynamicState.is5bPaused) {
          const is5bPaper = is5bLocked || isQuarantined || (dynamicState.mode5b || 'LIVE') === 'PAPER';
          let displayName = 'Strategy 5B Enhanced';
          if (is5bLocked) displayName = 'Strategy 5B (Target-Locked Paper)';
          else if (isQuarantined) displayName = 'Strategy 5B (Quarantined Paper)';

          strategiesToRun.push({
            id: '5B',
            name: 'STRATEGY_5B',
            displayName,
            fn: detectStrategy5BSetup,
            isPaper: is5bPaper
          });
        }
        if (!dynamicState.is6proPaused) {
          strategiesToRun.push({
            id: '6PRO',
            name: 'STRATEGY_6_PRO',
            displayName: 'Strategy 6 Pro',
            fn: detectStrategy6ProSetup,
            isPaper: (dynamicState.mode6pro || 'PAPER') === 'PAPER'
          });
        }
      } else if (dynamicState.activeStrategy === 'STRATEGY_6_PRO') {
        if (!dynamicState.is6proPaused) {
          strategiesToRun.push({
            id: '6PRO',
            name: 'STRATEGY_6_PRO',
            displayName: 'Strategy 6 Pro',
            fn: detectStrategy6ProSetup,
            isPaper: (dynamicState.executionMode || 'PAPER') === 'PAPER'
          });
        }
      } else if (dynamicState.activeStrategy === 'STRATEGY_5B') {
        const is5bLocked = dynamicState.dailyTargetLocked || dynamicState.dailyLossLocked;
        if (!dynamicState.is5bPaused) {
          const is5bPaper = is5bLocked || isQuarantined || (dynamicState.executionMode || 'LIVE') === 'PAPER';
          let displayName = 'Strategy 5B Enhanced';
          if (is5bLocked) displayName = 'Strategy 5B (Target-Locked Paper)';
          else if (isQuarantined) displayName = 'Strategy 5B (Quarantined Paper)';

          strategiesToRun.push({
            id: '5B',
            name: 'STRATEGY_5B',
            displayName,
            fn: detectStrategy5BSetup,
            isPaper: is5bPaper
          });
        }
      }

      // 👑 Whichever strategy is LIVE runs FIRST and dispatches ahead of paper/test
      strategiesToRun.sort((a, b) => (a.isPaper === b.isPaper ? 0 : a.isPaper ? 1 : -1));

      // 👑 Execution window: evaluate ONLY the most recently closed 5M bar (offset=1)
      const LOOKBACK_BARS = 1;
      let signalFiredThisScan = false;

      for (const strat of strategiesToRun) {
        for (let offset = 1; offset <= LOOKBACK_BARS; offset++) {
          if (ltfCandles.length < offset + 25) break;

          const completedSlice = ltfCandles.slice(0, ltfCandles.length - (offset - 1) - 1);
          const setup = strat.fn(completedSlice, htf1hCandles, htf4hCandles, dailyCandles, mode, minSpikes, symbol);
          if (!setup) continue;

          const setupId = `${symbol}_${setup.direction}_${strat.id}_${setup.candleEpoch}`;
          const existingActive = loadActiveTrades();
          const symbolAlreadyActive = existingActive.some(t => t.symbol === symbol && t.strategy === strat.displayName);

          // 👑 COUNTERFACTUAL SHADOW FILTER AUDIT
          if (setup.isBlocked) {
            const shadowTrades = loadShadowTrades();
            const alreadyShadowed = shadowTrades.some(t => t.setupId === setupId);
            if (!alreadyShadowed && !alertedSetups.has(setupId)) {
              saveAlertedSetup(setupId);
              const compRisk = getWeeklyCompoundedRisk();
              shadowTrades.push({
                setupId,
                symbol,
                type: setup.type,
                direction: setup.direction,
                entryPrice: setup.entry,
                stopLoss: setup.sl,
                takeProfit: setup.tp,
                riskUSD: compRisk.riskUSD,
                rewardUSD: compRisk.rewardUSD,
                candleEpoch: setup.candleEpoch,
                triggeredTime: Date.now(),
                blockedReason: setup.blockedReason,
                strategy: strat.displayName
              });
              saveShadowTrades(shadowTrades);
              console.log(`  [SHADOW AUDIT] ${symbol.padEnd(12)} | 🛑 Blocked by: ${setup.blockedReason} | Enrolled in shadow tracking`);
            }
            break;
          }

          if (alertedSetups.has(setupId) || symbolAlreadyActive) {
            if (alertedSetups.has(setupId)) {
              console.log(`  [${mode}] ${symbol.padEnd(12)} | ${latestPrice.toFixed(2)} | [${strat.displayName}] Active (already alerted)`);
            }
            break;
          }

          // 👑 Stale Signal Guard
          const isBullish = setup.direction === 'BUY';
          const slAlreadyHit = isBullish ? latestPrice <= setup.sl : latestPrice >= setup.sl;
          const tpAlreadyHit = isBullish ? latestPrice >= setup.tp : latestPrice <= setup.tp;
          const maxAllowedDrift = (setup.atr || 1.0) * 0.40;
          const priceDrift = Math.abs(latestPrice - setup.entry);

          if (slAlreadyHit || tpAlreadyHit || priceDrift > maxAllowedDrift) {
            console.log(`  [${mode}] ${symbol.padEnd(12)} | [${strat.displayName}] Discarding stale setup (live price ${latestPrice.toFixed(2)} already beyond entry ${setup.entry.toFixed(2)})`);
            saveAlertedSetup(setupId);
            break;
          }

          // Target / Loss Locks Check
          let isPaperMode = symConfig.monitorOnly || strat.isPaper;
          if (!isPaperMode && (dynamicState.dailyTargetLocked || dynamicState.dailyLossLocked || dynamicState.isManuallyPaused)) {
            console.log(`  [${mode}] ${symbol.padEnd(12)} | [${strat.displayName}] Setup ignored: Locked/Paused state.`);
            break;
          }

          // 🛡️ MAX CONCURRENT LIVE TRADES GUARD (3 Max Live Positions)
          const liveActiveTrades = existingActive.filter(t => !t.isIncubation);
          const maxLiveTrades = config.MAX_CONCURRENT_LIVE_TRADES || 3;
          let reroutedDueToLiveCap = false;
          if (!isPaperMode && liveActiveTrades.length >= maxLiveTrades) {
            console.log(`  [LIVE CAP] ${symbol.padEnd(12)} | [${strat.displayName}] Max ${maxLiveTrades} live trades active (${liveActiveTrades.map(t => t.symbol).join(', ')}). Rerouting setup to Paper Sandbox.`);
            isPaperMode = true;
            reroutedDueToLiveCap = true;
          }

          // ── NEW SIGNAL — FIRE ALERT ──
          saveAlertedSetup(setupId);
          signalFiredThisScan = true;

          if (isPaperMode) {
            // ── FORWARD TEST / PAPER SANDBOX ($0 REAL RISK) ──
            const dirEmoji = setup.direction === 'SELL' ? '🔴' : '🟢';
            const compRisk = getWeeklyCompoundedRisk();

            const alertLines = [
              `🔬 🟡 <b>[MYTRADA FORWARD TEST — ${strat.displayName.toUpperCase()}]</b>`,
              `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
              `<b>Asset:</b> <code>${symbol}</code> (${symConfig.name})`,
              `<b>Action:</b> ${dirEmoji} <b>${setup.direction} (Paper Forward Test)</b>`,
              `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
              `🎯 <b>Entry:</b> <code>${setup.entry.toFixed(2)}</code>`,
              `🛡️ <b>Stop Loss:</b> <code>${setup.sl.toFixed(2)}</code>`,
              `🏆 <b>Take Profit:</b> <code>${setup.tp.toFixed(2)}</code> (1:1.3 R:R Target)`,
              `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
              `🧪 <b>Execution Mode:</b> <code>Paper Sandbox ($0 Real Risk)</code>`,
              `💵 <b>Live Balance Protected:</b> <code>$${compRisk.liveBalance.toFixed(2)} USD</code>`
            ];

            if (reroutedDueToLiveCap) {
              alertLines.push(`🛡️ <i>Live capacity reached (${maxLiveTrades}/${maxLiveTrades} active). Setup rerouted to Paper Sandbox to eliminate floating risk.</i>`);
            }

            if (isQuarantined) {
              alertLines.push(
                `🛡️ <b>Quarantine Reason:</b> <code>${symHealth.quarantineReason}</code>`,
                `⏳ <b>Graduation Progress:</b> <code>${symHealth.consecutivePaperWins || 0} / 2 Paper Wins</code>`
              );
            }

            if (setup.valuationLabel) {
              alertLines.push(`🏛️ <b>Dealing Range:</b> <code>${setup.valuationLabel}</code>`);
            }
            if (setup.liquidityLabel) {
              alertLines.push(`💧 <b>Liquidity Purge:</b> <code>${setup.liquidityLabel}</code>`);
            }

            alertLines.push(
              `📊 <i>Trend: 4H ${setup.htf4hTrend.toUpperCase()} + 1H ${setup.htf1hTrend.toUpperCase()} | ${setup.spikeCountLabel || `${minSpikes} Spikes`}</i>`,
              `🔬 <i>Tracking live forward outcome to evaluate against backtest metrics.</i>`
            );

            await sendTelegramMessage(alertLines.join('\n'));
            console.log(`${YELLOW}${BOLD}   >>> [FORWARD TEST SIGNAL - ${strat.displayName}]: ${setup.direction} ${symbol} @ ${setup.entry.toFixed(2)} | TP: ${setup.tp.toFixed(2)} | SL: ${setup.sl.toFixed(2)}${RESET}`);

            const activeTrades = loadActiveTrades();
            activeTrades.push({
              setupId,
              symbol,
              type: setup.type,
              entryPrice: setup.entry,
              stopLoss: setup.sl,
              takeProfit: setup.tp,
              riskUSD: 0,
              rewardUSD: 0,
              candleEpoch: setup.candleEpoch,
              triggeredTime: Date.now(),
              isIncubation: true,
              strategy: strat.displayName
            });
            saveActiveTrades(activeTrades);

            break;
          }

          const compRisk = getWeeklyCompoundedRisk();
          const lotSize = calculateLotSize(symbol, setup.entry, setup.sl, compRisk.riskUSD);
          const dirEmoji = setup.direction === 'SELL' ? '🔴' : '🟢';
          const riskUSD = compRisk.riskUSD;
          const rewardUSD = compRisk.rewardUSD.toFixed(2);

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
            `👑 ${dirEmoji} <b>[MYTRADA SIGNAL — ${strat.displayName.toUpperCase()}]</b>`,
            `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
            `<b>Asset:</b> <code>${symbol}</code> (${symConfig.name})`,
            `<b>Action:</b> ${dirEmoji} <b>${setup.direction} (Market)</b>`,
            `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
            `🎯 <b>Entry:</b> <code>${setup.entry.toFixed(2)}</code>`,
            `🛡️ <b>Stop Loss:</b> <code>${setup.sl.toFixed(2)}</code>`,
            `🏆 <b>Take Profit:</b> <code>${setup.tp.toFixed(2)}</code> (+$${rewardUSD} USD • 1:1.3 R:R)`,
            `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
            `💰 <b>Lot Size:</b> <code>${lotSize} Lots</code>`,
            `🛡️ <b>Risk:</b> <code>-$${riskUSD.toFixed(2)} USD (${(dynamicState.customRiskPercent || compRisk.riskPercent).toFixed(1)}%)</code>`,
            `💵 <b>Account Equity:</b> <code>$${compRisk.liveBalance.toFixed(2)} USD</code>`
          ];

          if (setup.valuationLabel) {
            alertLines.push(`🏛️ <b>Dealing Range:</b> <code>${setup.valuationLabel}</code>`);
          }
          if (setup.liquidityLabel) {
            alertLines.push(`💧 <b>Liquidity Purge:</b> <code>${setup.liquidityLabel}</code>`);
          }

          alertLines.push(
            `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
            `📊 <i>Trend: 4H ${setup.htf4hTrend.toUpperCase()} + 1H ${setup.htf1hTrend.toUpperCase()} | ${setup.spikeCountLabel || `${minSpikes} Spikes`} + ${setup.confirmCount || 2}x 5M Confirmation</i>`
          );

          if (config.ENABLE_AI_VISION) {
            alertLines.push(
              `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
              `🧠 <b>AI VISION AUDIT:</b> ${aiVerdictBadge} (Confidence: ${(aiAudit.confidence * 100).toFixed(0)}%)`
            );
          }

          const alertHtml = alertLines.join('\n');

          await sendTelegramMessage(alertHtml);
          console.log(`${dirEmoji === '🔴' ? RED : GREEN}${BOLD}   >>> ${strat.displayName} SIGNAL [offset:${offset}]: ${setup.direction} ${symbol} @ ${setup.entry.toFixed(2)} | TP: ${setup.tp.toFixed(2)} | SL: ${setup.sl.toFixed(2)}${RESET}`);

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
            strategy: strat.displayName,
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
            strategy: strat.displayName,
            aiVisionVerdict: aiAudit.verdict,
            aiVisionReason: aiAudit.reason,
            aiVisionConfidence: aiAudit.confidence
          });
          recordTrigger(setupId);

          break;
        }
      }

      if (!signalFiredThisScan) {
        console.log(`  [${mode}] ${symbol.padEnd(12)} | ${latestPrice.toFixed(2)} | Monitoring for ${minSpikes}-Spike Pullback Exhaustion...`);
        await checkActiveTradesForSymbol(symbol, ltfCandles);
        await checkShadowTradesForSymbol(symbol, ltfCandles);
      } else {
        await checkShadowTradesForSymbol(symbol, ltfCandles);
      }
    } catch (err) {
      console.log(`  [DATA ERROR] ${symbol}: ${err.message}`);
      console.warn(`  [WARN] ${symbol}: ${err.message}`);
    }

    // Pacing delay (300ms) between symbols to prevent Datacenter IP rate-limiting
    await new Promise(r => setTimeout(r, 300));
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
  const isTestData = args.includes('--test-data');

  if (isTestData) {
    console.log(`\n👑 ${BOLD}${CYAN}Testing Deriv Live Data Feed (${Object.keys(config.SYMBOLS).length} Elite Pairs)...${RESET}`);
    const symbols = Object.keys(config.SYMBOLS);
    for (const sym of symbols) {
      try {
        const c = await getCandles(sym, '5m', 10, true);
        const latest = c[c.length - 1];
        console.log(`  ${GREEN}✅ ${sym.padEnd(12)}${RESET} | Latest: ${latest.close.toFixed(2)} | Time: ${new Date(latest.time).toTimeString().slice(0, 8)}`);
      } catch (err) {
        console.log(`  ${RED}❌ ${sym.padEnd(12)}${RESET} | ERROR: ${err.message}`);
      }
    }
    console.log(`\n${GREEN}✅ Data connection test complete.${RESET}`);
    process.exit(0);
  }

  if (isTest) {
    console.log("\n🧪 Dispatching Test Telegram Alert...");
    const testMsg = "🚀 <b>[MYTRADA TEST]</b>\nTelegram Signal Dispatcher & Interactive Command Center connected successfully!\nSend <code>/status</code> to check bot status.";
    await sendTelegramMessage(testMsg);
    console.log(`${GREEN}✅ SUCCESS: Test alert sent to Telegram!${RESET}`);
    process.exit(0);
  }

  if (isReport) {
    console.log("\n📊 Dispatching Manual Daily Report Test to Telegram...");
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const yesterdayStr = getLocalDateStr(yesterday);
    const report = generateDailyReport(yesterdayStr);
    const reportHtml = formatReportTelegramHTML(report);
    await sendTelegramMessage(reportHtml);
    console.log(`${GREEN}✅ SUCCESS: Daily Performance Report dispatched to Telegram!${RESET}`);
    process.exit(0);
  }

  if (isScanOnly) {
    console.log(`\n👑 ${BOLD}${CYAN}Mytrada Real-Time Market Scan (${Object.keys(config.SYMBOLS).length} Elite Pairs)${RESET}`);
    await monitorMarket();
    console.log(`\n${GREEN}✅ Real-time scan completed successfully.${RESET}`);
    process.exit(0);
  }

  const compRisk = getWeeklyCompoundedRisk();
  const startupTargetLabel = dynamicState.dailyTargetUSD > 0 ? `$${dynamicState.dailyTargetUSD.toFixed(2)}` : 'None';
  const startupLossLabel = dynamicState.dailyMaxLossUSD > 0 ? `-$${dynamicState.dailyMaxLossUSD.toFixed(2)}` : 'None';
  const targetLabel = dynamicState.dailyTargetUSD > 0 ? `$${dynamicState.dailyTargetUSD.toFixed(2)} USD` : 'Disabled';
  const maxLossLabel = dynamicState.dailyMaxLossUSD > 0 ? `-$${dynamicState.dailyMaxLossUSD.toFixed(2)} USD` : 'Disabled';

  if (dynamicState.activeStrategy === 'NONE') {
    console.log(`\n👑 ${BOLD}${CYAN}Mytrada Signal Runner — ONLINE IN STANDBY MODE${RESET}`);
    console.log(`🚀 Waiting for /strategy command on Telegram (/strategy 6pro, /strategy 5b, or /strategy both)...\n`);

    await sendTelegramMessage([
      `🚀 <b>[MYTRADA SYSTEM ONLINE — STANDBY MODE]</b>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `• <b>Status:</b> 🟡 <b>STANDBY (Awaiting Strategy Launch)</b>`,
      `• <b>Universe:</b> <code>${Object.keys(config.SYMBOLS).length} Elite Pairs</code>`,
      `• <b>Account Equity:</b> <code>$${compRisk.liveBalance.toFixed(2)} USD</code>`,
      `• <b>Daily Profit Target:</b> <code>${targetLabel}</code>`,
      `• <b>Daily Max Loss Floor:</b> <code>${maxLossLabel}</code>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `💡 <b>Send a command to launch your strategy:</b>`,
      `• <code>/strategy 6pro</code> — Launch Strategy 6 Pro (Institutional SMC)`,
      `• <code>/strategy 5b</code> — Launch Strategy 5B Enhanced`,
      `• <code>/strategy both</code> — Launch Both (5B Live + 6 Pro Paper Sandbox)`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`
    ].join('\n'));
  } else {
    const isBoth = dynamicState.activeStrategy === 'BOTH';
    const is6Pro = dynamicState.activeStrategy === 'STRATEGY_6_PRO';
    const stratDisplayName = isBoth
      ? 'Dual Engine (5B Live + 6 Pro Paper Sandbox)'
      : (is6Pro ? 'Strategy 6 Pro (Institutional SMC)' : 'Strategy 5B Enhanced');

    console.log(`\n👑 ${BOLD}${CYAN}Mytrada Institutional Signal Runner — ${stratDisplayName}${RESET}`);
    console.log(`🚀 Universe: ${Object.keys(config.SYMBOLS).length} Elite Pairs | Target: ${startupTargetLabel} | Loss Floor: ${startupLossLabel} | Telegram Active...\n`);

    await sendTelegramMessage([
      `🚀 <b>[MYTRADA SYSTEM ONLINE — ${isBoth ? 'DUAL ENGINE' : (is6Pro ? 'STRATEGY 6 PRO' : 'STRATEGY 5B ENHANCED')}]</b>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `• <b>Strategy:</b> <code>${stratDisplayName}</code>`,
      `• <b>Universe:</b> <code>${Object.keys(config.SYMBOLS).length} Elite Pairs</code>`,
      `• <b>Daily Profit Target:</b> <code>${targetLabel}</code>`,
      `• <b>Daily Max Loss Floor:</b> <code>${maxLossLabel}</code>`,
      `• <b>Risk Model:</b> <code>Fixed 1:1.3 R:R (3.0% Risk)</code>`,
      `• <b>Telegram Control:</b> <b>ACTIVE</b> (Send <code>/help</code> for commands)`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`
    ].join('\n'));
  }

  // Start Interactive Telegram Inbound Listener in Background
  startTelegramListener(telegramHandlers);

  // Start High-Speed Dedicated Position Monitor (Checks open trades every 3 seconds)
  setInterval(monitorActivePositionsFast, 3000);

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
