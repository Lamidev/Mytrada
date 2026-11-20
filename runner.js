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
const { detectStrategy6Setup } = require('./strategy6');
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
  recordIncubationOutcome,
  checkIncubationGraduation,
  generateDayTradeExport
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
const STRUCTURE_WATCH_FILE = path.join(CACHE_DIR, 'structure_watch_state.json');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function loadStructureWatchState() {
  if (fs.existsSync(STRUCTURE_WATCH_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(STRUCTURE_WATCH_FILE, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    } catch (e) {
      return {};
    }
  }
  return {};
}

function saveStructureWatchState(state) {
  try {
    fs.writeFileSync(STRUCTURE_WATCH_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {}
}

let structureWatchState = loadStructureWatchState();

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

// ── AUTONOMOUS DAILY TARGET & MAX LOSS CALCULATOR ──
function calculateAutoDailyTargets(customPct = null, customWins = null, customLosses = null) {
  try {
    const activePct = (typeof customPct === 'number' && customPct > 0)
      ? customPct
      : (dynamicState && dynamicState.customRiskPercent ? dynamicState.customRiskPercent : (config.RISK_PERCENT || 3.0));
    const compRisk = getWeeklyCompoundedRisk(activePct);
    const targetMultiplier = (typeof customWins === 'number' && customWins > 0)
      ? customWins
      : ((dynamicState && dynamicState.targetWinsMultiplier) || (config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.TARGET_WINS_MULTIPLIER) || 3);
    const maxLossMultiplier = (typeof customLosses === 'number' && customLosses > 0)
      ? customLosses
      : ((dynamicState && dynamicState.maxLossMultiplier) || (config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.MAX_LOSS_LOSSES_MULTIPLIER) || 3);
    const autoTarget = parseFloat((compRisk.rewardUSD * targetMultiplier).toFixed(2));
    const autoMaxLoss = parseFloat((compRisk.riskUSD * maxLossMultiplier).toFixed(2));
    return {
      riskPercent: activePct,
      balance: compRisk.balance,
      liveBalance: compRisk.liveBalance,
      riskUSD: compRisk.riskUSD,
      rewardUSD: compRisk.rewardUSD,
      dailyTargetUSD: autoTarget,
      dailyMaxLossUSD: autoMaxLoss,
      targetMultiplier,
      maxLossMultiplier
    };
  } catch (e) {
    return {
      riskPercent: customPct || 3.0,
      riskUSD: 0,
      rewardUSD: 0,
      dailyTargetUSD: 0,
      dailyMaxLossUSD: 0,
      targetMultiplier: 3,
      maxLossMultiplier: 3
    };
  }
}

// ── DYNAMIC STATE & DAILY TARGET MANAGER ──
function loadDynamicState() {
  const today = getLocalDateStr();
  const autoTargets = calculateAutoDailyTargets();
  const defaultTarget = (config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.AUTO_TARGET_ENABLED !== false)
    ? autoTargets.dailyTargetUSD
    : (config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.DEFAULT_DAILY_PROFIT_TARGET_USD !== undefined ? config.CIRCUIT_BREAKER.DEFAULT_DAILY_PROFIT_TARGET_USD : 0.0);
  const defaultMaxLoss = (config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.AUTO_TARGET_ENABLED !== false)
    ? autoTargets.dailyMaxLossUSD
    : (config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.DEFAULT_DAILY_MAX_LOSS_USD !== undefined ? config.CIRCUIT_BREAKER.DEFAULT_DAILY_MAX_LOSS_USD : 0.0);

  if (fs.existsSync(DYNAMIC_STATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(DYNAMIC_STATE_FILE, 'utf8'));
      if (data.targetWinsMultiplier === undefined || data.targetWinsMultiplier === 2) {
        data.targetWinsMultiplier = (config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.TARGET_WINS_MULTIPLIER) || 3;
      }
      if (data.maxLossMultiplier === undefined || data.maxLossMultiplier === 2) {
        data.maxLossMultiplier = (config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.MAX_LOSS_LOSSES_MULTIPLIER) || 3;
      }
      const activePct = data.customRiskPercent || config.RISK_PERCENT || 3.0;
      const currentTargets = calculateAutoDailyTargets(activePct, data.targetWinsMultiplier, data.maxLossMultiplier);
      if (data.date !== today) {
        data.date = today;
        data.dailyTargetLocked = false;
        data.dailyTargetUSD = (config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.AUTO_TARGET_ENABLED !== false)
          ? currentTargets.dailyTargetUSD
          : defaultTarget;
        data.dailyLossLocked = false;
        data.dailyMaxLossUSD = (config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.AUTO_TARGET_ENABLED !== false)
          ? currentTargets.dailyMaxLossUSD
          : defaultMaxLoss;
        data.portfolioConsecutiveLosses = 0;
        data.portfolioPauseUntil = 0;
        data.isManuallyPaused = false;
        data.is5bPaused = false;
        data.is6proPaused = false;
        data.desk5b = {
          netUSD: 0,
          netR: 0,
          wins: 0,
          losses: 0,
          consecutiveLosses: 0,
          pauseUntil: 0,
          targetUSD: 908.43,
          maxLossUSD: 698.79,
          targetLocked: false,
          lossLocked: false,
          isPaused: false
        };
        data.deskSMC = {
          netUSD: 0,
          netR: 0,
          wins: 0,
          losses: 0,
          consecutiveLosses: 0,
          pauseUntil: 0,
          targetUSD: 908.43,
          maxLossUSD: 698.79,
          targetLocked: false,
          lossLocked: false,
          isPaused: false
        };
        data.masterAccount = {
          maxDailyLossUSD: 1397.58,
          dailyLossLocked: false
        };
        saveDynamicState(data);
      }
      if (data.dailyTargetUSD === 250 || data.dailyTargetUSD === 598.35 || data.dailyTargetUSD === undefined || (config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.AUTO_TARGET_ENABLED && data.dailyTargetUSD === 0)) {
        data.dailyTargetUSD = currentTargets.dailyTargetUSD || defaultTarget;
        data.dailyTargetLocked = false;
        saveDynamicState(data);
      }
      if (data.dailyMaxLossUSD === 460.26 || data.dailyMaxLossUSD === undefined || (config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.AUTO_TARGET_ENABLED && data.dailyMaxLossUSD === 0)) {
        data.dailyMaxLossUSD = currentTargets.dailyMaxLossUSD || defaultMaxLoss;
        data.dailyLossLocked = false;
        saveDynamicState(data);
      }
      if (!data.activeStrategy) {
        data.activeStrategy = 'BOTH';
        saveDynamicState(data);
      }
      if (!data.executionMode) {
        data.executionMode = 'LIVE';
        saveDynamicState(data);
      }
      if (!data.mode5b) {
        data.mode5b = 'LIVE';
        saveDynamicState(data);
      }
      if (!data.mode6pro) {
        data.mode6pro = 'LIVE';
        saveDynamicState(data);
      }
      if (data.is5bPaused === undefined) data.is5bPaused = false;
      if (data.is6proPaused === undefined) data.is6proPaused = false;
      if (data.balanceAllocation === undefined) data.balanceAllocation = 0.50;
      if (!data.desk5b) {
        data.desk5b = {
          netUSD: 0,
          netR: 0,
          wins: 0,
          losses: 0,
          consecutiveLosses: 0,
          pauseUntil: 0,
          targetUSD: 908.43,
          maxLossUSD: 698.79,
          targetLocked: false,
          lossLocked: false,
          isPaused: false
        };
      }
      if (!data.deskSMC) {
        data.deskSMC = {
          netUSD: 0,
          netR: 0,
          wins: 0,
          losses: 0,
          consecutiveLosses: 0,
          pauseUntil: 0,
          targetUSD: 908.43,
          maxLossUSD: 698.79,
          targetLocked: false,
          lossLocked: false,
          isPaused: false
        };
      }
      if (!data.masterAccount) {
        data.masterAccount = {
          maxDailyLossUSD: 1397.58,
          dailyLossLocked: false
        };
      }
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
    customRiskPercent: config.RISK_PERCENT || 3.0,
    targetWinsMultiplier: (config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.TARGET_WINS_MULTIPLIER) || 3,
    maxLossMultiplier: (config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.MAX_LOSS_LOSSES_MULTIPLIER) || 3,
    portfolioConsecutiveLosses: 0,
    portfolioPauseUntil: 0,
    activeStrategy: 'BOTH',
    executionMode: 'LIVE',
    mode5b: 'LIVE',
    mode6pro: 'LIVE',
    is5bPaused: false,
    is6proPaused: false,
    balanceAllocation: 0.50,
    desk5b: {
      netUSD: 0,
      netR: 0,
      wins: 0,
      losses: 0,
      consecutiveLosses: 0,
      pauseUntil: 0,
      targetUSD: 908.43,
      maxLossUSD: 698.79,
      targetLocked: false,
      lossLocked: false,
      isPaused: false
    },
    deskSMC: {
      netUSD: 0,
      netR: 0,
      wins: 0,
      losses: 0,
      consecutiveLosses: 0,
      pauseUntil: 0,
      targetUSD: 908.43,
      maxLossUSD: 698.79,
      targetLocked: false,
      lossLocked: false,
      isPaused: false
    },
    masterAccount: {
      maxDailyLossUSD: 1397.58,
      dailyLossLocked: false
    }
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

// ── AUTO-RESET TO RESTORE TODAY'S FRESH SESSION ($5,114.16 USD) ──
const RESET_OCT23_FLAG_FILE = path.join(CACHE_DIR, 'reconciled_oct23_reset.json');
if (!fs.existsSync(RESET_OCT23_FLAG_FILE)) {
  try {
    const { resetTodayState } = require('./reconcileTodayReset');
    resetTodayState(5114.16, '2026-10-23');
    fs.writeFileSync(RESET_OCT23_FLAG_FILE, JSON.stringify({
      resetAt: new Date().toISOString(),
      startingBalance: 5114.16
    }), 'utf8');
  } catch (err) {
    console.warn("[runner] Auto-reset notice:", err.message);
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

function getStratKey(stratId) {
  const s = String(stratId || '').toUpperCase();
  if (s.includes('SMC') || s.includes('6PRO') || s.includes('SWEEP') || s.includes('6_PRO')) return 'SMC';
  return '5B';
}

function getPairHealth(symbol, stratId = '5B') {
  const stratKey = getStratKey(stratId);
  const compositeKey = `${stratKey}_${symbol}`;
  if (!pairHealthState[compositeKey]) {
    const legacy = pairHealthState[symbol];
    const isQuar = legacy && stratKey === '5B' ? (legacy.isQuarantined || false) : false;
    const qReason = legacy && stratKey === '5B' ? legacy.quarantineReason : null;
    pairHealthState[compositeKey] = {
      symbol,
      strategy: stratKey,
      consecutiveLosses: legacy && stratKey === '5B' ? (legacy.consecutiveLosses || 0) : 0,
      consecutivePaperWins: 0,
      weeklyNetR: legacy && stratKey === '5B' ? (legacy.weeklyNetR || 0.0) : 0.0,
      isQuarantined: isQuar,
      quarantineReason: qReason,
      quarantinedAt: legacy && stratKey === '5B' ? legacy.quarantinedAt : null,
      totalRealWins: legacy && stratKey === '5B' ? (legacy.totalRealWins || 0) : 0,
      totalRealLosses: legacy && stratKey === '5B' ? (legacy.totalRealLosses || 0) : 0
    };
  }
  return pairHealthState[compositeKey];
}

async function updatePairHealthOnLiveClose(symbol, outcome, stratId = '5B') {
  const stratKey = getStratKey(stratId);
  const stratName = stratKey === 'SMC' ? 'Strategy SMC' : 'Strategy 5B Pro';
  const rec = getPairHealth(symbol, stratKey);
  if (outcome === 'WIN') {
    rec.consecutiveLosses = 0;
    rec.weeklyNetR = (rec.weeklyNetR || 0) + 1.3;
    rec.totalRealWins = (rec.totalRealWins || 0) + 1;
  } else if (outcome === 'LOSS') {
    rec.consecutiveLosses = (rec.consecutiveLosses || 0) + 1;
    rec.weeklyNetR = (rec.weeklyNetR || 0) - 1.0;
    rec.totalRealLosses = (rec.totalRealLosses || 0) + 1;

    // 🛡️ SMART 2-LOSS AUTO-QUARANTINE RULES (Strategy 5B Pro Only):
    // Strategy SMC is a selective, low-frequency sniper engine (1-2 setups/day per universe).
    // Pair quarantine is disabled for SMC to avoid banishing pairs for days;
    // SMC is instead protected by Symbol Daily Limit (2 losses/day max) and Desk Max Loss Floor (-3.0R).
    if (stratKey === 'SMC') {
      savePairHealthState(pairHealthState);
      return;
    }

    const isBufferThin = rec.weeklyNetR < 1.0;
    const shouldQuarantine = (rec.consecutiveLosses >= 2 && isBufferThin) || (rec.consecutiveLosses >= 3);

    if (shouldQuarantine && !rec.isQuarantined) {
      rec.isQuarantined = true;
      rec.quarantineReason = (rec.consecutiveLosses >= 2 && isBufferThin)
        ? `2 Consecutive Losses with Thin Profit Buffer (${rec.weeklyNetR >= 0 ? '+' : ''}${rec.weeklyNetR.toFixed(1)}R below 1.0R)`
        : `3 Consecutive Losses (Hard Safety Floor)`;
      rec.quarantinedAt = new Date().toISOString();
      rec.consecutivePaperWins = 0;

      savePairHealthState(pairHealthState);

      const alertMsg = [
        `⚠️ 🛡️ <b>[MYTRADA AUTO-QUARANTINE ACTIVATED — ${stratName.toUpperCase()}]</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].name : symbol})`,
        `<b>Engine:</b> <code>${stratName}</code>`,
        `<b>Trigger:</b> <code>${rec.quarantineReason}</code>`,
        `<b>Action:</b> <b>Demoted to Paper Test Mode for ${stratName} ($0 Real Risk)</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `📊 <b>Pair Record (${stratName}):</b> <code>${rec.totalRealWins}W / ${rec.totalRealLosses}L (${rec.weeklyNetR >= 0 ? '+' : ''}${rec.weeklyNetR.toFixed(1)}R)</code>`,
        `💵 <b>Live Account Balance Protected:</b> <code>$${getCurrentAccountBalance().toFixed(2)} USD</code>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `💡 <i>Bot will safely forward-test this pair in paper sandbox until it scores 2 winning paper setups, or send /unquarantine ${symbol} ${stratKey.toLowerCase()} to override.</i>`
      ].join('\n');

      await sendTelegramMessage(alertMsg);
      console.log(`\n⚠️ [AUTO-QUARANTINE] ${symbol} demoted to Paper Mode for ${stratName}: ${rec.quarantineReason}\n`);
    }
  }

  savePairHealthState(pairHealthState);
}

async function updatePairHealthOnPaperClose(symbol, outcome, trade = null, stratId = null) {
  const stratKey = getStratKey(stratId || (trade && trade.strategy) || (trade && trade.setupId) || '5B');
  const stratName = stratKey === 'SMC' ? 'Strategy SMC' : 'Strategy 5B Pro';
  const rec = getPairHealth(symbol, stratKey);
  if (!rec.isQuarantined) return;

  if (outcome === 'WIN') {
    const setupEpoch = trade && (trade.candleEpoch || 0);
    const triggerTime = trade && (trade.triggeredTime || 0);

    const isSameEpoch = setupEpoch && rec.lastPaperWinEpoch && setupEpoch === rec.lastPaperWinEpoch;
    const isSameTriggerWindow = triggerTime && rec.lastPaperWinTriggerTime && Math.abs(triggerTime - rec.lastPaperWinTriggerTime) < 15 * 60 * 1000;
    const isInstantCloseDup = rec.lastPaperWinClosedAt && (Date.now() - rec.lastPaperWinClosedAt < 5 * 60 * 1000);

    if (isSameEpoch || isSameTriggerWindow || isInstantCloseDup) {
      console.log(`[QUARANTINE] 🛡️ Ignored duplicate paper TP for ${symbol} (${stratName}). Already credited for this market setup.`);
      return;
    }

    rec.lastPaperWinEpoch = setupEpoch;
    rec.lastPaperWinTriggerTime = triggerTime;
    rec.lastPaperWinClosedAt = Date.now();
    rec.consecutivePaperWins = (rec.consecutivePaperWins || 0) + 1;

    if (rec.consecutivePaperWins >= 2) {
      rec.isQuarantined = false;
      rec.consecutiveLosses = 0;
      rec.consecutivePaperWins = 0;
      rec.lastPaperWinEpoch = null;
      rec.lastPaperWinTriggerTime = null;
      rec.lastPaperWinClosedAt = null;
      rec.quarantineReason = null;
      rec.quarantinedAt = null;

      savePairHealthState(pairHealthState);

      const alertMsg = [
        `🏆 🟢 <b>[PAIR GRADUATION: RESTORED TO LIVE]</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].name : symbol})`,
        `<b>Strategy:</b> <code>${stratName}</code>`,
        `<b>Achievement:</b> <code>2 Consecutive Winning Paper Setups (+2.6R)</code>`,
        `<b>Action:</b> <b>Restored to Live Real Trading for ${stratName}!</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `🚀 <i>Market structure & trend clarity have stabilized. Real execution re-enabled.</i>`
      ].join('\n');

      await sendTelegramMessage(alertMsg);
      console.log(`\n🏆 [PAIR GRADUATION] ${symbol} achieved 2 winning paper trades -> Restored to Live Trading for ${stratName}!\n`);
    } else {
      console.log(`\n🔬 [QUARANTINE PROGRESS] ${symbol} (${stratName}) recorded Paper Win 1/2. Waiting for next distinct setup to graduate.\n`);
    }
  } else if (outcome === 'LOSS') {
    rec.consecutivePaperWins = 0;
    rec.lastPaperWinEpoch = null;
    rec.lastPaperWinTriggerTime = null;
    rec.lastPaperWinClosedAt = null;
  }

  savePairHealthState(pairHealthState);
}

function manualSetQuarantine(symbol, isQuarantined, reason = 'Manual update via Telegram', stratTarget = 'ALL') {
  if (!config.SYMBOLS[symbol]) {
    return { success: false, error: `Symbol ${symbol} not in configured universe.` };
  }
  const sUpper = String(stratTarget || 'ALL').toUpperCase();
  let strats = ['5B', 'SMC'];
  if (sUpper.includes('5B')) strats = ['5B'];
  else if (sUpper.includes('SMC') || sUpper.includes('6PRO') || sUpper.includes('SWEEP')) strats = ['SMC'];

  for (const s of strats) {
    const rec = getPairHealth(symbol, s);
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
  }
  savePairHealthState(pairHealthState);
  return { success: true };
}

async function recordTradeOutcomeToDesk(stratId, outcome, pnlUsd, pnlR) {
  dynamicState = loadDynamicState();
  const stratKey = getStratKey(stratId);
  const isSmc = stratKey === 'SMC';
  const deskKey = isSmc ? 'deskSMC' : 'desk5b';
  const deskName = isSmc ? 'Strategy SMC' : 'Strategy 5B Pro';

  if (!dynamicState[deskKey]) {
    dynamicState[deskKey] = {
      netUSD: 0,
      netR: 0,
      wins: 0,
      losses: 0,
      consecutiveLosses: 0,
      pauseUntil: 0,
      targetUSD: 908.43,
      maxLossUSD: 698.79,
      targetLocked: false,
      lossLocked: false,
      isPaused: false
    };
  }

  const desk = dynamicState[deskKey];
  desk.netUSD = parseFloat(((desk.netUSD || 0) + pnlUsd).toFixed(2));
  desk.netR = parseFloat(((desk.netR || 0) + pnlR).toFixed(1));
  if (outcome === 'WIN') {
    desk.wins = (desk.wins || 0) + 1;
    desk.consecutiveLosses = 0;
  } else if (outcome === 'LOSS') {
    desk.losses = (desk.losses || 0) + 1;
    desk.consecutiveLosses = (desk.consecutiveLosses || 0) + 1;
  }

  // 1. Check Desk Consecutive Loss Cooldown (e.g. 3 consecutive live losses on this desk only)
  const maxConsecLosses = (config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.PORTFOLIO_CONSECUTIVE_LOSS_LIMIT) || 3;
  if (desk.consecutiveLosses >= maxConsecLosses && !desk.lossLocked) {
    const pauseMins = (config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.PORTFOLIO_LOSS_PAUSE_MINS) || 120;
    desk.pauseUntil = Date.now() + (pauseMins * 60 * 1000);
    desk.consecutiveLosses = 0; // Reset counter
    saveDynamicState(dynamicState);
    const pauseHours = (pauseMins / 60).toFixed(pauseMins % 60 === 0 ? 0 : 1);
    const consecMsg = [
      `⚠️ 🛡️ <b>[${deskName.toUpperCase()} CONSECUTIVE LOSS COOLDOWN]</b>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `<b>Trigger:</b> <code>${maxConsecLosses} consecutive live losses</code> hit on <b>${deskName}</b>.`,
      `<b>Action:</b> Real trading paused on <b>${deskName}</b> for <b>${pauseMins} minutes (${pauseHours}h)</b> to let market settle.`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `👑 <i>The other desk remains completely independent & active! Send /resume to override.</i>`
    ].join('\n');
    await sendTelegramMessage(consecMsg).catch(() => null);
  }

  // 2. Check Desk Daily Target (+$908.43 / +3.9R)
  if (desk.targetUSD && desk.netUSD >= desk.targetUSD && !desk.targetLocked) {
    desk.targetLocked = true;
    saveDynamicState(dynamicState);
    const targetMsg = [
      `🎯 🔒 <b>[${deskName.toUpperCase()} — DAILY TARGET ACHIEVED]</b>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `🏆 <b>Desk Net Profit:</b> <code>+$${desk.netUSD.toFixed(2)} USD (+${desk.netR.toFixed(1)}R)</code>`,
      `🎯 <b>Target:</b> <code>+$${desk.targetUSD.toFixed(2)} USD (${desk.wins}W / ${desk.losses}L)</code>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `🛡️ <b>Action:</b> <i>Desk profit locked for the day! Real trading halted for ${deskName} to protect gains until midnight UTC. (Other desk continues trading if unlocked).</i>`
    ].join('\n');
    await sendTelegramMessage(targetMsg);
  }

  // 2. Check Desk Daily Max Loss Floor (-$698.79 / -3.0R or 3 live losses)
  const maxLossLimit = dynamicState.maxLossMultiplier || 3;
  const isLossBreached = (desk.maxLossUSD && desk.netUSD <= -desk.maxLossUSD) || 
                         ((desk.losses || 0) >= maxLossLimit);

  if (isLossBreached && !desk.lossLocked) {
    desk.lossLocked = true;
    saveDynamicState(dynamicState);
    const lossMsg = [
      `🛑 🔒 <b>[${deskName.toUpperCase()} — DAILY MAX LOSS REACHED]</b>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `💸 <b>Desk Net Loss:</b> <code>-$${Math.abs(desk.netUSD).toFixed(2)} USD (${desk.netR.toFixed(1)}R)</code>`,
      `🛑 <b>Max Loss Floor:</b> <code>-$${(desk.maxLossUSD || 698.79).toFixed(2)} USD (${desk.losses} Live Losses)</code>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `🛡️ <b>Action:</b> <i>Circuit breaker engaged! Live trading halted for ${deskName} until midnight UTC to protect capital. (Other desk continues normally if within limits).</i>`
    ].join('\n');
    await sendTelegramMessage(lossMsg);
  }

  // 3. Check Master Account Emergency Valve (-$1,397.58 USD combined loss)
  const master = dynamicState.masterAccount || { maxDailyLossUSD: 1397.58, dailyLossLocked: false };
  const combinedNetUSD = (dynamicState.desk5b?.netUSD || 0) + (dynamicState.deskSMC?.netUSD || 0);
  if (combinedNetUSD <= -master.maxDailyLossUSD && !master.dailyLossLocked) {
    master.dailyLossLocked = true;
    dynamicState.masterAccount = master;
    if (dynamicState.desk5b) dynamicState.desk5b.lossLocked = true;
    if (dynamicState.deskSMC) dynamicState.deskSMC.lossLocked = true;
    dynamicState.dailyLossLocked = true;
    saveDynamicState(dynamicState);

    const masterAlert = [
      `🚨 🛑 <b>[MASTER EMERGENCY CIRCUIT BREAKER ENGAGED]</b>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `💸 <b>Combined Account Daily Drawdown:</b> <code>-$${Math.abs(combinedNetUSD).toFixed(2)} USD</code>`,
      `🛑 <b>Combined Emergency Floor:</b> <code>-$${master.maxDailyLossUSD.toFixed(2)} USD (-3.0R Total Equity)</code>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `🔒 <b>Action: ALL TRADING HALTED ACROSS BOTH ENGINES.</b>`,
      `🛡️ <i>Both Strategy 5B Pro and Strategy SMC locked until next daily rollover to preserve master account balance.</i>`
    ].join('\n');
    await sendTelegramMessage(masterAlert);
  }

  saveDynamicState(dynamicState);
}

function formatHealthTelegramHTML() {
  const symbols = Object.keys(config.SYMBOLS);
  const lines = [
    `🏥 <b>[MYTRADA MULTI-PAIR HEALTH SCORECARD]</b>`,
    `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`
  ];

  let live5b = 0, quar5b = 0;
  let liveSmc = 0, quarSmc = 0;

  for (const sym of symbols) {
    const symConfig = config.SYMBOLS[sym];
    const rec5b = getPairHealth(sym, '5B');
    const recSmc = getPairHealth(sym, 'SMC');

    // 5B badge
    let badge5b = '🟢 LIVE';
    if (symConfig.monitorOnly) {
      badge5b = '🔬 INCUBATOR';
    } else if (rec5b.isQuarantined) {
      badge5b = `🔴 QUARANTINE (${rec5b.consecutivePaperWins || 0}/2)`;
      quar5b++;
    } else {
      live5b++;
    }

    // SMC badge (BOOM150N & CRASH150N are active for SMC, not incubator)
    let badgeSmc = '🟢 LIVE';
    if (symConfig.monitorOnly && sym !== 'BOOM150N' && sym !== 'CRASH150N') {
      badgeSmc = '🔬 INCUBATOR';
    } else if (recSmc.isQuarantined) {
      badgeSmc = `🔴 QUARANTINE (${recSmc.consecutivePaperWins || 0}/2)`;
      quarSmc++;
    } else {
      liveSmc++;
    }

    lines.push(`• <b>${sym}:</b>`);
    lines.push(`  ├ <b>5B Pro:</b> ${badge5b} [${rec5b.weeklyNetR >= 0 ? '+' : ''}${(rec5b.weeklyNetR || 0).toFixed(1)}R]`);
    lines.push(`  └ <b>SMC:</b>    ${badgeSmc} [${recSmc.weeklyNetR >= 0 ? '+' : ''}${(recSmc.weeklyNetR || 0).toFixed(1)}R]`);
  }

  lines.push(`<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`);
  lines.push(`📊 <b>5B Pro:</b> <code>${live5b} Live | ${quar5b} Quarantined</code>`);
  lines.push(`📊 <b>Strategy SMC:</b> <code>${liveSmc} Live | ${quarSmc} Quarantined</code>`);
  lines.push(`💡 <i>Use /quarantine &lt;sym&gt; [5b|smc] or /unquarantine &lt;sym&gt; [5b|smc] to manage.</i>`);

  return lines.join('\n');
}

function isSymbolInCooldown(symbol, isPaper = false, currentPrice = null, stratId = null) {
  if (!config.CIRCUIT_BREAKER || !config.CIRCUIT_BREAKER.ENABLED) return { inCooldown: false };
  
  // Always load fresh state from disk to guarantee instant cross-monitor synchronization
  circuitBreakerState = loadCircuitBreakerState();

  const stratKey = stratId ? getStratKey(stratId) : null;
  const compositeKey = stratKey ? `${stratKey}_${symbol}` : null;
  const rec = (compositeKey && circuitBreakerState.symbols && circuitBreakerState.symbols[compositeKey])
    ? circuitBreakerState.symbols[compositeKey]
    : (circuitBreakerState.symbols && circuitBreakerState.symbols[symbol]);
  if (!rec) return { inCooldown: false };

  const maxDaily = config.CIRCUIT_BREAKER.MAX_DAILY_LOSSES_PER_SYMBOL || 2;
  const dailyLosses = isPaper ? (rec.paperDailyLosses || 0) : (rec.dailyLosses || 0);
  const pauseUntil = isPaper ? (rec.paperPauseUntil || 0) : (rec.pauseUntil || 0);
  const consecLosses = isPaper ? (rec.paperConsecutiveLosses || 0) : (rec.consecutiveLosses || 0);

  if (dailyLosses >= maxDaily || consecLosses >= 2) {
    const triggerDesc = consecLosses >= 2 ? `${consecLosses} consecutive` : `${dailyLosses} daily`;
    return { inCooldown: true, reason: `Symbol limit (${triggerDesc} ${isPaper ? 'paper ' : ''}losses) reached — halted for today` };
  }

  const now = Date.now();
  if (pauseUntil && now < pauseUntil) {
    const remMins = Math.ceil((pauseUntil - now) / 60000);
    const isWinLock = isPaper ? rec.isPaperWinLocked : rec.isWinLocked;
    let reason;
    if (isWinLock) {
      reason = `${isPaper ? 'Paper symbol' : 'Symbol'} 2-Win Profit Lock active (${remMins}m remaining)`;
    } else if (consecLosses === 0 && dailyLosses < maxDaily) {
      reason = `${isPaper ? 'Paper post-win' : 'Post-win'} breathing room (${remMins}m remaining)`;
    } else {
      reason = `${isPaper ? 'Paper cooldown' : 'Cooldown'} active — ${remMins}m remaining`;
    }
    return { inCooldown: true, reason };
  } else if (pauseUntil && now >= pauseUntil) {
    if (isPaper) {
      rec.isPaperWinLocked = false;
    } else {
      rec.isWinLocked = false;
    }
  }

  // 🛡️ Option 3: 1H Candle Reset & Runaway Continuation Trap Armor
  if (rec.trapZone && now < rec.trapZone.expiresAt) {
    if (currentPrice !== null && typeof currentPrice === 'number' && !isNaN(currentPrice)) {
      const remMins = Math.ceil((rec.trapZone.expiresAt - now) / 60000);
      const isSell = rec.trapZone.direction === 'SELL';
      const isBuy = rec.trapZone.direction === 'BUY';
      const isAdverseRunaway = (isSell && currentPrice >= rec.trapZone.zoneMin) || (isBuy && currentPrice <= rec.trapZone.zoneMax);

      if (isAdverseRunaway) {
        const isInsideZone = currentPrice >= rec.trapZone.zoneMin && currentPrice <= rec.trapZone.zoneMax;
        const reasonDesc = isInsideZone
          ? `inside failed zone [${rec.trapZone.zoneMin.toFixed(2)} - ${rec.trapZone.zoneMax.toFixed(2)}]`
          : (isSell ? `in runaway continuation spike above failed entry (${currentPrice.toFixed(2)} > ${rec.trapZone.failedPrice.toFixed(2)})` : `in runaway continuation dump below failed entry (${currentPrice.toFixed(2)} < ${rec.trapZone.failedPrice.toFixed(2)})`);
        return {
          inCooldown: true,
          reason: `1H Trap Armor: Price is ${reasonDesc} (${remMins}m cooldown remaining)`
        };
      }
    }
  }

  return { inCooldown: false };
}

function recordSymbolTradeOutcome(symbol, outcome, isPaper = false, tradeDetails = null) {
  const today = new Date().toISOString().slice(0, 10);
  if (!circuitBreakerState || circuitBreakerState.date !== today) {
    circuitBreakerState = loadCircuitBreakerState();
  }
  if (!dynamicState || dynamicState.date !== today) {
    dynamicState = loadDynamicState();
  }

  const stratKey = (tradeDetails && tradeDetails.strategy) ? getStratKey(tradeDetails.strategy) : null;
  const recKey = stratKey ? `${stratKey}_${symbol}` : symbol;

  if (!circuitBreakerState.symbols) circuitBreakerState.symbols = {};
  if (!circuitBreakerState.symbols[recKey]) {
    circuitBreakerState.symbols[recKey] = {
      symbol,
      strategy: stratKey || 'ALL',
      consecutiveLosses: 0,
      dailyLosses: 0,
      consecutiveWins: 0,
      isWinLocked: false,
      pauseUntil: 0,
      paperConsecutiveLosses: 0,
      paperDailyLosses: 0,
      paperConsecutiveWins: 0,
      isPaperWinLocked: false,
      paperPauseUntil: 0
    };
  }

  const rec = circuitBreakerState.symbols[recKey];
  const now = Date.now();
  const maxDaily = config.CIRCUIT_BREAKER.MAX_DAILY_LOSSES_PER_SYMBOL || 2;
  const postWinMins = config.CIRCUIT_BREAKER.POST_WIN_PAUSE_MINS || 60;
  const tier1Mins = config.CIRCUIT_BREAKER.TIER_1_PAUSE_MINS || 60;

  // 🛡️ Same-Zone Trap Armor: Store the failed price band on any loss
  if (outcome === 'LOSS' && tradeDetails && tradeDetails.entryPrice) {
    const entryPrice = parseFloat(tradeDetails.entryPrice);
    const stopLoss = parseFloat(tradeDetails.stopLoss || entryPrice);
    const slDist = Math.abs(entryPrice - stopLoss);
    const zoneBuffer = (slDist > 0 && !isNaN(slDist) ? slDist : 10) * 1.5;
    rec.trapZone = {
      failedPrice: entryPrice,
      zoneMin: entryPrice - zoneBuffer,
      zoneMax: entryPrice + zoneBuffer,
      direction: tradeDetails.direction || (tradeDetails.type === 'bullish' ? 'BUY' : 'SELL'),
      failedAt: now,
      expiresAt: now + (60 * 60 * 1000) // 60 minutes
    };
    console.log(`[TRAP SHIELD] ${symbol}: Activated Same-Zone Lockout around ${entryPrice.toFixed(2)} [${rec.trapZone.zoneMin.toFixed(2)} - ${rec.trapZone.zoneMax.toFixed(2)}] for 60m`);
  } else if (outcome === 'WIN') {
    rec.trapZone = null; // Clear trap zone immediately on win
  }

  if (isPaper) {
    // ── 🔬 PAPER SANDBOX CIRCUIT BREAKER (Strategy 5B & Incubation) ──
    // 🛡️ DUAL-ENGINE DEDUPLICATION:
    // If 5B and 6 Pro both took paper trades on the same market setup, do not count the outcome twice!
    const setupEpoch = tradeDetails && (tradeDetails.candleEpoch || 0);
    const triggerTime = tradeDetails && (tradeDetails.triggeredTime || 0);

    const isSameEpoch = setupEpoch && rec.lastPaperOutcomeEpoch && setupEpoch === rec.lastPaperOutcomeEpoch;
    const isSameTriggerWindow = triggerTime && rec.lastPaperOutcomeTriggerTime && Math.abs(triggerTime - rec.lastPaperOutcomeTriggerTime) < 15 * 60 * 1000;
    const isInstantCloseDup = rec.lastPaperOutcomeClosedAt && (now - rec.lastPaperOutcomeClosedAt < 5 * 60 * 1000);

    if (isSameEpoch || isSameTriggerWindow || isInstantCloseDup) {
      console.log(`[CIRCUIT BREAKER] 🛡️ Ignored duplicate dual-engine paper ${outcome} for ${symbol} circuit breaker. Already recorded for this setup.`);
      return;
    }

    rec.lastPaperOutcomeEpoch = setupEpoch;
    rec.lastPaperOutcomeTriggerTime = triggerTime;
    rec.lastPaperOutcomeClosedAt = now;

    if (outcome === 'WIN') {
      rec.paperConsecutiveLosses = 0;
      rec.paperConsecutiveWins = (rec.paperConsecutiveWins || 0) + 1;
      const stratName = (tradeDetails && tradeDetails.strategy) ? tradeDetails.strategy : 'Strategy Sandbox';
      rec.lastPaperStrat = (stratName.includes('SMC') || stratName.includes('Sweep')) ? 'Strategy SMC' : (stratName.includes('5B') ? '5B Pro' : stratName);
      const maxWinsPerSymbol = config.CIRCUIT_BREAKER.MAX_CONSECUTIVE_WINS_PER_SYMBOL || 2;
      const winLockMins = config.CIRCUIT_BREAKER.SYMBOL_WIN_LOCK_MINS || 90;
      if (rec.paperConsecutiveWins >= maxWinsPerSymbol) {
        rec.paperPauseUntil = Math.max(rec.paperPauseUntil || 0, now + (winLockMins * 60 * 1000));
        rec.isPaperWinLocked = true;
      } else {
        rec.paperPauseUntil = Math.max(rec.paperPauseUntil || 0, now + (postWinMins * 60 * 1000));
      }
    } else if (outcome === 'LOSS') {
      rec.paperConsecutiveWins = 0;
      rec.isPaperWinLocked = false;
      rec.paperConsecutiveLosses = (rec.paperConsecutiveLosses || 0) + 1;
      rec.paperDailyLosses = (rec.paperDailyLosses || 0) + 1;
      const stratName = (tradeDetails && tradeDetails.strategy) ? tradeDetails.strategy : 'Strategy Sandbox';
      rec.lastPaperStrat = (stratName.includes('SMC') || stratName.includes('Sweep')) ? 'Strategy SMC' : (stratName.includes('5B') ? '5B Pro' : stratName);

      if (rec.paperDailyLosses >= maxDaily || rec.paperConsecutiveLosses >= 2) {
        const endOfDay = new Date();
        endOfDay.setUTCHours(23, 59, 59, 999);
        rec.paperPauseUntil = endOfDay.getTime();
        const triggerReason = rec.paperConsecutiveLosses >= 2
          ? `2 consecutive paper losses (${rec.paperDailyLosses} total today)`
          : `${rec.paperDailyLosses} paper losses today`;
        sendTelegramMessage([
          `🛑 🛡️ <b>[SYMBOL DAILY LOSS LIMIT REACHED — PAPER SANDBOX]</b>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].name : symbol})`,
          `<b>Trigger:</b> <code>${triggerReason}</code> (Strategy Sandbox).`,
          `<b>Action:</b> Paper forward tests paused on <b>${symbol}</b> until <b>12:00 AM UTC</b>.`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `👑 <i>Live trading on healthy pairs remains independent & scanning.</i>`
        ].join('\n')).catch(() => null);
      } else {
        rec.paperPauseUntil = Math.max(rec.paperPauseUntil || 0, now + (tier1Mins * 60 * 1000));
      }
    }
  } else {
    // ── 👑 LIVE REAL TRADING CIRCUIT BREAKER (Strategy SMC / 5B Pro Independent) ──
    const stratName = (tradeDetails && tradeDetails.strategy) ? tradeDetails.strategy : 'Strategy 5B Pro';
    rec.lastLiveStrat = (stratName.includes('SMC') || stratName.includes('Sweep')) ? 'Strategy SMC' : (stratName.includes('5B') ? '5B Pro' : stratName);

    if (outcome === 'WIN') {
      rec.consecutiveLosses = 0;
      rec.consecutiveWins = (rec.consecutiveWins || 0) + 1;

      const maxWinsPerSymbol = config.CIRCUIT_BREAKER.MAX_CONSECUTIVE_WINS_PER_SYMBOL || 2;
      const winLockMins = config.CIRCUIT_BREAKER.SYMBOL_WIN_LOCK_MINS || 90;

      if (rec.consecutiveWins >= maxWinsPerSymbol) {
        rec.pauseUntil = Math.max(rec.pauseUntil || 0, now + (winLockMins * 60 * 1000));
        rec.isWinLocked = true;
        const lockHours = (winLockMins / 60).toFixed(winLockMins % 60 === 0 ? 0 : 1);
        sendTelegramMessage([
          `🏆 🛡️ <b>[SYMBOL PROFIT LOCK ACTIVATED — ${rec.lastLiveStrat.toUpperCase()}]</b>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].name : symbol})`,
          `<b>Engine:</b> <code>${rec.lastLiveStrat}</code>`,
          `<b>Trigger:</b> <code>${rec.consecutiveWins} consecutive wins</code> banked today (+${(rec.consecutiveWins * 1.3).toFixed(1)}R).`,
          `<b>Action:</b> Live trading paused on <b>${symbol}</b> for <b>${rec.lastLiveStrat}</b> for <b>${winLockMins} minutes (${lockHours}h)</b> to lock in gains.`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `👑 <i>Remaining healthy pairs and other engines continue scanning normally.</i>`
        ].join('\n')).catch(() => null);
      } else {
        rec.pauseUntil = Math.max(rec.pauseUntil || 0, now + (postWinMins * 60 * 1000));
      }
    } else if (outcome === 'LOSS') {
      rec.consecutiveWins = 0;
      rec.isWinLocked = false;
      rec.consecutiveLosses = (rec.consecutiveLosses || 0) + 1;
      rec.dailyLosses = (rec.dailyLosses || 0) + 1;

      if (rec.dailyLosses >= maxDaily || rec.consecutiveLosses >= 2) {
        const endOfDay = new Date();
        endOfDay.setUTCHours(23, 59, 59, 999);
        rec.pauseUntil = endOfDay.getTime();
        const triggerReason = rec.consecutiveLosses >= 2
          ? `2 consecutive live losses (${rec.dailyLosses} total today)`
          : `${rec.dailyLosses} live losses today`;
        sendTelegramMessage([
          `🛑 🛡️ <b>[SYMBOL DAILY LOSS LIMIT REACHED — ${rec.lastLiveStrat.toUpperCase()}]</b>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].name : symbol})`,
          `<b>Engine:</b> <code>${rec.lastLiveStrat}</code>`,
          `<b>Trigger:</b> <code>${triggerReason}</code>.`,
          `<b>Action:</b> Live trading paused on <b>${symbol}</b> for <b>${rec.lastLiveStrat}</b> until <b>12:00 AM UTC</b> to protect performance.`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `<i>Remaining healthy pairs and other engines continue scanning normally.</i>`
        ].join('\n')).catch(() => null);
      } else {
        rec.pauseUntil = Math.max(rec.pauseUntil || 0, now + (tier1Mins * 60 * 1000));
      }
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

  recordSymbolTradeOutcome(symbol, outcome, false, trade);
  await updatePairHealthOnLiveClose(symbol, outcome, trade.strategy);
  await recordTradeOutcomeToDesk(trade.strategy, outcome, pnlUSD, pnlR);
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
  const activePct = dynamicState.customRiskPercent || config.RISK_PERCENT || 3.0;
  const compRisk = getWeeklyCompoundedRisk(activePct);
  const standardRiskUSD = compRisk.riskUSD;

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

  const maxLossLimit = dynamicState.maxLossMultiplier || 3;

  // 1. Independent Desk 5B check (Live trades only)
  if (dynamicState.desk5b && !dynamicState.desk5b.lossLocked) {
    const d5b = dynamicState.desk5b;
    const is5bBreached = (d5b.maxLossUSD && d5b.netUSD <= -d5b.maxLossUSD) ||
                         ((d5b.losses || 0) >= maxLossLimit);
    if (is5bBreached) {
      d5b.lossLocked = true;
      saveDynamicState(dynamicState);
      const msg = [
        `🛑 🔒 <b>[STRATEGY 5B PRO — DAILY MAX LOSS REACHED]</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `💸 <b>Desk Net Loss:</b> <code>-$${Math.abs(d5b.netUSD || 0).toFixed(2)} USD (${d5b.losses || 0} Live Losses)</code>`,
        `🛑 <b>Max Loss Floor:</b> <code>-$${(d5b.maxLossUSD || 698.79).toFixed(2)} USD (${maxLossLimit} Losses Cap)</code>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `🛡️ <b>Action:</b> <i>Live trading halted for Strategy 5B Pro until midnight UTC to protect capital.</i>`
      ].join('\n');
      await sendTelegramMessage(msg);
      console.log(`\n🛑 [DESK 5B LOSS LOCKED] Strategy 5B Pro reached daily max loss limit. Halted for today.\n`);
    }
  }

  // 2. Independent Desk SMC check (Live trades only)
  if (dynamicState.deskSMC && !dynamicState.deskSMC.lossLocked) {
    const dSmc = dynamicState.deskSMC;
    const isSmcBreached = (dSmc.maxLossUSD && dSmc.netUSD <= -dSmc.maxLossUSD) ||
                          ((dSmc.losses || 0) >= maxLossLimit);
    if (isSmcBreached) {
      dSmc.lossLocked = true;
      saveDynamicState(dynamicState);
      const msg = [
        `🛑 🔒 <b>[STRATEGY SMC — DAILY MAX LOSS REACHED]</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `💸 <b>Desk Net Loss:</b> <code>-$${Math.abs(dSmc.netUSD || 0).toFixed(2)} USD (${dSmc.losses || 0} Live Losses)</code>`,
        `🛑 <b>Max Loss Floor:</b> <code>-$${(dSmc.maxLossUSD || 698.79).toFixed(2)} USD (${maxLossLimit} Losses Cap)</code>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `🛡️ <b>Action:</b> <i>Live trading halted for Strategy SMC until midnight UTC to protect capital.</i>`
      ].join('\n');
      await sendTelegramMessage(msg);
      console.log(`\n🛑 [DESK SMC LOSS LOCKED] Strategy SMC reached daily max loss limit. Halted for today.\n`);
    }
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

    // Check pair cooldowns & lockouts
    const cooldowns = [];
    if (circuitBreakerState && circuitBreakerState.symbols) {
      for (const [sym, rec] of Object.entries(circuitBreakerState.symbols)) {
        const isLiveLocked = (rec.dailyLosses || 0) >= (config.CIRCUIT_BREAKER.MAX_DAILY_LOSSES_PER_SYMBOL || 2) || (rec.consecutiveLosses || 0) >= 2;
        const isPaperLocked = (rec.paperDailyLosses || 0) >= (config.CIRCUIT_BREAKER.MAX_DAILY_LOSSES_PER_SYMBOL || 2) || (rec.paperConsecutiveLosses || 0) >= 2;

        const paperStratTag = ` (${rec.lastPaperStrat || 'Strategy SMC'})`;
        const liveStratTag = ` (${rec.lastLiveStrat || '5B Pro'})`;

        const displaySym = sym.replace(/^(5B|SMC)_/, '');

        if (isLiveLocked) {
          const reason = (rec.consecutiveLosses || 0) >= 2 ? `${rec.consecutiveLosses} consecutive` : `${rec.dailyLosses} daily`;
          cooldowns.push(`• <code>${displaySym}</code>: 🛑 <b>LIVE LOCKED FOR TODAY${liveStratTag}</b> (${reason} losses hit — halts until 12 AM UTC)`);
        } else if (rec.pauseUntil && now < rec.pauseUntil) {
          const rem = Math.ceil((rec.pauseUntil - now) / 60000);
          if (rec.isWinLocked) {
            cooldowns.push(`• <code>${displaySym}</code>: 🏆 <b>2-WIN PROFIT LOCK${liveStratTag}</b> (${rem}m left — banked ${rec.consecutiveWins || 2} wins)`);
          } else {
            cooldowns.push(`• <code>${displaySym}</code>: ⏳ Live${liveStratTag} ${rem}m cooldown (${rec.dailyLosses || 0} loss today)`);
          }
        }

        if (isPaperLocked) {
          const reason = (rec.paperConsecutiveLosses || 0) >= 2 ? `${rec.paperConsecutiveLosses} consecutive` : `${rec.paperDailyLosses} daily`;
          cooldowns.push(`• <code>${displaySym}</code>: 🔬 <b>PAPER LOCKED FOR TODAY${paperStratTag}</b> (${reason} paper losses hit)`);
        } else if (rec.paperPauseUntil && now < rec.paperPauseUntil) {
          const rem = Math.ceil((rec.paperPauseUntil - now) / 60000);
          if (rec.isPaperWinLocked) {
            cooldowns.push(`• <code>${displaySym}</code>: 🔬 🏆 <b>PAPER 2-WIN PROFIT LOCK${paperStratTag}</b> (${rem}m left)`);
          } else {
            cooldowns.push(`• <code>${displaySym}</code>: 🔬 Paper${paperStratTag} ${rem}m cooldown (${rec.paperDailyLosses || 0} loss today)`);
          }
        }

        if (rec.trapZone && now < rec.trapZone.expiresAt) {
          const rem = Math.ceil((rec.trapZone.expiresAt - now) / 60000);
          cooldowns.push(`• <code>${displaySym}</code>: 🛡️ Trap Armor [${rec.trapZone.zoneMin.toFixed(2)} - ${rec.trapZone.zoneMax.toFixed(2)}] (${rem}m left)`);
        }
      }
    }

    let stateBadge = '🟢 <b>ACTIVE & SCANNING</b>';
    const is5bInPause = dynamicState.desk5b && dynamicState.desk5b.pauseUntil && now < dynamicState.desk5b.pauseUntil;
    const isSmcInPause = dynamicState.deskSMC && dynamicState.deskSMC.pauseUntil && now < dynamicState.deskSMC.pauseUntil;

    if (dynamicState.isManuallyPaused) stateBadge = '⏸️ <b>MANUALLY PAUSED (/resume to restart)</b>';
    else if (dynamicState.dailyTargetLocked) stateBadge = '🎯 <b>DAILY TARGET LOCKED (Resumes 12 AM)</b>';
    else if (dynamicState.dailyLossLocked) stateBadge = '🛑 <b>DAILY MAX LOSS LOCKED (Resumes 12 AM)</b>';
    else if (is5bInPause && isSmcInPause) {
      const rem = Math.max(Math.ceil((dynamicState.desk5b.pauseUntil - now) / 60000), Math.ceil((dynamicState.deskSMC.pauseUntil - now) / 60000));
      stateBadge = `⚠️ <b>BOTH DESKS IN COOLDOWN (${rem}m remaining)</b>`;
    } else if (is5bInPause) {
      const rem = Math.ceil((dynamicState.desk5b.pauseUntil - now) / 60000);
      stateBadge = `⚠️ <b>5B PRO COOLDOWN (${rem}m) | SMC ACTIVE</b>`;
    } else if (isSmcInPause) {
      const rem = Math.ceil((dynamicState.deskSMC.pauseUntil - now) / 60000);
      stateBadge = `⚠️ <b>SMC COOLDOWN (${rem}m) | 5B PRO ACTIVE</b>`;
    }

    const pnlSign = report.netUSD >= 0 ? '+' : '-';
    const targetStatus = (dynamicState.dailyTargetUSD && dynamicState.dailyTargetUSD > 0)
      ? `$${dynamicState.dailyTargetUSD.toFixed(2)} USD ${dynamicState.dailyTargetLocked ? '🔒 (HIT)' : `(Need: $${Math.max(0, dynamicState.dailyTargetUSD - report.netUSD).toFixed(2)})`}`
      : 'Disabled (Full Session)';

    const maxLossStatus = (dynamicState.dailyMaxLossUSD && dynamicState.dailyMaxLossUSD > 0)
      ? `-$${dynamicState.dailyMaxLossUSD.toFixed(2)} USD ${dynamicState.dailyLossLocked ? '🛑 (HIT)' : `(Remaining Buffer: $${Math.max(0, dynamicState.dailyMaxLossUSD + report.netUSD).toFixed(2)})`}`
      : 'Disabled (No Floor)';

    const isTriEngine = dynamicState.activeStrategy === 'TRI_ENGINE' || dynamicState.activeStrategy === 'ALL';
    const isBoth = dynamicState.activeStrategy === 'BOTH';
    const isGlobalPaper = dynamicState.executionMode === 'PAPER';

    const liveTradesCount = activeTrades.filter(t => !t.isIncubation).length;
    const paperTradesCount = activeTrades.filter(t => t.isIncubation).length;
    const maxLiveLimit = config.MAX_CONCURRENT_LIVE_TRADES || 3;
    const posLabel = paperTradesCount > 0 
      ? `${liveTradesCount}/${maxLiveLimit} Live | ${paperTradesCount} Paper`
      : `${liveTradesCount}/${maxLiveLimit} Live Trade(s)`;

    let lines = [];

    if (dynamicState.desk5b && dynamicState.deskSMC) {
      const d5b = dynamicState.desk5b;
      const dSmc = dynamicState.deskSMC;
      const d5bSign = d5b.netUSD >= 0 ? '+' : '-';
      const dSmcSign = dSmc.netUSD >= 0 ? '+' : '-';
      const d5bTargetStatus = d5b.targetLocked ? '🎯 🔒 (HIT)' : `(Need: +$${Math.max(0, d5b.targetUSD - d5b.netUSD).toFixed(2)})`;
      const d5bLossStatus = d5b.lossLocked ? '🛑 🔒 (HIT)' : `(Buffer: $${Math.max(0, d5b.maxLossUSD + d5b.netUSD).toFixed(2)})`;
      const dSmcTargetStatus = dSmc.targetLocked ? '🎯 🔒 (HIT)' : `(Need: +$${Math.max(0, dSmc.targetUSD - dSmc.netUSD).toFixed(2)})`;
      const dSmcLossStatus = dSmc.lossLocked ? '🛑 🔒 (HIT)' : `(Buffer: $${Math.max(0, dSmc.maxLossUSD + dSmc.netUSD).toFixed(2)})`;

      const mode5bLabel = dynamicState.is5bPaused ? '⏸️ PAUSED' : (isGlobalPaper || dynamicState.mode5b === 'PAPER' ? '🔬 PAPER' : '🟢 LIVE');
      const modeSmcLabel = dynamicState.is6proPaused ? '⏸️ PAUSED' : (isGlobalPaper || dynamicState.mode6pro === 'PAPER' ? '🔬 PAPER' : '🟢 LIVE');

      const master = dynamicState.masterAccount || { maxDailyLossUSD: 1397.58, dailyLossLocked: false };
      const combinedUSD = (d5b.netUSD || 0) + (dSmc.netUSD || 0);
      const combinedR = (d5b.netR || 0) + (dSmc.netR || 0);
      const combinedSign = combinedUSD >= 0 ? '+' : '-';
      const combinedWins = (d5b.wins || 0) + (dSmc.wins || 0);
      const combinedLosses = (d5b.losses || 0) + (dSmc.losses || 0);
      const combinedTotal = combinedWins + combinedLosses;
      const combinedWR = combinedTotal > 0 ? ((combinedWins / combinedTotal) * 100).toFixed(1) : '0.0';

      lines = [
        `👑 <b>[MYTRADA DUAL-DESK LIVE DASHBOARD]</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `💵 <b>Total Account Equity:</b> <code>$${(report.newBalance || compRisk.liveBalance || 15528.46).toFixed(2)} USD</code>`,
        `💰 <b>Desk Allocation (50/50):</b> <code>$${(compRisk.effectiveDeskBalance || 7764.23).toFixed(2)} USD each</code>`,
        `🛡️ <b>Single Trade Risk:</b> <code>$${compRisk.riskUSD.toFixed(2)} USD (1.5% Equity / 3.0% Desk)</code>`,
        `🎯 <b>Single Trade Reward:</b> <code>+$${compRisk.rewardUSD.toFixed(2)} USD (+1.3R Target)</code>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `🚀 <b>DESK 1: STRATEGY 5B PRO</b> (${mode5bLabel})`,
        `  ├ <b>Realized Today:</b> <code>${d5bSign}$${Math.abs(d5b.netUSD).toFixed(2)} USD (${d5bSign}${d5b.netR.toFixed(1)}R • ${d5b.wins || 0}W / ${d5b.losses || 0}L)</code>`,
        `  ├ <b>Daily Target:</b> <code>+$${(d5b.targetUSD || 908.43).toFixed(2)} USD ${d5bTargetStatus}</code>`,
        `  └ <b>Daily Loss Floor:</b> <code>-$${(d5b.maxLossUSD || 698.79).toFixed(2)} USD ${d5bLossStatus}</code>`,
        ``,
        `🔬 <b>DESK 2: STRATEGY SMC</b> (${modeSmcLabel})`,
        `  ├ <b>Realized Today:</b> <code>${dSmcSign}$${Math.abs(dSmc.netUSD).toFixed(2)} USD (${dSmcSign}${dSmc.netR.toFixed(1)}R • ${dSmc.wins || 0}W / ${dSmc.losses || 0}L)</code>`,
        `  ├ <b>Daily Target:</b> <code>+$${(dSmc.targetUSD || 908.43).toFixed(2)} USD ${dSmcTargetStatus}</code>`,
        `  └ <b>Daily Loss Floor:</b> <code>-$${(dSmc.maxLossUSD || 698.79).toFixed(2)} USD ${dSmcLossStatus}</code>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `📈 <b>COMBINED PERFORMANCE TODAY:</b>`,
        `  ├ <b>Total PnL:</b> <code>${combinedSign}$${Math.abs(combinedUSD).toFixed(2)} USD (${combinedSign}${combinedR.toFixed(1)}R • ${combinedWins}W / ${combinedLosses}L • ${combinedWR}% WR)</code>`,
        `  └ <b>Master Emergency Valve:</b> <code>-$${master.maxDailyLossUSD.toFixed(2)} USD ${master.dailyLossLocked ? '🛑 LOCKED' : '(🟢 Healthy)'}</code>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `🧠 <b>GodEyes Memory Brain:</b> 🟢 <b>ACTIVE (SMC Premium/Discount Armor)</b>`,
        `📂 <b>Active Positions:</b> <code>${posLabel}</code>`
      ];
    } else {
      let stratBadge = '🟡 <b>STANDBY (Awaiting /strategy command)</b>';
      if (dynamicState.activeStrategy === 'BOTH') {
        const mode5bLabel = dynamicState.is5bPaused ? '⏸️ PAUSED' : (isGlobalPaper || dynamicState.mode5b === 'PAPER' ? '🔬 PAPER' : '🟢 LIVE');
        const modeSmcLabel = dynamicState.is6proPaused ? '⏸️ PAUSED' : (isGlobalPaper || dynamicState.mode6pro === 'PAPER' ? '🔬 PAPER' : '🟢 LIVE');
        stratBadge = `⚡ <b>DUAL-ENGINE SUITE</b> (5B Pro: ${mode5bLabel} | SMC: ${modeSmcLabel})`;
      } else if (dynamicState.activeStrategy === 'STRATEGY_6_PRO') {
        const modeSmcLabel = dynamicState.is6proPaused ? '⏸️ PAUSED' : (dynamicState.mode6pro === 'LIVE' ? '🟢 LIVE' : '🔬 PAPER');
        stratBadge = `🔬 <b>Strategy SMC</b> (${modeSmcLabel})`;
      } else if (dynamicState.activeStrategy === 'STRATEGY_5B') {
        const mode5bLabel = dynamicState.is5bPaused ? '⏸️ PAUSED' : (dynamicState.executionMode === 'PAPER' ? '🔬 PAPER' : '🟢 LIVE');
        stratBadge = `🚀 <b>Strategy 5B Pro</b> (${mode5bLabel})`;
      }

      lines = [
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
        `🧠 <b>GodEyes Memory Brain:</b> 🟢 <b>ACTIVE (True SMC Premium/Discount Armor)</b>`,
        `📂 <b>Active Positions:</b> <code>${posLabel}</code>`
      ];
    }

    if (activeTrades.length > 0) {
      for (const t of activeTrades) {
        const stratName = t.strategy ? (t.strategy.includes('Strategy 6') ? 'Strategy 6' : ((t.strategy.includes('SMC') || t.strategy.includes('Sweep')) ? 'Strategy SMC' : (t.strategy.includes('5B') ? '5B Pro' : t.strategy))) : (t.isIncubation ? 'Paper Sandbox' : '5B Pro');
        const modeBadge = t.isIncubation ? '🔬 Paper' : '⚡ Live';
        const dirLabel = t.type === 'bullish' ? '🟢 BUY' : '🔴 SELL';
        lines.push(`   └ <code>${t.symbol}</code>: ${modeBadge} (<b>${stratName}</b>) ${dirLabel} @ <code>${t.entryPrice.toFixed(2)}</code>`);
      }
    }

    lines.push(`<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`);
    lines.push(`🤖 <b>Engine State:</b> ${stateBadge}`);

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
      const stratName = t.strategy ? (t.strategy.includes('Strategy 6') ? 'Strategy 6' : ((t.strategy.includes('SMC') || t.strategy.includes('Sweep')) ? 'Strategy SMC' : (t.strategy.includes('5B') ? 'Strategy 5B Pro' : t.strategy))) : (t.isIncubation ? 'Strategy SMC' : 'Strategy 5B Pro');
      const modeTag = t.isIncubation ? '🔬 [PAPER SANDBOX]' : '⚡ [LIVE REAL MONEY]';

      let statusTag = t.isBreakeven ? ' 🛡️ [BREAKEVEN]' : '';
      lines.push(`<b>${t.symbol}</b> (${symName})${statusTag} — ${modeTag}`);
      lines.push(`• <b>Strategy:</b> <code>${stratName}</code>`);
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

  lockDailyProfit: async (targetDesk = 'all') => {
    const t = String(targetDesk || 'all').toLowerCase();
    if (t.includes('5b')) {
      if (dynamicState.desk5b) dynamicState.desk5b.targetLocked = true;
    } else if (t.includes('smc') || t.includes('sweep') || t.includes('6pro') || t.includes('6')) {
      if (dynamicState.deskSMC) dynamicState.deskSMC.targetLocked = true;
    } else {
      if (dynamicState.desk5b) dynamicState.desk5b.targetLocked = true;
      if (dynamicState.deskSMC) dynamicState.deskSMC.targetLocked = true;
      dynamicState.dailyTargetLocked = true;
      await closeAllTradesManually();
    }
    saveDynamicState(dynamicState);
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
    dynamicState.is5bPaused = false;
    dynamicState.is6proPaused = false;
    dynamicState.dailyTargetLocked = false;
    dynamicState.dailyLossLocked = false;
    if (dynamicState.desk5b) {
      dynamicState.desk5b.targetLocked = false;
      dynamicState.desk5b.lossLocked = false;
      dynamicState.desk5b.isPaused = false;
      dynamicState.desk5b.consecutiveLosses = 0;
      dynamicState.desk5b.pauseUntil = 0;
    }
    if (dynamicState.deskSMC) {
      dynamicState.deskSMC.targetLocked = false;
      dynamicState.deskSMC.lossLocked = false;
      dynamicState.deskSMC.isPaused = false;
      dynamicState.deskSMC.consecutiveLosses = 0;
      dynamicState.deskSMC.pauseUntil = 0;
    }
    if (dynamicState.masterAccount) {
      dynamicState.masterAccount.dailyLossLocked = false;
    }
    dynamicState.portfolioPauseUntil = 0;
    dynamicState.portfolioConsecutiveLosses = 0;

    const today = getLocalDateStr();
    if (!circuitBreakerState || circuitBreakerState.date !== today) {
      circuitBreakerState = loadCircuitBreakerState();
    }

    // Unpause symbols that have not breached their limit,
    // but PRESERVE dailyLosses and keep symbols with >= MAX_DAILY_LOSSES or >= 2 consecutive losses halted for the day!
    const maxLosses = config.CIRCUIT_BREAKER.MAX_DAILY_LOSSES_PER_SYMBOL || 2;
    if (circuitBreakerState.symbols) {
      for (const sym of Object.keys(circuitBreakerState.symbols)) {
        const rec = circuitBreakerState.symbols[sym];
        // Live side
        if ((rec.dailyLosses || 0) < maxLosses && (rec.consecutiveLosses || 0) < 2) {
          rec.pauseUntil = 0;
          rec.consecutiveLosses = 0;
          rec.isWinLocked = false;
        } else {
          const endOfDay = new Date();
          endOfDay.setUTCHours(23, 59, 59, 999);
          rec.pauseUntil = endOfDay.getTime();
        }

        // Paper side
        if ((rec.paperDailyLosses || 0) < maxLosses && (rec.paperConsecutiveLosses || 0) < 2) {
          rec.paperPauseUntil = 0;
          rec.paperConsecutiveLosses = 0;
        } else {
          const endOfDay = new Date();
          endOfDay.setUTCHours(23, 59, 59, 999);
          rec.paperPauseUntil = endOfDay.getTime();
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
    const targets = calculateAutoDailyTargets(pct, dynamicState.targetWinsMultiplier, dynamicState.maxLossMultiplier);
    if (config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.AUTO_TARGET_ENABLED !== false) {
      dynamicState.dailyTargetUSD = targets.dailyTargetUSD;
      dynamicState.dailyMaxLossUSD = targets.dailyMaxLossUSD;
    }
    saveDynamicState(dynamicState);
    return targets;
  },

  setAutoTargets: async (wins, losses = null) => {
    const numWins = parseFloat(wins);
    const numLosses = (losses !== null && losses !== undefined) ? parseFloat(losses) : numWins;
    if (!isNaN(numWins) && numWins > 0) dynamicState.targetWinsMultiplier = numWins;
    if (!isNaN(numLosses) && numLosses > 0) dynamicState.maxLossMultiplier = numLosses;

    const targets = calculateAutoDailyTargets(
      dynamicState.customRiskPercent,
      dynamicState.targetWinsMultiplier,
      dynamicState.maxLossMultiplier
    );

    dynamicState.dailyTargetUSD = targets.dailyTargetUSD;
    dynamicState.dailyTargetLocked = false;
    dynamicState.dailyMaxLossUSD = targets.dailyMaxLossUSD;
    dynamicState.dailyLossLocked = false;

    saveDynamicState(dynamicState);
    return targets;
  },

  getAutoTargets: () => {
    return calculateAutoDailyTargets(
      dynamicState.customRiskPercent,
      dynamicState.targetWinsMultiplier,
      dynamicState.maxLossMultiplier
    );
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
    dynamicState.isManuallyPaused = false;
    dynamicState.is5bPaused = false;
    dynamicState.is6proPaused = false;
    if (strat === 'BOTH') {
      dynamicState.mode5b = 'LIVE';
      dynamicState.mode6pro = 'LIVE';
      dynamicState.executionMode = 'LIVE';
      dynamicState.balanceAllocation = 0.50;
    } else if (strat === 'STRATEGY_6_PRO') {
      dynamicState.mode6pro = 'LIVE';
      dynamicState.executionMode = 'LIVE';
    } else if (strat === 'STRATEGY_5B') {
      dynamicState.mode5b = 'LIVE';
      dynamicState.executionMode = 'LIVE';
    }
    saveDynamicState(dynamicState);
  },

  resetToday: (targetBalance = 5114.16) => {
    const { resetTodayState } = require('./reconcileTodayReset');
    const todayStr = getLocalDateStr();
    resetTodayState(targetBalance, todayStr);
    dynamicState = loadDynamicState();
    circuitBreakerState = loadCircuitBreakerState();
    const report = generateDailyReport(todayStr);
    return {
      startingBalance: report.startingBalance,
      tradesCount: report.closedCount,
      mode5b: dynamicState.mode5b,
      mode6pro: dynamicState.mode6pro,
      target: dynamicState.dailyTargetUSD,
      maxLoss: dynamicState.dailyMaxLossUSD
    };
  },

  pauseStrategy: (strat) => {
    const s = String(strat || '').toLowerCase();
    if (s.includes('5b')) {
      dynamicState.is5bPaused = true;
      if (dynamicState.desk5b) dynamicState.desk5b.isPaused = true;
    }
    if (s.includes('smc') || s.includes('sweep') || s.includes('6pro') || s.includes('6')) {
      dynamicState.is6proPaused = true;
      if (dynamicState.deskSMC) dynamicState.deskSMC.isPaused = true;
    }
    saveDynamicState(dynamicState);
  },

  resumeStrategy: (strat) => {
    const s = String(strat || '').toLowerCase();
    if (s.includes('5b')) {
      dynamicState.is5bPaused = false;
      if (dynamicState.desk5b) {
        dynamicState.desk5b.isPaused = false;
        dynamicState.desk5b.targetLocked = false;
        dynamicState.desk5b.lossLocked = false;
      }
    }
    if (s.includes('smc') || s.includes('sweep') || s.includes('6pro') || s.includes('6')) {
      dynamicState.is6proPaused = false;
      if (dynamicState.deskSMC) {
        dynamicState.deskSMC.isPaused = false;
        dynamicState.deskSMC.targetLocked = false;
        dynamicState.deskSMC.lossLocked = false;
      }
    }
    dynamicState.isManuallyPaused = false; // 👑 Unpause global engine so scanning resumes
    if (dynamicState.activeStrategy === 'NONE') {
      dynamicState.activeStrategy = s.includes('5b') ? 'STRATEGY_5B' : 'STRATEGY_6_PRO';
    }
    saveDynamicState(dynamicState);
  },

  setStrategyMode: (strat, mode) => {
    const s = String(strat || '').toLowerCase();
    if (s.includes('5b')) dynamicState.mode5b = mode;
    if (s.includes('smc') || s.includes('sweep') || s.includes('6pro') || s.includes('6')) dynamicState.mode6pro = mode;
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

  getWeeklyReport: (refDate = null) => {
    const report = generateWeeklyReport(false, refDate);
    return formatReportTelegramHTML(report);
  },

  getTradeExport: (targetDate) => {
    return generateDayTradeExport(targetDate);
  },

  syncLogsToGit: async (targetDate = null) => {
    return await runMidnightGitSync(targetDate || getLocalDateStr());
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

  quarantinePair: (symbol, reason, stratTarget = 'ALL') => {
    return manualSetQuarantine(symbol, true, reason, stratTarget);
  },

  unquarantinePair: (symbol, stratTarget = 'ALL') => {
    return manualSetQuarantine(symbol, false, null, stratTarget);
  },

  promotePair: (symbol) => {
    if (!config.SYMBOLS[symbol]) {
      return { success: false, error: `Symbol ${symbol} not in configured universe.` };
    }
    if (!config.SYMBOLS[symbol].monitorOnly) {
      return { success: false, error: `${symbol} is already an active Live Trading pair!` };
    }
    config.SYMBOLS[symbol].monitorOnly = false;
    const rec = getPairHealth(symbol);
    rec.isQuarantined = false;
    rec.consecutiveLosses = 0;
    rec.consecutivePaperWins = 0;
    rec.quarantineReason = null;
    rec.quarantinedAt = null;
    rec.isPromoted = true;
    rec.graduationAlertSent = false;
    savePairHealthState(pairHealthState);
    return { success: true, name: config.SYMBOLS[symbol].name };
  },

  demotePair: (symbol, reason = 'Demoted back to Incubation Sandbox') => {
    if (!config.SYMBOLS[symbol]) {
      return { success: false, error: `Symbol ${symbol} not in configured universe.` };
    }
    config.SYMBOLS[symbol].monitorOnly = true;
    const rec = getPairHealth(symbol);
    rec.isQuarantined = true;
    rec.quarantineReason = reason;
    rec.quarantinedAt = new Date().toISOString();
    rec.isPromoted = false;
    rec.graduationAlertSent = false;
    savePairHealthState(pairHealthState);
    return { success: true, name: config.SYMBOLS[symbol].name };
  },

  pauseSymbol: (symbol, minutes = 60, target = 'live') => {
    symbol = symbol.toUpperCase();
    if (!config.SYMBOLS[symbol]) {
      return { success: false, error: `Symbol ${symbol} not in configured universe.` };
    }
    const today = getLocalDateStr();
    if (!circuitBreakerState || circuitBreakerState.date !== today) {
      circuitBreakerState = loadCircuitBreakerState();
    }
    if (!circuitBreakerState.symbols) circuitBreakerState.symbols = {};
    if (!circuitBreakerState.symbols[symbol]) {
      circuitBreakerState.symbols[symbol] = {
        consecutiveLosses: 0,
        dailyLosses: 0,
        pauseUntil: 0,
        paperConsecutiveLosses: 0,
        paperDailyLosses: 0,
        paperPauseUntil: 0
      };
    }
    const rec = circuitBreakerState.symbols[symbol];
    const now = Date.now();
    const until = now + (minutes * 60 * 1000);
    const t = (target || 'live').toLowerCase();

    if (t === 'paper' || t === '5b') {
      rec.paperPauseUntil = until;
    } else if (t === 'both' || t === 'all') {
      rec.pauseUntil = until;
      rec.paperPauseUntil = until;
    } else {
      rec.pauseUntil = until;
    }

    saveCircuitBreakerState(circuitBreakerState);
    return { success: true, name: config.SYMBOLS[symbol].name, minutes, until, target: t };
  },

  resumeSymbol: (symbol, target = 'all') => {
    symbol = symbol.toUpperCase();
    if (!config.SYMBOLS[symbol]) {
      return { success: false, error: `Symbol ${symbol} not in configured universe.` };
    }
    const today = getLocalDateStr();
    if (!circuitBreakerState || circuitBreakerState.date !== today) {
      circuitBreakerState = loadCircuitBreakerState();
    }
    if (circuitBreakerState.symbols) {
      if (!circuitBreakerState.symbols[symbol]) {
        circuitBreakerState.symbols[symbol] = {
          consecutiveLosses: 0,
          dailyLosses: 0,
          pauseUntil: 0,
          paperConsecutiveLosses: 0,
          paperDailyLosses: 0,
          paperPauseUntil: 0
        };
      } else {
        const t = (target || 'all').toLowerCase();
        const rec = circuitBreakerState.symbols[symbol];
        rec.trapZone = null;
        if (t === 'paper' || t === '5b') {
          rec.paperPauseUntil = 0;
          rec.paperConsecutiveLosses = 0;
          rec.paperConsecutiveWins = 0;
          rec.isPaperWinLocked = false;
          if (rec.paperDailyLosses >= 2) rec.paperDailyLosses = 1;
        } else if (t === 'live' || t === '6pro') {
          rec.pauseUntil = 0;
          rec.consecutiveLosses = 0;
          rec.consecutiveWins = 0;
          rec.isWinLocked = false;
          if (rec.dailyLosses >= 2) rec.dailyLosses = 1;
        } else {
          rec.pauseUntil = 0;
          rec.consecutiveLosses = 0;
          rec.consecutiveWins = 0;
          rec.isWinLocked = false;
          rec.paperPauseUntil = 0;
          rec.paperConsecutiveLosses = 0;
          rec.paperConsecutiveWins = 0;
          rec.isPaperWinLocked = false;
          if (rec.dailyLosses >= 2) rec.dailyLosses = 1;
          if (rec.paperDailyLosses >= 2) rec.paperDailyLosses = 1;
        }
      }
      saveCircuitBreakerState(circuitBreakerState);
    }
    return { success: true, name: config.SYMBOLS[symbol].name };
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
  const localHour = localNow.getUTCHours();
  const localMinute = localNow.getUTCMinutes();

  // Check if today is Sunday (day 0) within midnight window (12:00 AM - 12:04 AM)
  if (localNow.getUTCDay() === 0) {
    if (localHour !== 0 || localMinute > 4) return;
    const weekYear = `${localNow.getUTCFullYear()}-W${Math.ceil((localNow.getUTCDate() + 6) / 7)}`;
    const lastWeek = getLastReportedWeek();
    if (lastWeek !== weekYear) {
      console.log(`\n📊 [WEEKLY REPORT] Compiling Weekly Performance Report...`);
      const report = generateWeeklyReport(true); // Re-anchor balance at official Sunday rollover
      const reportHtml = formatReportTelegramHTML(report);

      await sendTelegramMessage(reportHtml);
      saveLastReportedWeek(weekYear);
      console.log(`✅ [WEEKLY REPORT] Weekly Performance Report dispatched to Telegram successfully!\n`);

      // Refresh dynamic state with the new weekly anchor balance immediately
      if (dynamicState) {
        const targets = calculateAutoDailyTargets(dynamicState.customRiskPercent, dynamicState.targetWinsMultiplier, dynamicState.maxLossMultiplier);
        dynamicState.dailyTargetUSD = targets.dailyTargetUSD;
        dynamicState.dailyMaxLossUSD = targets.dailyMaxLossUSD;
        saveDynamicState(dynamicState);
        console.log(`🎯 [WEEKLY RE-ANCHOR] Daily Target auto-updated to +$${targets.dailyTargetUSD.toFixed(2)} USD | Max Loss: -$${targets.dailyMaxLossUSD.toFixed(2)} USD\n`);
      }
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
  const activePct = (dynamicState && dynamicState.customRiskPercent && dynamicState.customRiskPercent > 0)
    ? dynamicState.customRiskPercent
    : (config.RISK_PERCENT || 3.0);
  const compRisk = getWeeklyCompoundedRisk(activePct);
  const riskAmount = customRiskUSD !== null ? customRiskUSD : compRisk.riskUSD;
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

// ── ACTIVE TRADE CONCURRENCY & DEDUPLICATION GUARDS ──
const closingTradeSetups = new Set();
const activeSymbolCheckLocks = new Set();

// ── ACTIVE TRADE LIFECYCLE MANAGEMENT (1:1.3 R:R) ──
async function checkActiveTradesForSymbol(symbol, ltfCandles) {
  if (!ltfCandles || ltfCandles.length === 0) return;
  if (activeSymbolCheckLocks.has(symbol)) return;
  activeSymbolCheckLocks.add(symbol);

  try {
    const activeTrades = loadActiveTrades();
    const tradesForSymbol = activeTrades.filter(t => t.symbol === symbol && !closingTradeSetups.has(t.setupId));
    if (tradesForSymbol.length === 0) return;

    const currentLivePrice = ltfCandles[ltfCandles.length - 1].close;
    let updatedTrades = [...activeTrades];
    let changed = false;
    const compRisk = getWeeklyCompoundedRisk();

    for (const trade of tradesForSymbol) {
      if (closingTradeSetups.has(trade.setupId)) continue;
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
        if (closingTradeSetups.has(trade.setupId)) continue;
        closingTradeSetups.add(trade.setupId);

        // 🛡️ Immediately remove from activeTrades on disk so no concurrent loop sees it as open
        updatedTrades = updatedTrades.filter(t => t.setupId !== trade.setupId);
        saveActiveTrades(updatedTrades);
        changed = true;

        recordIncubationOutcome({
          setupId: trade.setupId,
          symbol: trade.symbol,
          type: trade.type,
          entryPrice: trade.entryPrice,
          stopLoss: trade.stopLoss,
          takeProfit: trade.takeProfit,
          exitPrice: trade.takeProfit,
          outcome: 'WIN',
          rMultiple: 1.3,
          pnlUSD: compRisk.rewardUSD,
          strategy: trade.strategy || 'Strategy 5B Pro'
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

        await updatePairHealthOnPaperClose(symbol, 'WIN', trade);
        recordSymbolTradeOutcome(symbol, 'WIN', true, trade);

        const isMonitorOnly = config.SYMBOLS[symbol] && config.SYMBOLS[symbol].monitorOnly;
        const stratName = trade.strategy || 'Paper Sandbox';
        const bannerTitle = isMonitorOnly 
          ? `[MYTRADA INCUBATION OUTCOME — TP HIT (+1.3R)]`
          : `[MYTRADA PAPER OUTCOME — ${stratName.toUpperCase()} — TP HIT (+1.3R)]`;

        const tpAlert = [
          `🔬 🟢 <b>${bannerTitle}</b>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].name : symbol})`,
          `<b>Strategy:</b> <code>${stratName}</code>`,
          `<b>Direction:</b> ${isBullish ? '🟢 BUY' : '🔴 SELL'}`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `🎯 <b>Outcome:</b> <code>+1.3R (+$${compRisk.rewardUSD.toFixed(2)} USD Paper Return)</code>`,
          `🎯 <b>Entry:</b> <code>${trade.entryPrice.toFixed(2)}</code> ➔ 🏆 <b>TP:</b> <code>${trade.takeProfit.toFixed(2)}</code>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `🧪 <i>Paper trade closed. Real account equity ($${getCurrentAccountBalance().toFixed(2)}) unaffected.</i>`
        ].join('\n');

        await sendTelegramMessage(tpAlert);

        // 🎓 Auto-evaluate Incubation Graduation ONLY for actual monitorOnly incubation pairs
        try {
          const symConf = config.SYMBOLS[symbol];
          const rec = getPairHealth(symbol);
          if (symConf && symConf.monitorOnly && !rec.graduationAlertSent) {
            const grad = checkIncubationGraduation(symbol);
            if (grad.allPassed) {
              rec.graduationAlertSent = true;
              savePairHealthState(pairHealthState);
              const gradAlert = [
                `🎓 👑 <b>[INCUBATION GRADUATION ACHIEVED: ${symbol}]</b>`,
                `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
                `<b>Asset:</b> <code>${symbol}</code> (${symConf.name || symbol})`,
                `<b>Achievement:</b> All 3 Incubation Gates Passed!`,
                `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
                `✅ <b>Gate 1 (Min 5 Trades):</b> <code>${grad.total} Trades Completed</code>`,
                `✅ <b>Gate 2 (≥60% Win Rate):</b> <code>${grad.winRate}% WR (${grad.wins}W / ${grad.losses}L)</code>`,
                `✅ <b>Gate 3 (Multi-Day Proof):</b> <code>${grad.daysCount} Distinct Trading Days</code>`,
                `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
                `🚀 <i>Pair has proven statistical edge in forward sandbox!</i>`,
                `💡 <b>To promote to Live Trading, send:</b> <code>/promote ${symbol}</code>`
              ].join('\n');
              await sendTelegramMessage(gradAlert);
            }
          }
        } catch (e) {
          console.warn('[runner] Graduation check error:', e.message);
        }

        updatedTrades = updatedTrades.filter(t => t.setupId !== trade.setupId);
        changed = true;
        continue;
      }

      if (hitSL) {
        if (closingTradeSetups.has(trade.setupId)) continue;
        closingTradeSetups.add(trade.setupId);

        // 🛡️ Immediately remove from activeTrades on disk so no concurrent loop sees it as open
        updatedTrades = updatedTrades.filter(t => t.setupId !== trade.setupId);
        saveActiveTrades(updatedTrades);
        changed = true;

        recordIncubationOutcome({
          setupId: trade.setupId,
          symbol: trade.symbol,
          type: trade.type,
          entryPrice: trade.entryPrice,
          stopLoss: trade.stopLoss,
          takeProfit: trade.takeProfit,
          exitPrice: trade.stopLoss,
          outcome: 'LOSS',
          rMultiple: -1.0,
          pnlUSD: -compRisk.riskUSD,
          strategy: trade.strategy || 'Strategy 5B Pro'
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

        await updatePairHealthOnPaperClose(symbol, 'LOSS', trade);
        recordSymbolTradeOutcome(symbol, 'LOSS', true, trade);

        const isMonitorOnly = config.SYMBOLS[symbol] && config.SYMBOLS[symbol].monitorOnly;
        const stratName = trade.strategy || 'Paper Sandbox';
        const bannerTitle = isMonitorOnly 
          ? `[MYTRADA INCUBATION OUTCOME — SL HIT (-1.0R)]`
          : `[MYTRADA PAPER OUTCOME — ${stratName.toUpperCase()} — SL HIT (-1.0R)]`;

        const slAlert = [
          `🔬 🔴 <b>${bannerTitle}</b>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].name : symbol})`,
          `<b>Strategy:</b> <code>${stratName}</code>`,
          `<b>Direction:</b> ${isBullish ? '🟢 BUY' : '🔴 SELL'}`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `💸 <b>Outcome:</b> <code>-1.0R (-$${compRisk.riskUSD.toFixed(2)} USD Paper Loss)</code>`,
          `🔥 <b>Entry:</b> <code>${trade.entryPrice.toFixed(2)}</code> ➔ 🛡️ <b>SL:</b> <code>${trade.stopLoss.toFixed(2)}</code>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `🧪 <i>Paper trade closed. Real account equity ($${getCurrentAccountBalance().toFixed(2)}) unaffected.</i>`
        ].join('\n');

        await sendTelegramMessage(slAlert);

        // 🎓 Auto-evaluate Incubation Graduation ONLY for actual monitorOnly incubation pairs
        try {
          const symConf = config.SYMBOLS[symbol];
          const rec = getPairHealth(symbol);
          if (symConf && symConf.monitorOnly && !rec.graduationAlertSent) {
            const grad = checkIncubationGraduation(symbol);
            if (grad.allPassed) {
              rec.graduationAlertSent = true;
              savePairHealthState(pairHealthState);
              const gradAlert = [
                `🎓 👑 <b>[INCUBATION GRADUATION ACHIEVED: ${symbol}]</b>`,
                `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
                `<b>Asset:</b> <code>${symbol}</code> (${symConf.name || symbol})`,
                `<b>Achievement:</b> All 3 Incubation Gates Passed!`,
                `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
                `✅ <b>Gate 1 (Min 5 Trades):</b> <code>${grad.total} Trades Completed</code>`,
                `✅ <b>Gate 2 (≥60% Win Rate):</b> <code>${grad.winRate}% WR (${grad.wins}W / ${grad.losses}L)</code>`,
                `✅ <b>Gate 3 (Multi-Day Proof):</b> <code>${grad.daysCount} Distinct Trading Days</code>`,
                `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
                `🚀 <i>Pair has proven statistical edge in forward sandbox!</i>`,
                `💡 <b>To promote to Live Trading, send:</b> <code>/promote ${symbol}</code>`
              ].join('\n');
              await sendTelegramMessage(gradAlert);
            }
          }
        } catch (e) {}

        updatedTrades = updatedTrades.filter(t => t.setupId !== trade.setupId);
        changed = true;
        continue;
      }

      continue;
    }

    if (hitTP) {
      if (closingTradeSetups.has(trade.setupId)) continue;
      closingTradeSetups.add(trade.setupId);

      // 🛡️ Immediately remove from activeTrades on disk so no concurrent loop sees it as open
      updatedTrades = updatedTrades.filter(t => t.setupId !== trade.setupId);
      saveActiveTrades(updatedTrades);
      changed = true;

      const pnlUsd = trade.rewardUSD || compRisk.rewardUSD;

      recordSymbolTradeOutcome(symbol, 'WIN', false, trade);
      await updatePairHealthOnLiveClose(symbol, 'WIN', trade.strategy);
      await recordTradeOutcomeToDesk(trade.strategy, 'WIN', pnlUsd, 1.3);
      recordClose(trade.setupId, 'WIN', trade.takeProfit, pnlUsd, 1.3, trade.aiVisionVerdict);
      const updatedBalance = getCurrentAccountBalance();

      const tpAlert = [
        `🏆 🟢 <b>[MYTRADA TP HIT (+1.3R)]</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].name : symbol})`,
        `<b>Strategy:</b> <code>${trade.strategy || 'Strategy 5B Pro'} (Live Real Money)</code>`,
        `<b>Direction:</b> ${isBullish ? '🟢 BUY' : '🔴 SELL'}`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `💰 <b>Profit:</b> <code>+$${pnlUsd.toFixed(2)} USD (+1.3R)</code>`,
        `💵 <b>New Balance:</b> <code>$${updatedBalance.toFixed(2)} USD</code>`,
        `🎯 <b>Entry:</b> <code>${trade.entryPrice.toFixed(2)}</code> ➔ 🏆 <b>TP:</b> <code>${trade.takeProfit.toFixed(2)}</code>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `🛡️ <i>Post-win cooldown active (${config.CIRCUIT_BREAKER.POST_WIN_PAUSE_MINS || 35}m).</i>`
      ].filter(Boolean).join('\n');

      await sendTelegramMessage(tpAlert);
      await new Promise(r => setTimeout(r, 1200));

      updatedTrades = updatedTrades.filter(t => t.setupId !== trade.setupId);
      changed = true;
      continue;
    }

    if (hitSL) {
      if (closingTradeSetups.has(trade.setupId)) continue;
      closingTradeSetups.add(trade.setupId);

      // 🛡️ Immediately remove from activeTrades on disk so no concurrent loop sees it as open
      updatedTrades = updatedTrades.filter(t => t.setupId !== trade.setupId);
      saveActiveTrades(updatedTrades);
      changed = true;

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
          `<b>Strategy:</b> <code>${trade.strategy || 'Strategy 5B Pro'} (Live Real Money)</code>`,
          `<b>Direction:</b> ${isBullish ? '🟢 BUY' : '🔴 SELL'}`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `💸 <b>Outcome:</b> <code>$0.00 USD (0.0R Breakeven)</code>`,
          `💵 <b>Account Balance:</b> <code>$${updatedBalance.toFixed(2)} USD</code>`,
          `🎯 <b>Entry:</b> <code>${trade.entryPrice.toFixed(2)}</code> ➔ 🛡️ <b>Exit:</b> <code>${trade.stopLoss.toFixed(2)}</code>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `👌 <i>Capital fully protected. Position closed at breakeven without loss.</i>`
        ].filter(Boolean).join('\n');

        await sendTelegramMessage(beAlert);
        await new Promise(r => setTimeout(r, 1200));
      } else {
        recordSymbolTradeOutcome(symbol, 'LOSS', false, trade);
        await updatePairHealthOnLiveClose(symbol, 'LOSS', trade.strategy);
        await recordTradeOutcomeToDesk(trade.strategy, 'LOSS', -riskUSD, -1.0);
        recordClose(trade.setupId, 'LOSS', trade.stopLoss, -riskUSD, -1.0, trade.aiVisionVerdict);
        const updatedBalance = getCurrentAccountBalance();

        const slAlert = [
          `🔴 🛡️ <b>[MYTRADA STOP LOSS HIT (-1.0R)]</b>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].name : symbol})`,
          `<b>Strategy:</b> <code>${trade.strategy || 'Strategy 5B Pro'} (Live Real Money)</code>`,
          `<b>Direction:</b> ${isBullish ? '🟢 BUY' : '🔴 SELL'}`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `💸 <b>Loss:</b> <code>-$${riskUSD.toFixed(2)} USD (-1.0R)</code>`,
          `💵 <b>New Balance:</b> <code>$${updatedBalance.toFixed(2)} USD</code>`,
          `🔥 <b>Entry:</b> <code>${trade.entryPrice.toFixed(2)}</code> ➔ 🛡️ <b>SL:</b> <code>${trade.stopLoss.toFixed(2)}</code>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `🛡️ <i>Defensive cooldown active (${pauseMins}m).</i>`
        ].filter(Boolean).join('\n');

        await sendTelegramMessage(slAlert);
        await new Promise(r => setTimeout(r, 1200));
      }

      continue;
    }
  }

  if (changed) {
    await checkDailyTargetLock();
    await checkDailyMaxLossLock();
  }

  // Prune closingTradeSetups set periodically to keep memory lightweight
  if (closingTradeSetups.size > 500) {
    const arr = Array.from(closingTradeSetups);
    arr.slice(0, 200).forEach(id => closingTradeSetups.delete(id));
  }
} finally {
  activeSymbolCheckLocks.delete(symbol);
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

/**
 * 👑 Macro Cascade / Squeeze Guard
 * Detects whether Higher Timeframe (1H) is in an unbroken 3+ candle waterfall (Crash) or short-squeeze (Boom)
 * Prevents buying into active cascading selloffs or shorting into active buying rallies.
 * @param {Array} htf1hCandles - Array of 1H candle objects
 * @param {string} mode - 'CRASH' | 'BOOM'
 * @returns {{ isCascading: boolean, count: number, reason: string|null }}
 */
function isMacroCascadeActive(htf1hCandles, mode) {
  const cascadeCfg = config.CASCADE_FILTER || {};
  if (cascadeCfg.ENABLED === false) return { isCascading: false, count: 0, reason: null };

  if (!htf1hCandles || htf1hCandles.length < 4) {
    return { isCascading: false, count: 0, reason: null };
  }

  const maxThresholdCrash = cascadeCfg.MAX_CONSECUTIVE_1H_BEARISH_CRASH || 3;
  const maxThresholdBoom = cascadeCfg.MAX_CONSECUTIVE_1H_BULLISH_BOOM || 3;

  // Evaluate completed closed 1H candles (start at length - 2 to ignore the forming unclosed candle)
  if (mode === 'CRASH') {
    let count = 0;
    for (let i = htf1hCandles.length - 2; i >= Math.max(0, htf1hCandles.length - 7); i--) {
      const c = htf1hCandles[i];
      const prev = htf1hCandles[i - 1];
      // Bearish continuation: closed red (close < open) AND lower close than previous candle
      if (c && c.close < c.open && (!prev || c.close < prev.close)) {
        count++;
      } else {
        break;
      }
    }
    if (count >= maxThresholdCrash) {
      return {
        isCascading: true,
        count,
        reason: `${count}x Consecutive 1H Bearish Continuation Candles (Active Macro Cascade)`
      };
    }
  } else if (mode === 'BOOM') {
    let count = 0;
    for (let i = htf1hCandles.length - 2; i >= Math.max(0, htf1hCandles.length - 7); i--) {
      const c = htf1hCandles[i];
      const prev = htf1hCandles[i - 1];
      // Bullish continuation: closed green (close > open) AND higher close than previous candle
      if (c && c.close > c.open && (!prev || c.close > prev.close)) {
        count++;
      } else {
        break;
      }
    }
    if (count >= maxThresholdBoom) {
      return {
        isCascading: true,
        count,
        reason: `${count}x Consecutive 1H Bullish Continuation Candles (Active Macro Squeeze)`
      };
    }
  }

  return { isCascading: false, count: 0, reason: null };
}

// ── SHARED MARKET STRUCTURE EVALUATOR (Single Source of Truth) ──
const STRUCTURE_SHIFT_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Evaluates 1D / 4H / 1H 50 EMA trend alignment, 1H chop clearance (>= 0.08%),
 * and 48H dealing range positioning without mutating on-disk memory.
 */
function evaluateMarketStructure(htf1hCandles, htf4hCandles, dailyCandles, mode, refPrice = null) {
  const requiredTrend = mode === 'BOOM' ? 'bearish' : 'bullish';
  if (!htf1hCandles || htf1hCandles.length < 55) {
    return {
      ready: false,
      requiredTrend,
      htf1hTrend: 'N/A',
      htf4hTrend: 'N/A',
      dailyTrend: 'N/A',
      h1ClearancePct: 0,
      chopOk: false,
      range48hPct: null,
      in5BRange: false,
      is5BAligned: false,
      blockers: ['Insufficient 1H data']
    };
  }

  // 1. 1H 50 EMA Intermediate Trend & Chop Clearance
  const htf1hCloses = htf1hCandles.map(c => c.close);
  const htf1hEMA = calculateEMA(htf1hCloses, 50);
  const last1hClose = htf1hCloses[htf1hCloses.length - 1];
  const last1hEma = htf1hEMA[htf1hEMA.length - 1];
  const htf1hTrend = last1hClose > last1hEma ? 'bullish' : 'bearish';
  const h1ClearancePct = last1hEma > 0 ? (Math.abs(last1hClose - last1hEma) / last1hEma) * 100 : 0;
  const chopOk = !config.USE_HTF_CHOP_FILTER || h1ClearancePct >= 0.08;

  // 2. 4H 50 EMA Macro Trend
  let htf4hTrend = 'N/A';
  if (htf4hCandles && htf4hCandles.length >= 55) {
    const htf4hCloses = htf4hCandles.map(c => c.close);
    const htf4hEMA = calculateEMA(htf4hCloses, 50);
    const last4hClose = htf4hCloses[htf4hCloses.length - 1];
    const last4hEma = htf4hEMA[htf4hEMA.length - 1];
    htf4hTrend = last4hClose > last4hEma ? 'bullish' : 'bearish';
  }

  // 3. Daily 50 EMA Macro Trend
  let dailyTrend = 'N/A';
  if (dailyCandles && dailyCandles.length >= 30) {
    const dailyCloses = dailyCandles.map(c => c.close);
    const dailyEMA = calculateEMA(dailyCloses, Math.min(50, dailyCloses.length - 1));
    if (dailyEMA.length > 0) {
      const lastDailyClose = dailyCloses[dailyCloses.length - 1];
      const lastDailyEma = dailyEMA[dailyEMA.length - 1];
      dailyTrend = lastDailyClose > lastDailyEma ? 'bullish' : 'bearish';
    }
  }

  // 4. 48H Dealing Range % (non-mutating view matching godeyesMemory window)
  const priceForRange = refPrice !== null ? refPrice : last1hClose;
  let range48hPct = null;
  let in5BRange = true;
  if (htf1hCandles.length >= 24) {
    const lookback = Math.min(48, htf1hCandles.length);
    const slice = htf1hCandles.slice(htf1hCandles.length - lookback);
    const pdh = Math.max(...slice.map(c => c.high));
    const pdl = Math.min(...slice.map(c => c.low));
    const span = pdh - pdl;
    if (span > 0) {
      range48hPct = ((priceForRange - pdl) / span) * 100;
      const minSell5B = (config.STRATEGY_5B && config.STRATEGY_5B.MIN_SELL_RANGE_PCT) !== undefined ? config.STRATEGY_5B.MIN_SELL_RANGE_PCT : 20.0;
      const maxBuy5B = (config.STRATEGY_5B && config.STRATEGY_5B.MAX_BUY_RANGE_PCT) !== undefined ? config.STRATEGY_5B.MAX_BUY_RANGE_PCT : 80.0;
      const minBuyPct = (config.GODEYES && config.GODEYES.MIN_BUY_RANGE_PCT) || 15.0;
      const maxSellPct = (config.GODEYES && config.GODEYES.MAX_SELL_RANGE_PCT) || 85.0;
      in5BRange = mode === 'BOOM'
        ? (range48hPct >= minSell5B && range48hPct <= maxSellPct)
        : (range48hPct <= maxBuy5B && range48hPct >= minBuyPct);
    }
  }

  const blockers = [];
  if (dailyTrend !== 'N/A' && config.REQUIRE_DAILY_CONFLUENCE && dailyTrend !== requiredTrend) {
    blockers.push(`1D ${dailyTrend}`);
  }
  if (htf4hTrend !== 'N/A' && htf4hTrend !== requiredTrend) {
    blockers.push(`4H ${htf4hTrend}`);
  }
  if (htf1hTrend !== requiredTrend) {
    blockers.push(`1H ${htf1hTrend}`);
  } else if (!chopOk) {
    blockers.push(`1H chop ${h1ClearancePct.toFixed(2)}% (min 0.08%)`);
  }

  const is5BAligned = blockers.length === 0;

  return {
    ready: true,
    requiredTrend,
    htf1hTrend,
    htf4hTrend,
    dailyTrend,
    h1ClearancePct,
    chopOk,
    range48hPct,
    in5BRange,
    is5BAligned,
    blockers
  };
}

function getPoolBadge(symbol) {
  const symConfig = config.SYMBOLS[symbol] || {};
  if (symConfig.monitorOnly) return '🔬 INCUBATOR';
  const rec = getPairHealth(symbol);
  if (rec && rec.isQuarantined) return '🔴 QUARANTINED';
  return '💰 LIVE';
}

function describeStructureShift(prev, ms) {
  if (!prev) return `All 3 TFs (${ms.requiredTrend.toUpperCase()}) aligned`;
  const changes = [];
  if (prev.dailyTrend && prev.dailyTrend !== ms.requiredTrend && ms.dailyTrend === ms.requiredTrend) {
    changes.push(`Daily 50 EMA flipped ${ms.dailyTrend.toUpperCase()}`);
  }
  if (prev.htf4hTrend && prev.htf4hTrend !== ms.requiredTrend && ms.htf4hTrend === ms.requiredTrend) {
    changes.push(`4H 50 EMA flipped ${ms.htf4hTrend.toUpperCase()}`);
  }
  if (prev.htf1hTrend && prev.htf1hTrend !== ms.requiredTrend && ms.htf1hTrend === ms.requiredTrend) {
    changes.push(`1H 50 EMA flipped ${ms.htf1hTrend.toUpperCase()}`);
  } else if (prev.htf1hTrend === ms.requiredTrend && prev.chopOk === false && ms.chopOk === true) {
    changes.push(`1H cleared 0.08% chop zone (${ms.h1ClearancePct.toFixed(2)}%)`);
  }
  return changes.length > 0 ? changes.join(' + ') : `Full ${ms.requiredTrend.toUpperCase()} alignment restored`;
}

/**
 * Tracks per-symbol full 1D+4H+1H structure alignment transitions and dispatches
 * a Telegram alert when a previously misaligned/choppy pair shifts into monitoring criteria.
 * Seeds silently on first run to prevent boot notification spam.
 */
async function checkStructureShiftForSymbol(symbol, mode, dailyCandles, htf4hCandles, htf1hCandles) {
  const ms = evaluateMarketStructure(htf1hCandles, htf4hCandles, dailyCandles, mode);
  if (!ms.ready) return;

  const prev = structureWatchState[symbol];
  const now = Date.now();

  if (!prev) {
    structureWatchState[symbol] = {
      is5BAligned: ms.is5BAligned,
      dailyTrend: ms.dailyTrend,
      htf4hTrend: ms.htf4hTrend,
      htf1hTrend: ms.htf1hTrend,
      chopOk: ms.chopOk,
      lastAlertedAt: 0
    };
    saveStructureWatchState(structureWatchState);
    return;
  }

  const shiftedIntoAlignment = !prev.is5BAligned && ms.is5BAligned;
  const cooldownElapsed = (now - (prev.lastAlertedAt || 0)) >= STRUCTURE_SHIFT_COOLDOWN_MS;

  structureWatchState[symbol] = {
    is5BAligned: ms.is5BAligned,
    dailyTrend: ms.dailyTrend,
    htf4hTrend: ms.htf4hTrend,
    htf1hTrend: ms.htf1hTrend,
    chopOk: ms.chopOk,
    lastAlertedAt: (shiftedIntoAlignment && cooldownElapsed) ? now : (prev.lastAlertedAt || 0)
  };
  saveStructureWatchState(structureWatchState);

  if (shiftedIntoAlignment && cooldownElapsed) {
    const symConfig = config.SYMBOLS[symbol] || {};
    const actionLabel = mode === 'BOOM' ? '🔴 SELL ONLY (Bearish Trend)' : '🟢 BUY ONLY (Bullish Trend)';
    const poolBadge = getPoolBadge(symbol);
    const shiftTrigger = describeStructureShift(prev, ms);
    const rangeStatus = ms.range48hPct !== null
      ? `${ms.range48hPct.toFixed(1)}% (${ms.in5BRange ? 'Inside [20%-80%] Zone' : 'Outside [20%-80%] — awaiting pullback'})`
      : 'N/A';

    await sendTelegramMessage([
      `📡 🟢 <b>[PAIR NOW MONITORED — STRUCTURE ALIGNED]</b>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `<b>Asset:</b> <code>${symbol}</code> (${symConfig.name || symbol})`,
      `<b>Action Mode:</b> ${actionLabel}`,
      `<b>Pool Status:</b> <code>${poolBadge}</code>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `<b>Metrics Met:</b>`,
      `• <b>Daily 50 EMA:</b> <code>${String(ms.dailyTrend).toUpperCase()}</code>`,
      `• <b>4H 50 EMA:</b> <code>${String(ms.htf4hTrend).toUpperCase()}</code>`,
      `• <b>1H 50 EMA:</b> <code>${String(ms.htf1hTrend).toUpperCase()} (${ms.h1ClearancePct.toFixed(2)}% clr ≥ 0.08%)</code>`,
      `• <b>48H Dealing Range:</b> <code>${rangeStatus}</code>`,
      `• <b>Shift Trigger:</b> <code>${shiftTrigger}</code>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `🔍 <i>Actively scanning 5M chart for spike exhaustion setups.</i>`
    ].join('\n'));
  }
}

/**
 * Evaluates all configured symbols for the 12:00 AM daily activation watchlist.
 */
async function buildDailyStructureWatchlist() {
  const symbols = Object.keys(config.SYMBOLS);
  const alignedLines = [];
  const waitingLines = [];

  for (const symbol of symbols) {
    const symConfig = config.SYMBOLS[symbol];
    const mode = symConfig.mode;
    try {
      const dailyCandles = config.REQUIRE_DAILY_CONFLUENCE
        ? await getCachedHtfCandles(symbol, config.MACRO_DAILY || '1d', 60, 60 * 60 * 1000)
        : null;
      const htf4hCandles = await getCachedHtfCandles(symbol, config.MACRO_HTF || '4h', 100, 15 * 60 * 1000);
      const htf1hCandles = await getCachedHtfCandles(symbol, config.INTERMEDIATE_HTF || '1h', 100, 5 * 60 * 1000);
      const ms = evaluateMarketStructure(htf1hCandles, htf4hCandles, dailyCandles, mode);

      if (ms.is5BAligned) {
        const dirTag = mode === 'BOOM' ? 'SELL' : 'BUY';
        const poolBadge = getPoolBadge(symbol);
        const rangeTag = ms.range48hPct !== null
          ? `${ms.range48hPct.toFixed(0)}%${ms.in5BRange ? '✓' : '⏳'}`
          : 'N/A';
        alignedLines.push(`  • <b>${symbol}</b> [<code>${dirTag} • 1H ${ms.h1ClearancePct.toFixed(2)}% • R:${rangeTag} • ${poolBadge}</code>]`);
      } else {
        waitingLines.push(`${symbol} (${ms.blockers.join('/')})`);
      }
      await new Promise(r => setTimeout(r, 80));
    } catch (e) {
      waitingLines.push(`${symbol} (data pending)`);
    }
  }

  const out = [];
  out.push(`📡 <b>Market Structure Watchlist (${alignedLines.length}/${symbols.length} Aligned):</b>`);
  if (alignedLines.length > 0) {
    out.push(...alignedLines);
  } else {
    out.push(`  • <i>No pairs fully 1D+4H+1H aligned at rollover — hunting structure shifts.</i>`);
  }
  if (waitingLines.length > 0) {
    out.push(`⏸️ <b>Standby (${waitingLines.length}):</b> <code>${waitingLines.join(', ')}</code>`);
  }
  return out.join('\n');
}

// ── STRATEGY 5B PRO SIGNAL DETECTION ENGINE (UPGRADED: ENERGY + DECELERATION + IGNITION) ──
function detectStrategy5BSetup(ltfCandles, htf1hCandles, htf4hCandles, dailyCandles, mode, minSpikesRequired, symbol) {
  if (!ltfCandles || !htf1hCandles || ltfCandles.length < 25 || htf1hCandles.length < 55) return null;

  const ms = evaluateMarketStructure(htf1hCandles, htf4hCandles, dailyCandles, mode);
  if (!ms.ready || !ms.chopOk) return null;

  const { htf1hTrend, htf4hTrend, dailyTrend, h1ClearancePct } = ms;

  // ── CASE 1: SELL (BOOM) ──
  if (mode === 'BOOM') {
    if (!ms.is5BAligned) return null;

    const atr = calculateATR(ltfCandles, 14);
    if (!atr || atr === 0) return null;

    // 1. Ignition Bar Trigger: The latest closed 5M bar c0 must confirm the sell move has physically started
    const c0 = ltfCandles[ltfCandles.length - 1];
    const c1 = ltfCandles[ltfCandles.length - 2];
    if (!c0 || !c1) return null;

    const isRed = c0.close < c0.open;
    const c0Range = c0.high - c0.low;
    const c0Body = c0.open - c0.close;
    const bodyRatio = c0Range > 0 ? (c0Body / c0Range) : 0;

    // Must be a solid red candle with body >= 40% of range
    if (!isRed || bodyRatio < 0.40) return null;

    // Ignition Break: Must break below the preceding candle's low (proving tick flow reversal has started)
    if (c0.close >= c1.low) return null;

    // 2. Measure Cumulative Spike Energy & Momentum Deceleration in the preceding 1-5 bars
    let cumulativeSpikeRange = 0;
    let spikePeak = -Infinity;
    const spikesFound = [];

    for (let i = 1; i <= 5; i++) {
      const b = ltfCandles[ltfCandles.length - 1 - i];
      if (!b) break;
      const isSpike = (b.close > b.open) && ((b.high - b.low) >= (atr * 0.7));
      if (isSpike) {
        spikesFound.push(b.high - b.low);
        cumulativeSpikeRange += (b.high - b.low);
        if (b.high > spikePeak) spikePeak = b.high;
      } else if (spikesFound.length > 0) {
        break;
      }
    }

    if (spikesFound.length === 0) return null;

    // Metric 1: Energy Depletion (Cumulative spikes >= 2.0x ATR or Single Monster Spike >= 2.0x ATR)
    const isMonster = spikesFound.length === 1 && spikesFound[0] >= (atr * 2.0);
    const isEnergyDepleted = cumulativeSpikeRange >= (atr * 2.0);
    if (!isMonster && !isEnergyDepleted) return null;

    // Metric 2: Momentum Deceleration Guard (Spikes must be dying down, NOT accelerating)
    if (spikesFound.length >= 2) {
      const latestSpike = spikesFound[0];
      const prevSpike = spikesFound[1];
      if (latestSpike > prevSpike * 1.3) {
        return null;
      }
    }

    const spikePeakClean = Math.max(spikePeak, c0.high, c1.high);
    const entry = c0.close;
    let slDist = (spikePeakClean - entry) + (atr * 1.2);
    if (slDist < (atr * 0.8)) slDist = atr * 0.8;
    if (slDist <= 0 || slDist > (atr * 4.5)) return null;

    const sl = entry + slDist;
    const tp = entry - (slDist * (config.REWARD_RATIO || 1.3));
    const candleEpoch = c0.epoch || c0.time;

    const minSell5B = (config.STRATEGY_5B && config.STRATEGY_5B.MIN_SELL_RANGE_PCT) !== undefined ? config.STRATEGY_5B.MIN_SELL_RANGE_PCT : 20.0;
    const maxBuy5B = (config.STRATEGY_5B && config.STRATEGY_5B.MAX_BUY_RANGE_PCT) !== undefined ? config.STRATEGY_5B.MAX_BUY_RANGE_PCT : 80.0;
    const exhaustion5B = evaluateMacroExhaustion(symbol, entry, 'SELL', htf1hCandles, minSell5B, maxBuy5B);

    let isBlocked = exhaustion5B.isExhausted;
    let blockedReason = exhaustion5B.reason ? `5B Macro Momentum Guard: ${exhaustion5B.reason}` : null;

    const energyRatio = (cumulativeSpikeRange / atr).toFixed(1);
    const spikeCountLabel = `${spikesFound.length} Spikes (Energy: ${energyRatio}x ATR • Decelerated • Ignition Break)`;
    const valuationLabel = `Macro Range: ${exhaustion5B.rangePct.toFixed(1)}% (5B Pro SMC Corridor [${minSell5B.toFixed(0)}%-${maxBuy5B.toFixed(0)}%])`;
    const liquidityLabel = `Energy Exhaustion (${energyRatio}x ATR)`;
    const valueZoneTouched = `Ignition Break (c0.close < c1.low • body ${(bodyRatio * 100).toFixed(0)}%)`;

    return {
      strategy: 'Strategy 5B Pro',
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
      refPrice: spikePeakClean,
      h1ClearancePct,
      bodyRatio,
      valueZoneTouched,
      candleEpoch,
      confirmCount: 1,
      spikeCountLabel,
      valuationLabel,
      liquidityLabel,
      isBlocked,
      blockedReason
    };
  }

  // ── CASE 2: BUY (CRASH) ──
  if (mode === 'CRASH') {
    if (!ms.is5BAligned) return null;

    const atr = calculateATR(ltfCandles, 14);
    if (!atr || atr === 0) return null;

    // 1. Ignition Bar Trigger: The latest closed 5M bar c0 must confirm the buy move has physically started
    const c0 = ltfCandles[ltfCandles.length - 1];
    const c1 = ltfCandles[ltfCandles.length - 2];
    if (!c0 || !c1) return null;

    const isGreen = c0.close > c0.open;
    const c0Range = c0.high - c0.low;
    const c0Body = c0.close - c0.open;
    const bodyRatio = c0Range > 0 ? (c0Body / c0Range) : 0;

    // Must be a solid green candle with body >= 40% of range
    if (!isGreen || bodyRatio < 0.40) return null;

    // Ignition Break: Must break above the preceding candle's high (proving upward tick flow reversal has started)
    if (c0.close <= c1.high) return null;

    // 2. Measure Cumulative Crash Spike Energy & Momentum Deceleration in the preceding 1-5 bars
    let cumulativeSpikeRange = 0;
    let crashTrough = Infinity;
    const crashesFound = [];

    for (let i = 1; i <= 5; i++) {
      const b = ltfCandles[ltfCandles.length - 1 - i];
      if (!b) break;
      const isCrash = (b.close < b.open) && ((b.high - b.low) >= (atr * 0.7));
      if (isCrash) {
        crashesFound.push(b.high - b.low);
        cumulativeSpikeRange += (b.high - b.low);
        if (b.low < crashTrough) crashTrough = b.low;
      } else if (crashesFound.length > 0) {
        break;
      }
    }

    if (crashesFound.length === 0) return null;

    // Metric 1: Energy Depletion (Cumulative crashes >= 2.0x ATR or Single Monster Crash >= 2.0x ATR)
    const isMonster = crashesFound.length === 1 && crashesFound[0] >= (atr * 2.0);
    const isEnergyDepleted = cumulativeSpikeRange >= (atr * 2.0);
    if (!isMonster && !isEnergyDepleted) return null;

    // Metric 2: Momentum Deceleration Guard (Crash spikes must be dying down, NOT accelerating)
    if (crashesFound.length >= 2) {
      const latestCrash = crashesFound[0];
      const prevCrash = crashesFound[1];
      if (latestCrash > prevCrash * 1.3) {
        return null;
      }
    }

    const crashTroughClean = Math.min(crashTrough, c0.low, c1.low);
    const entry = c0.close;
    let slDist = (entry - crashTroughClean) + (atr * 1.2);
    if (slDist < (atr * 0.8)) slDist = atr * 0.8;
    if (slDist <= 0 || slDist > (atr * 4.5)) return null;

    const sl = entry - slDist;
    const tp = entry + (slDist * (config.REWARD_RATIO || 1.3));
    const candleEpoch = c0.epoch || c0.time;

    const minSell5B = (config.STRATEGY_5B && config.STRATEGY_5B.MIN_SELL_RANGE_PCT) !== undefined ? config.STRATEGY_5B.MIN_SELL_RANGE_PCT : 20.0;
    const maxBuy5B = (config.STRATEGY_5B && config.STRATEGY_5B.MAX_BUY_RANGE_PCT) !== undefined ? config.STRATEGY_5B.MAX_BUY_RANGE_PCT : 80.0;
    const exhaustion5B = evaluateMacroExhaustion(symbol, entry, 'BUY', htf1hCandles, minSell5B, maxBuy5B);

    let isBlocked = exhaustion5B.isExhausted;
    let blockedReason = exhaustion5B.reason ? `5B Macro Momentum Guard: ${exhaustion5B.reason}` : null;

    const energyRatio = (cumulativeSpikeRange / atr).toFixed(1);
    const spikeCountLabel = `${crashesFound.length} Spikes (Energy: ${energyRatio}x ATR • Decelerated • Ignition Break)`;
    const valuationLabel = `Macro Range: ${exhaustion5B.rangePct.toFixed(1)}% (5B Pro SMC Corridor [${minSell5B.toFixed(0)}%-${maxBuy5B.toFixed(0)}%])`;
    const liquidityLabel = `Energy Exhaustion (${energyRatio}x ATR)`;
    const valueZoneTouched = `Ignition Break (c0.close > c1.high • body ${(bodyRatio * 100).toFixed(0)}%)`;

    return {
      strategy: 'Strategy 5B Pro',
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
      refPrice: crashTroughClean,
      h1ClearancePct,
      bodyRatio,
      valueZoneTouched,
      candleEpoch,
      confirmCount: 1,
      spikeCountLabel,
      valuationLabel,
      liquidityLabel,
      isBlocked,
      blockedReason
    };
  }

  return null;
}

// ── STRATEGY SMC SWEEP: 15M LIQUIDITY SWEEP & 5M STRUCTURAL REJECTION (NON-SPIKE) ──
function detectStrategySMCSweepSetup(ltfCandles, htf1hCandles, htf4hCandles, dailyCandles, mode, minSpikesRequired, symbol) {
  if (!ltfCandles || ltfCandles.length < 35 || !htf1hCandles || htf1hCandles.length < 50) return null;

  // 1. 1H Macro Trend Alignment & Dealing Range Equilibrium Filter
  const h1Closes = htf1hCandles.map(c => c.close);
  const h1Ema50 = calculateEMA(h1Closes, 50);
  const lastH1Close = h1Closes[h1Closes.length - 1];
  const lastH1Ema = h1Ema50[h1Ema50.length - 1];
  if (!lastH1Ema) return null;

  // 24H Dealing Range
  const h1Lookback = htf1hCandles.slice(Math.max(0, htf1hCandles.length - 24));
  const dayHigh = Math.max(...h1Lookback.map(c => c.high));
  const dayLow = Math.min(...h1Lookback.map(c => c.low));
  const dayRange = dayHigh - dayLow;
  if (dayRange <= 0) return null;

  const currentPrice = ltfCandles[ltfCandles.length - 1].close;
  const rangePct = ((currentPrice - dayLow) / dayRange) * 100;

  // Anti-Cascade Guard
  const cascade = isMacroCascadeActive(htf1hCandles, mode);
  if (cascade.isCascading) return null;

  // Crash Sweep: Only in Discount (< 60% range) and 1H Trend Bullish
  // Boom Sweep: Only in Premium (> 40% range) and 1H Trend Bearish
  if (mode === 'CRASH') {
    if (lastH1Close < lastH1Ema) return null;
    if (rangePct > 60.0) return null;
  } else {
    if (lastH1Close > lastH1Ema) return null;
    if (rangePct < 40.0) return null;
  }

  // 2. Aggregate 5M candles to 15M candles to find genuine 15M swing levels
  const m15Candles = [];
  for (let i = 0; i < ltfCandles.length; i += 3) {
    const chunk = ltfCandles.slice(i, i + 3);
    if (chunk.length < 3) break;
    m15Candles.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk[2].close
    });
  }
  if (m15Candles.length < 10) return null;

  // Find 15M fractal swing points
  const swingLows = [];
  const swingHighs = [];
  for (let j = 2; j < m15Candles.length - 2; j++) {
    const prev1 = m15Candles[j - 1], prev2 = m15Candles[j - 2];
    const curr = m15Candles[j];
    const next1 = m15Candles[j + 1], next2 = m15Candles[j + 2];
    if (curr.low < prev1.low && curr.low < prev2.low && curr.low < next1.low && curr.low < next2.low) {
      swingLows.push(curr.low);
    }
    if (curr.high > prev1.high && curr.high > prev2.high && curr.high > next1.high && curr.high > next2.high) {
      swingHighs.push(curr.high);
    }
  }

  const atr = calculateATR(ltfCandles, 14);
  if (!atr || atr === 0) return null;

  const c0 = ltfCandles[ltfCandles.length - 1]; // latest closed 5M bar
  const c1 = ltfCandles[ltfCandles.length - 2]; // preceding 5M bar
  const candleEpoch = c0.epoch || c0.time;

  // 3. Liquidity Sweep Detection & 5M Absorption Rejection (Multi-Swing Pool Depth: Last 3 Swings)
  if (mode === 'CRASH' && swingLows.length > 0) {
    const candidateLows = swingLows.slice(-3); // Check up to 3 recent 15M swing lows
    const isBullishCandle = c0.close > c0.open;

    if (isBullishCandle) {
      for (let l = candidateLows.length - 1; l >= 0; l--) {
        const targetLow = candidateLows[l];
        const sweptLow = (c1.low < targetLow || c0.low < targetLow) && c0.close > targetLow;

        if (sweptLow) {
          const sweepExtreme = Math.min(c0.low, c1.low);
          const entry = c0.close;
          // 🛡️ Adaptive SMC Buffer: 0.6x ATR buffer with a 0.8x ATR floor for messy market noise protection
          let slDist = (entry - sweepExtreme) + (atr * 0.6);
          if (slDist < (atr * 0.8)) slDist = atr * 0.8;
          if (slDist <= 0 || slDist > atr * 5.0) continue;

          const stopLoss = entry - slDist;
          const tp = entry + (slDist * 1.3);

          return {
            strategy: 'Strategy SMC',
            direction: 'BUY',
            type: 'bullish',
            entry,
            sl: stopLoss,
            tp,
            slDistance: slDist,
            candleEpoch,
            htf4hTrend: lastH1Close >= lastH1Ema ? 'bullish' : 'bearish',
            htf1hTrend: 'bullish',
            dailyTrend: 'bullish',
            valuationLabel: `Macro Range: ${rangePct.toFixed(1)}% (Discount Sweep)`,
            liquidityLabel: `15M Low Swept @ ${targetLow.toFixed(2)} (Absorption Rejection)`,
            spikeCountLabel: '0 Spikes (Non-Spike SMC)',
            confirmCount: 1,
            isBlocked: false,
            blockedReason: null
          };
        }
      }
    }
  } else if (mode === 'BOOM' && swingHighs.length > 0) {
    const candidateHighs = swingHighs.slice(-3); // Check up to 3 recent 15M swing highs
    const isBearishCandle = c0.close < c0.open;

    if (isBearishCandle) {
      for (let h = candidateHighs.length - 1; h >= 0; h--) {
        const targetHigh = candidateHighs[h];
        const sweptHigh = (c1.high > targetHigh || c0.high > targetHigh) && c0.close < targetHigh;

        if (sweptHigh) {
          const sweepExtreme = Math.max(c0.high, c1.high);
          const entry = c0.close;
          // 🛡️ Adaptive SMC Buffer: 0.6x ATR buffer with a 0.8x ATR floor for messy market noise protection
          let slDist = (sweepExtreme - entry) + (atr * 0.6);
          if (slDist < (atr * 0.8)) slDist = atr * 0.8;
          if (slDist <= 0 || slDist > atr * 5.0) continue;

          const stopLoss = entry + slDist;
          const tp = entry - (slDist * 1.3);

          return {
            strategy: 'Strategy SMC',
            direction: 'SELL',
            type: 'bearish',
            entry,
            sl: stopLoss,
            tp,
            slDistance: slDist,
            candleEpoch,
            htf4hTrend: lastH1Close <= lastH1Ema ? 'bearish' : 'bullish',
            htf1hTrend: 'bearish',
            dailyTrend: 'bearish',
            valuationLabel: `Macro Range: ${rangePct.toFixed(1)}% (Premium Sweep)`,
            liquidityLabel: `15M High Swept @ ${targetHigh.toFixed(2)} (Absorption Rejection)`,
            spikeCountLabel: '0 Spikes (Non-Spike SMC)',
            confirmCount: 1,
            isBlocked: false,
            blockedReason: null
          };
        }
      }
    }
  }

  return null;
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
    const activeRiskPct = dynamicState.customRiskPercent || config.RISK_PERCENT || 3.0;
    const compRisk = getWeeklyCompoundedRisk(activeRiskPct);
    const targetMultiplier = dynamicState.targetWinsMultiplier || (config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.TARGET_WINS_MULTIPLIER) || 2;
    const maxLossMultiplier = dynamicState.maxLossMultiplier || (config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.MAX_LOSS_LOSSES_MULTIPLIER) || 2;

    // 👑 3. Send NEW TRADING DAY banner SECOND
    const newDayTargetLabel = (dynamicState.dailyTargetUSD && dynamicState.dailyTargetUSD > 0)
      ? `+$${dynamicState.dailyTargetUSD.toFixed(2)} USD (Auto: ${targetMultiplier} Wins • +${(targetMultiplier * 1.3).toFixed(1)}R Target)`
      : 'Not Set — Use /target to set today\'s goal';
    const newDayMaxLossLabel = (dynamicState.dailyMaxLossUSD && dynamicState.dailyMaxLossUSD > 0)
      ? `-$${dynamicState.dailyMaxLossUSD.toFixed(2)} USD (Auto: ${maxLossMultiplier} Losses • -${maxLossMultiplier.toFixed(1)}R Floor)`
      : 'Disabled';

    const newDayWatchlist = await buildDailyStructureWatchlist();

    await sendTelegramMessage([
      `🌅 <b>[NEW TRADING DAY ACTIVATED]</b>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `💵 <b>Starting Balance:</b> <code>$${compRisk.liveBalance.toFixed(2)} USD</code>`,
      `🏦 <b>Week Anchor Balance:</b> <code>$${compRisk.balance.toFixed(2)} USD</code>`,
      `🛡️ <b>Trade Risk Model:</b> <code>${activeRiskPct.toFixed(1)}% ($${compRisk.riskUSD.toFixed(2)} USD / trade anchored to week start)</code>`,
      `🎯 <b>Daily Profit Target:</b> <code>${newDayTargetLabel}</code>`,
      `🛡️ <b>Daily Max Loss Floor:</b> <code>${newDayMaxLossLabel}</code>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      newDayWatchlist,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `💡 <i>Target & Max Loss auto-calculated from weekly start balance. Send /target or /maxloss to override anytime.</i>`
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
  const hasPaperEngineActive = !dynamicState.isManuallyPaused && (
    (dynamicState.activeStrategy === 'BOTH' && (!dynamicState.is5bPaused || !dynamicState.is6proPaused)) ||
    (dynamicState.activeStrategy === 'STRATEGY_6_PRO' && !dynamicState.is6proPaused) ||
    (dynamicState.activeStrategy === 'STRATEGY_5B' && !dynamicState.is5bPaused)
  );

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

  const isBoth = dynamicState.activeStrategy === 'BOTH';
  const isTriEngine = dynamicState.activeStrategy === 'TRI_ENGINE' || dynamicState.activeStrategy === 'ALL';
  const isGlobalPaper = dynamicState.executionMode === 'PAPER';
  const scanStratLabel = isBoth
    ? 'Dual-Desk Live Engine (5B Pro + Strategy SMC — 50/50 Allocation)'
    : (isTriEngine
      ? 'Tri-Engine Test Sandbox (5B Pro + Strategy 6 + Strategy SMC — ALL PAPER)'
      : (dynamicState.activeStrategy === 'STRATEGY_6' ? 'Strategy 6' : (dynamicState.activeStrategy === 'STRATEGY_6_PRO' ? 'Strategy SMC' : 'Strategy 5B Pro')));

  console.log(`\n${CYAN}[${now.toLocaleTimeString()}] Scanning ${Object.keys(config.SYMBOLS).length} Elite Boom/Crash Pairs for ${scanStratLabel}...${RESET}`);
  console.log(`-------------------------------------------------------------------------------------------------`);

  const symbols = Object.keys(config.SYMBOLS);

  for (const symbol of symbols) {
    try {
      const symConfig = config.SYMBOLS[symbol];
      const mode = symConfig.mode;
      const minSpikes = symConfig.min_spikes || 2;

      const symHealth5b = getPairHealth(symbol, '5B');
      const symHealthSmc = getPairHealth(symbol, 'SMC');
      const is5bQuarantined = symHealth5b.isQuarantined === true;
      const isSmcQuarantined = symHealthSmc.isQuarantined === true;

      // ── INDEPENDENT STRATEGY COOLDOWN VERIFICATION (Dual/Tri-Engine Architecture) ──
      // For 5B Pro and Strategy 6, respect symConfig.monitorOnly (BOOM150N, CRASH150N, BOOM1000 in incubator)
      const is5bMonitorOnly = Boolean(symConfig.monitorOnly);
      const isS6MonitorOnly = Boolean(symConfig.monitorOnly);
      // For Strategy SMC (6PRO), BOOM150N and CRASH150N are promoted to active pairs (not incubator / monitorOnly)
      const is6proMonitorOnly = Boolean(symConfig.monitorOnly && symbol !== 'BOOM150N' && symbol !== 'CRASH150N');

      // Independent circuit breaker locks & independent desk consecutive loss cooldowns
      const masterLocked = Boolean(dynamicState.masterAccount && dynamicState.masterAccount.dailyLossLocked);
      const is5bInDeskPause = Boolean(dynamicState.desk5b && dynamicState.desk5b.pauseUntil && nowMs < dynamicState.desk5b.pauseUntil);
      const is6proInDeskPause = Boolean(dynamicState.deskSMC && dynamicState.deskSMC.pauseUntil && nowMs < dynamicState.deskSMC.pauseUntil);

      const is5bLockedState = masterLocked || is5bInDeskPause || (dynamicState.desk5b && (dynamicState.desk5b.targetLocked || dynamicState.desk5b.lossLocked));
      const is6proLockedState = masterLocked || is6proInDeskPause || (dynamicState.deskSMC && (dynamicState.deskSMC.targetLocked || dynamicState.deskSMC.lossLocked));

      // 🛡️ Midnight Alignment Buffer (00:00 - 00:15 UTC): Observe initial 15M candle completion before live orders
      const utcHours = now.getUTCHours();
      const utcMins = now.getUTCMinutes();
      const isMidnightBuffer = (utcHours === 0 && utcMins < 15);

      // Strategy SMC is a selective, high-precision HTF sniper: all pairs trade 100% LIVE (no monitorOnly incubator, no quarantine)
      const is6proPaper = isGlobalPaper || isMidnightBuffer || is6proLockedState || (dynamicState.mode6pro || 'PAPER') === 'PAPER';
      const is5bPaper = isGlobalPaper || isMidnightBuffer || is5bLockedState || is5bQuarantined || is5bMonitorOnly || (dynamicState.mode5b || 'PAPER') === 'PAPER';
      const isS6Paper = isGlobalPaper || isMidnightBuffer || is6proLockedState || is5bQuarantined || isS6MonitorOnly || (dynamicState.mode6 || 'PAPER') === 'PAPER';

      const is6proEnabled = !dynamicState.is6proPaused && (isBoth || isTriEngine || dynamicState.activeStrategy === 'STRATEGY_6_PRO');
      const is5bEnabled = !dynamicState.is5bPaused && (isBoth || isTriEngine || dynamicState.activeStrategy === 'STRATEGY_5B');
      const isS6Enabled = !dynamicState.isS6Paused && (isTriEngine || dynamicState.activeStrategy === 'STRATEGY_6');

      const cb6pro = isSymbolInCooldown(symbol, is6proPaper, null, 'SMC');
      const cb5b = isSymbolInCooldown(symbol, is5bPaper, null, '5B');
      const cbS6 = isSymbolInCooldown(symbol, isS6Paper, null, '5B');

      const canRun6Pro = is6proEnabled && !cb6pro.inCooldown;
      const canRun5B = is5bEnabled && !cb5b.inCooldown;
      const canRunS6 = isS6Enabled && !cbS6.inCooldown;

      // If neither engine is permitted to scan this symbol, still track HTF structure shifts & active exits
      if (!canRun6Pro && !canRun5B && !canRunS6) {
        const skipReason = (isS6Enabled && cbS6.inCooldown) ? cbS6.reason : ((is6proEnabled && cb6pro.inCooldown) ? cb6pro.reason : (cb5b.reason || 'Cooldown active'));
        console.log(`  [${mode}] ${symbol.padEnd(12)} | 🛡️ COOLDOWN: ${skipReason}`);
        const [d1Cool, h4Cool, h1Cool, ltf] = await Promise.all([
          config.REQUIRE_DAILY_CONFLUENCE ? getCachedHtfCandles(symbol, config.MACRO_DAILY || '1d', 60, 60 * 60 * 1000).catch(() => null) : Promise.resolve(null),
          getCachedHtfCandles(symbol, config.MACRO_HTF || '4h', 100, 15 * 60 * 1000).catch(() => null),
          getCachedHtfCandles(symbol, config.INTERMEDIATE_HTF || '1h', 100, 5 * 60 * 1000).catch(() => null),
          getCandles(symbol, config.DEFAULT_LTF || '5m', 20, true).catch(() => null)
        ]);
        if (h1Cool) {
          await checkStructureShiftForSymbol(symbol, mode, d1Cool, h4Cool, h1Cool).catch(() => {});
        }
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

      await checkStructureShiftForSymbol(symbol, mode, dailyCandles, htf4hCandles, htf1hCandles).catch(() => {});

      const latestPrice = ltfCandles[ltfCandles.length - 1].close;

      // Build active strategies for this scan
      const strategiesToRun = [];

      if (canRun5B) {
        let displayName = 'Strategy 5B Pro';
        if (is5bPaper) displayName = 'Strategy 5B Pro (Paper)';

        strategiesToRun.push({
          id: '5B',
          name: 'STRATEGY_5B',
          displayName,
          fn: detectStrategy5BSetup,
          isPaper: is5bPaper
        });
      }

      if (canRunS6) {
        let displayName = 'Strategy 6';
        if (isS6Paper) displayName = 'Strategy 6 (Paper)';

        strategiesToRun.push({
          id: 'S6',
          name: 'STRATEGY_6',
          displayName,
          fn: detectStrategy6Setup,
          isPaper: isS6Paper
        });
      }

      if (canRun6Pro) {
        let displayName = 'Strategy SMC';
        if (is6proPaper) displayName = 'Strategy SMC (Paper)';

        strategiesToRun.push({
          id: '6PRO',
          name: 'STRATEGY_6_PRO',
          displayName,
          fn: detectStrategySMCSweepSetup,
          isPaper: is6proPaper
        });
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
          const symbolAlreadyActive = existingActive.some(t => {
            if (t.symbol !== symbol) return false;
            if (strat.id === '5B') {
              return (t.strategy || '').includes('5B') || (t.setupId || '').includes('_5B_');
            }
            if (strat.id === '6PRO') {
              return (t.strategy || '').includes('SMC') || (t.strategy || '').includes('Sweep') || (t.strategy || '').includes('6 Pro') || (t.setupId || '').includes('_6PRO_');
            }
            if (strat.id === 'S6') {
              return (t.strategy || '').includes('Strategy 6') || (t.setupId || '').includes('_S6_');
            }
            return false;
          });

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

          // 🛡️ Same-Zone Re-entry Trap Armor Check
          const trapCheck = isSymbolInCooldown(symbol, strat.isPaper, setup.entry, strat.id);
          if (trapCheck.inCooldown) {
            console.log(`  [TRAP SHIELD] ${symbol.padEnd(12)} | [${strat.displayName}] 🛑 Setup blocked: ${trapCheck.reason}`);
            saveAlertedSetup(setupId);
            break;
          }

          // Target / Loss Locks Check
          const isStratMonitorOnly = strat.id === '6PRO' ? is6proMonitorOnly : is5bMonitorOnly;
          let isPaperMode = isStratMonitorOnly || strat.isPaper;
          const isStratLocked = strat.id === '6PRO' ? is6proLockedState : is5bLockedState;
          if (!isPaperMode && (isStratLocked || dynamicState.isManuallyPaused)) {
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

            const activeSymHealth = strat.id === '6PRO' ? symHealthSmc : symHealth5b;
            if (activeSymHealth && activeSymHealth.isQuarantined) {
              const safeReason = String(activeSymHealth.quarantineReason || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
              alertLines.push(
                `🛡️ <b>Quarantine Reason:</b> <code>${safeReason}</code>`,
                `⏳ <b>Graduation Progress:</b> <code>${activeSymHealth.consecutivePaperWins || 0} / 2 Paper Wins</code>`
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
            await new Promise(r => setTimeout(r, 1200));
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
          await new Promise(r => setTimeout(r, 1200));
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
  const targetWins = dynamicState.targetWinsMultiplier || (config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.TARGET_WINS_MULTIPLIER) || 2;
  const maxLosses = dynamicState.maxLossMultiplier || (config.CIRCUIT_BREAKER && config.CIRCUIT_BREAKER.MAX_LOSS_LOSSES_MULTIPLIER) || 2;
  const activeRiskPct = dynamicState.customRiskPercent || config.RISK_PERCENT || 3.0;

  const startupTargetLabel = dynamicState.dailyTargetUSD > 0 ? `$${dynamicState.dailyTargetUSD.toFixed(2)} (${targetWins}W)` : 'None';
  const startupLossLabel = dynamicState.dailyMaxLossUSD > 0 ? `-$${dynamicState.dailyMaxLossUSD.toFixed(2)} (${maxLosses}L)` : 'None';
  const targetLabel = dynamicState.dailyTargetUSD > 0 
    ? `+$${dynamicState.dailyTargetUSD.toFixed(2)} USD (Auto: ${targetWins} Wins • +${(targetWins * 1.3).toFixed(1)}R Target)` 
    : 'Disabled';
  const maxLossLabel = dynamicState.dailyMaxLossUSD > 0 
    ? `-$${dynamicState.dailyMaxLossUSD.toFixed(2)} USD (Auto: ${maxLosses} Losses • -${maxLosses.toFixed(1)}R Floor)` 
    : 'Disabled';

  if (dynamicState.activeStrategy === 'NONE') {
    console.log(`\n👑 ${BOLD}${CYAN}Mytrada Signal Runner — ONLINE IN STANDBY MODE${RESET}`);
    console.log(`🚀 Waiting for /strategy command on Telegram (/strategy 6pro, /strategy 5b, or /strategy both)...\n`);

    await sendTelegramMessage([
      `🚀 <b>[MYTRADA SYSTEM ONLINE — STANDBY MODE]</b>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `• <b>Status:</b> 🟡 <b>STANDBY (Awaiting Strategy Launch)</b>`,
      `• <b>Universe:</b> <code>${Object.keys(config.SYMBOLS).length} Elite Pairs</code>`,
      `• <b>Week Anchor Balance:</b> <code>$${compRisk.balance.toFixed(2)} USD</code> (Live Equity: <code>$${compRisk.liveBalance.toFixed(2)} USD</code>)`,
      `• <b>Daily Profit Target:</b> <code>${targetLabel}</code>`,
      `• <b>Daily Max Loss Floor:</b> <code>${maxLossLabel}</code>`,
      `• <b>Risk Model:</b> <code>Fixed 1:1.3 R:R (${activeRiskPct.toFixed(1)}% Risk • $${compRisk.riskUSD.toFixed(2)} USD/trade)</code>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `💡 <b>Send a command to launch your strategy:</b>`,
      `• <code>/strategy smc</code> — Launch Strategy SMC`,
      `• <code>/strategy 5b</code> — Launch Strategy 5B Pro`,
      `• <code>/strategy both</code> — Launch Dual-Desk (5B Pro Live + Strategy SMC Live — 50/50 Split)`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`
    ].join('\n'));
  } else {
    const isBoth = dynamicState.activeStrategy === 'BOTH';
    const isTriEngine = dynamicState.activeStrategy === 'TRI_ENGINE' || dynamicState.activeStrategy === 'ALL';
    const isGlobalPaper = dynamicState.executionMode === 'PAPER';
    const is6 = dynamicState.activeStrategy === 'STRATEGY_6';
    const is6Pro = dynamicState.activeStrategy === 'STRATEGY_6_PRO';

    let stratDisplayName = 'Strategy 5B Pro';
    let bannerTitle = 'STRATEGY 5B PRO';
    if (isBoth) {
      stratDisplayName = 'Dual-Desk Live Engine (5B Pro + Strategy SMC — 50/50 Allocation)';
      bannerTitle = 'DUAL-DESK LIVE ENGINE';
    } else if (isTriEngine || isGlobalPaper) {
      stratDisplayName = 'Tri-Engine Test Sandbox (5B Pro + Strategy 6 + Strategy SMC — ALL PAPER)';
      bannerTitle = 'TRI-ENGINE TEST SANDBOX';
    } else if (is6) {
      stratDisplayName = 'Strategy 6 (Structural Momentum Sniper)';
      bannerTitle = 'STRATEGY 6';
    } else if (is6Pro) {
      stratDisplayName = 'Strategy SMC';
      bannerTitle = 'STRATEGY SMC';
    }

    console.log(`\n👑 ${BOLD}${CYAN}Mytrada Institutional Signal Runner — ${stratDisplayName}${RESET}`);
    console.log(`🚀 Universe: ${Object.keys(config.SYMBOLS).length} Elite Pairs | Mode: ${isGlobalPaper ? 'PAPER ($0 Risk)' : 'LIVE'} | Telegram Active...\n`);

    await sendTelegramMessage([
      `🚀 <b>[MYTRADA SYSTEM ONLINE — ${bannerTitle}]</b>`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `• <b>Strategy Engine:</b> <code>${stratDisplayName}</code>`,
      `• <b>Execution Mode:</b> <code>${isGlobalPaper ? 'Paper Sandbox ($0 Real Risk)' : 'Dual-Desk Live Trading (50/50 Equity Split)'}</code>`,
      `• <b>Live Capital:</b> <code>$${compRisk.liveBalance.toFixed(2)} USD</code>`,
      `• <b>Desk Allocation:</b> <code>$${(compRisk.effectiveDeskBalance || 7764.23).toFixed(2)} USD per engine</code>`,
      `• <b>Universe:</b> <code>${Object.keys(config.SYMBOLS).length} Elite Pairs</code>`,
      `• <b>Trade Risk:</b> <code>$${compRisk.riskUSD.toFixed(2)} USD (1.5% Equity / 3.0% Desk • 1:1.3 R:R)</code>`,
      `• <b>Telegram Control:</b> <b>ACTIVE</b> (Send <code>/status</code>, <code>/strategy</code>, <code>/help</code>)`,
      `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
      `⚡ <i>Strategy 5B Pro and Strategy SMC are actively scanning in parallel with independent circuit breakers!</i>`
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

module.exports = { telegramHandlers };
