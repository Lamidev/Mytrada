// reportManager.js
/**
 * Daily, Weekly, and Monthly Report Engine for Mytrada
 * Aggregates signal performance, calculates realized PnL, Win Rates,
 * and formats Telegram summary messages with detailed pair-by-pair breakdowns.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const CACHE_DIR = path.join(__dirname, 'cache');
const DATA_DIR = path.join(__dirname, 'data');
const TRADE_HISTORY_FILE = path.join(CACHE_DIR, 'trade_history.json');
const MASTER_BACKTEST_JSON = path.join(DATA_DIR, 'trades_master_backtest_archive.json');
const MASTER_BACKTEST_CSV = path.join(DATA_DIR, 'trades_master_backtest_archive.csv');

// Ensure directories exist
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadTradeHistory() {
  if (fs.existsSync(TRADE_HISTORY_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(TRADE_HISTORY_FILE, 'utf8'));
    } catch (e) {
      console.warn("[reportManager] Error reading trade history:", e.message);
      return [];
    }
  }
  return [];
}

function saveTradeHistory(history) {
  try {
    fs.writeFileSync(TRADE_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch (e) {
    console.warn("[reportManager] Error saving trade history:", e.message);
  }
}

/**
 * Appends or updates closed trade in the permanent Master Backtesting Archive (JSON & CSV)
 */
function appendTradeToMasterArchive(trade) {
  try {
    let archive = [];
    if (fs.existsSync(MASTER_BACKTEST_JSON)) {
      try {
        archive = JSON.parse(fs.readFileSync(MASTER_BACKTEST_JSON, 'utf8'));
      } catch (e) {
        archive = [];
      }
    }

    const key = trade.setupId || `${trade.symbol}_${trade.type}_${trade.closedTime || trade.signalTime || Date.now()}`;
    const dateStr = trade.closedTime ? trade.closedTime.slice(0, 10) : (trade.signalTime ? trade.signalTime.slice(0, 10) : new Date().toISOString().slice(0, 10));
    const timeStr = trade.closedTime || trade.signalTime || new Date().toISOString();

    const entryRecord = {
      setupId: key,
      date: dateStr,
      time: timeStr,
      symbol: trade.symbol,
      type: trade.type === 'BUY' || trade.type === 'bullish' ? 'BUY' : 'SELL',
      entryPrice: trade.entryPrice !== undefined ? trade.entryPrice : 0,
      stopLoss: trade.stopLoss !== undefined ? trade.stopLoss : 0,
      takeProfit: trade.takeProfit !== undefined ? trade.takeProfit : 0,
      exitPrice: trade.exitPrice !== undefined ? trade.exitPrice : 0,
      outcome: trade.outcome || 'UNKNOWN',
      pnlUSD: trade.pnlUSD !== undefined ? trade.pnlUSD : 0,
      pnlR: trade.pnlR !== undefined ? trade.pnlR : (trade.outcome === 'WIN' ? 1.3 : (trade.outcome === 'LOSS' ? -1.0 : 0)),
      confluenceScore: trade.confluenceScore !== undefined ? trade.confluenceScore : 10,
      strategy: trade.strategy || "Strategy 5B Enhanced"
    };

    const idx = archive.findIndex(t => t.setupId === key);
    if (idx >= 0) {
      archive[idx] = { ...archive[idx], ...entryRecord };
    } else {
      archive.push(entryRecord);
    }

    // Save JSON
    fs.writeFileSync(MASTER_BACKTEST_JSON, JSON.stringify(archive, null, 2), 'utf8');

    // Update CSV
    const headers = [
      "setupId", "date", "time", "symbol", "type",
      "entryPrice", "stopLoss", "takeProfit", "exitPrice",
      "outcome", "pnlUSD", "pnlR", "confluenceScore", "strategy"
    ];
    const csvRows = [headers.join(",")];
    for (const t of archive) {
      csvRows.push([
        `"${t.setupId || ''}"`,
        `"${t.date || ''}"`,
        `"${t.time || ''}"`,
        `"${t.symbol || ''}"`,
        `"${t.type || ''}"`,
        t.entryPrice || 0,
        t.stopLoss || 0,
        t.takeProfit || 0,
        t.exitPrice || 0,
        `"${t.outcome || ''}"`,
        t.pnlUSD || 0,
        t.pnlR || 0,
        t.confluenceScore || 0,
        `"${t.strategy || ''}"`
      ].join(","));
    }
    fs.writeFileSync(MASTER_BACKTEST_CSV, csvRows.join("\n"), 'utf8');
  } catch (err) {
    console.warn("[reportManager] Error appending trade to master backtest archive:", err.message);
  }
}

function getDateString(isoString) {
  if (!isoString) return "";
  const offset = config.TIMEZONE_OFFSET_HOURS !== undefined ? config.TIMEZONE_OFFSET_HOURS : 1;
  const d = new Date(new Date(isoString).getTime() + offset * 3600000);
  return d.toISOString().split('T')[0];
}

// ── SHADOW / COUNTERFACTUAL FILTER HISTORY ──
const SHADOW_HISTORY_FILE = path.join(CACHE_DIR, 'shadow_history.json');

function loadShadowHistory() {
  if (fs.existsSync(SHADOW_HISTORY_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SHADOW_HISTORY_FILE, 'utf8'));
    } catch (e) {
      return [];
    }
  }
  return [];
}

function saveShadowHistory(history) {
  try {
    fs.writeFileSync(SHADOW_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch (e) {}
}

function recordShadowOutcome(outcomeData) {
  const history = loadShadowHistory();
  history.push({
    ...outcomeData,
    time: new Date().toISOString()
  });
  saveShadowHistory(history.slice(-300));
}

// ── INCUBATION PAIR FOOTPRINT HISTORY ──
const INCUBATION_HISTORY_FILE = path.join(CACHE_DIR, 'incubation_history.json');

function loadIncubationHistory() {
  if (fs.existsSync(INCUBATION_HISTORY_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(INCUBATION_HISTORY_FILE, 'utf8'));
    } catch (e) {
      return [];
    }
  }
  return [];
}

function saveIncubationHistory(history) {
  try {
    fs.writeFileSync(INCUBATION_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch (e) {}
}

function recordIncubationOutcome(outcomeData) {
  const history = loadIncubationHistory();
  history.push({
    ...outcomeData,
    time: new Date().toISOString()
  });
  saveIncubationHistory(history.slice(-500));
}

/**
 * 🎓 Incubation Graduation Engine (3-Gate Proof of Edge)
 * Evaluates whether an incubation pair has met the criteria to graduate to Live:
 *  - Gate 1: Minimum 5 completed paper trades
 *  - Gate 2: Win Rate >= 60.0%
 *  - Gate 3: Spans at least 2 distinct trading calendar days
 */
function checkIncubationGraduation(symbol) {
  const history = loadIncubationHistory();
  const symbolTrades = history.filter(t => t.symbol === symbol && (t.outcome === 'WIN' || t.outcome === 'LOSS'));
  
  const total = symbolTrades.length;
  const wins = symbolTrades.filter(t => t.outcome === 'WIN').length;
  const losses = symbolTrades.filter(t => t.outcome === 'LOSS').length;
  const winRate = total > 0 ? (wins / total) * 100 : 0;

  // Distinct trading dates (YYYY-MM-DD)
  const distinctDays = new Set(
    symbolTrades.map(t => (t.time ? t.time.slice(0, 10) : new Date().toISOString().slice(0, 10)))
  );

  const gate1Passed = total >= 5;
  const gate2Passed = winRate >= 60.0;
  const gate3Passed = distinctDays.size >= 2;
  const allPassed = gate1Passed && gate2Passed && gate3Passed;

  return {
    symbol,
    total,
    wins,
    losses,
    winRate: winRate.toFixed(1),
    daysCount: distinctDays.size,
    gate1Passed,
    gate2Passed,
    gate3Passed,
    allPassed
  };
}

/**
 * Records a new signal in history
 */
function recordSignal(signalData) {
  const history = loadTradeHistory();
  const existing = history.find(t => t.setupId === signalData.setupId);
  if (existing) return;

  history.push({
    setupId: signalData.setupId,
    symbol: signalData.symbol,
    type: signalData.type,
    entryPrice: signalData.entryPrice,
    stopLoss: signalData.stopLoss,
    takeProfit: signalData.takeProfit,
    confluenceScore: signalData.confluenceScore,
    signalTime: new Date().toISOString(),
    status: 'SIGNALED',
    triggeredTime: null,
    closedTime: null,
    outcome: null,
    exitPrice: null,
    pnlUSD: 0,
    pnlR: 0,
    aiVisionVerdict: signalData.aiVisionVerdict || null,
    aiVisionReason: signalData.aiVisionReason || null,
    aiVisionConfidence: signalData.aiVisionConfidence || null
  });

  saveTradeHistory(history);
}

/**
 * Updates a signal when it is triggered / filled
 */
function recordTrigger(setupId) {
  const history = loadTradeHistory();
  const trade = history.find(t => t.setupId === setupId);
  if (trade) {
    trade.status = 'ACTIVE';
    trade.triggeredTime = trade.triggeredTime || new Date().toISOString();
    saveTradeHistory(history);
  }
}

/**
 * Updates a trade when it hits TP, SL, or Breakeven
 */
function recordClose(setupId, outcome, exitPrice, pnlUSD, pnlR, aiVisionVerdict) {
  const history = loadTradeHistory();
  const trade = history.find(t => t.setupId === setupId);
  if (trade) {
    trade.status = 'CLOSED';
    trade.closedTime = new Date().toISOString();
    trade.outcome = outcome; // 'WIN', 'LOSS', 'BREAKEVEN'
    trade.exitPrice = exitPrice;
    trade.pnlUSD = pnlUSD;
    trade.pnlR = pnlR;
    if (aiVisionVerdict) trade.aiVisionVerdict = aiVisionVerdict;
    saveTradeHistory(history);

    // Persist permanently to Master Backtesting Archive (JSON & CSV)
    appendTradeToMasterArchive(trade);
  }
}

/**
 * Generate End of Day (EOD) Report
 */
function generateDailyReport(targetDateStr) {
  const history = loadTradeHistory();
  
  if (!targetDateStr) {
    // Default to yesterday's date in trader local timezone
    const offset = config.TIMEZONE_OFFSET_HOURS !== undefined ? config.TIMEZONE_OFFSET_HOURS : 1;
    const localNow = new Date(Date.now() + offset * 3600000);
    const d = new Date(localNow.getTime() - 24 * 60 * 60 * 1000);
    targetDateStr = d.toISOString().split('T')[0];
  }

  // Prior cumulative PnL for starting balance
  const priorClosed = history.filter(t => t.closedTime && getDateString(t.closedTime) < targetDateStr);
  let priorPnL = 0;
  priorClosed.forEach(t => priorPnL += (t.pnlUSD || 0));

  const startingBalance = (config.STARTING_BALANCE || 100.0) + priorPnL;

  // Signals, triggered, and closed on target date
  const signalsToday = history.filter(t => getDateString(t.signalTime) === targetDateStr);
  const triggeredToday = history.filter(t => getDateString(t.triggeredTime) === targetDateStr);
  const closedToday = history.filter(t => getDateString(t.closedTime) === targetDateStr);

  let wins = 0, losses = 0, breakevens = 0, netUSD = 0, netR = 0;
  const perSymbol = {};

  closedToday.forEach(t => {
    if (!perSymbol[t.symbol]) {
      perSymbol[t.symbol] = { wins: 0, losses: 0, breakevens: 0, pnlUSD: 0, pnlR: 0, total: 0 };
    }

    perSymbol[t.symbol].total++;

    if (t.outcome === 'WIN') {
      wins++;
      perSymbol[t.symbol].wins++;
    } else if (t.outcome === 'BREAKEVEN') {
      breakevens++;
      perSymbol[t.symbol].breakevens++;
    } else if (t.outcome === 'LOSS') {
      losses++;
      perSymbol[t.symbol].losses++;
    }
    
    netUSD += (t.pnlUSD || 0);
    netR += (t.pnlR || 0);
    perSymbol[t.symbol].pnlUSD += (t.pnlUSD || 0);
    perSymbol[t.symbol].pnlR += (t.pnlR || 0);
  });

  const totalClosed = closedToday.length;
  const winRate = totalClosed > 0 ? ((wins / totalClosed) * 100).toFixed(1) : "0.0";
  const newBalance = startingBalance + netUSD;

  // Identify MVP Pair of the Day
  let mvpSymbol = "None";
  let mvpPnL = -Infinity;
  let mvpStats = "";
  Object.keys(perSymbol).forEach(s => {
    if (perSymbol[s].pnlUSD > mvpPnL) {
      mvpPnL = perSymbol[s].pnlUSD;
      mvpSymbol = s;
      mvpStats = `${perSymbol[s].wins}W / ${perSymbol[s].losses}L (+$${perSymbol[s].pnlUSD.toFixed(2)})`;
    }
  });

  // ── AI VISION SHADOW AUDIT AGGREGATION ──
  let aiAudited = 0;
  let aiTakeWins = 0;
  let aiTakeLosses = 0;
  let aiLeaveLossesSaved = 0;
  let aiLeaveWinsMissed = 0;
  let aiHypotheticalPnl = 0;

  closedToday.forEach(t => {
    if (t.aiVisionVerdict) {
      aiAudited++;
      if (t.aiVisionVerdict === 'TAKE') {
        if (t.outcome === 'WIN') aiTakeWins++;
        if (t.outcome === 'LOSS') aiTakeLosses++;
        aiHypotheticalPnl += (t.pnlUSD || 0);
      } else if (t.aiVisionVerdict === 'LEAVE') {
        if (t.outcome === 'LOSS') aiLeaveLossesSaved++;
        if (t.outcome === 'WIN') aiLeaveWinsMissed++;
      }
    }
  });

  const aiTakeTotal = aiTakeWins + aiTakeLosses;
  const aiWinRate = aiTakeTotal > 0 ? ((aiTakeWins / aiTakeTotal) * 100).toFixed(1) : "N/A";

  return {
    period: 'DAILY',
    date: targetDateStr,
    startingBalance,
    newBalance,
    signalsCount: signalsToday.length,
    triggeredCount: triggeredToday.length,
    closedCount: totalClosed,
    wins,
    losses,
    breakevens,
    winRate,
    netUSD,
    netR,
    perSymbol,
    mvpSymbol: mvpPnL > 0 ? `${mvpSymbol} [${mvpStats}]` : "Balanced",
    closedTrades: closedToday,
    aiStats: {
      aiAudited,
      aiTakeWins,
      aiTakeLosses,
      aiLeaveLossesSaved,
      aiLeaveWinsMissed,
      aiHypotheticalPnl,
      aiWinRate
    }
  };
}

const WEEKLY_ANCHOR_FILE = path.join(CACHE_DIR, 'weekly_anchor_balance.json');

function getWeeklyAnchorBalance() {
  if (fs.existsSync(WEEKLY_ANCHOR_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(WEEKLY_ANCHOR_FILE, 'utf8'));
      if (data && typeof data.anchorBalance === 'number' && data.anchorBalance > 0) {
        return data.anchorBalance;
      }
    } catch (e) {
      console.warn("[reportManager] Error reading weekly anchor balance:", e.message);
    }
  }
  const currentBalance = getCurrentAccountBalance();
  saveWeeklyAnchorBalance(currentBalance);
  return currentBalance;
}

function saveWeeklyAnchorBalance(balance) {
  try {
    fs.writeFileSync(WEEKLY_ANCHOR_FILE, JSON.stringify({
      anchorBalance: parseFloat(balance.toFixed(2)),
      updatedAt: new Date().toISOString()
    }, null, 2), 'utf8');
  } catch (e) {
    console.warn("[reportManager] Error saving weekly anchor balance:", e.message);
  }
}

/**
 * Generate End of Week (EOW) Report with Weekly Compounding Re-Anchor
 */
function generateWeeklyReport() {
  const history = loadTradeHistory();
  const now = new Date();
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const closedThisWeek = history.filter(t => t.closedTime && new Date(t.closedTime) >= oneWeekAgo);

  let wins = 0, losses = 0, breakevens = 0, netUSD = 0, netR = 0;
  const perSymbol = {};

  closedThisWeek.forEach(t => {
    if (!perSymbol[t.symbol]) {
      perSymbol[t.symbol] = { wins: 0, losses: 0, breakevens: 0, pnlUSD: 0, pnlR: 0, total: 0 };
    }
    perSymbol[t.symbol].total++;

    if (t.outcome === 'WIN') {
      wins++;
      perSymbol[t.symbol].wins++;
    } else if (t.outcome === 'BREAKEVEN') {
      breakevens++;
      perSymbol[t.symbol].breakevens++;
    } else if (t.outcome === 'LOSS') {
      losses++;
      perSymbol[t.symbol].losses++;
    }

    netUSD += (t.pnlUSD || 0);
    netR += (t.pnlR || 0);
    perSymbol[t.symbol].pnlUSD += (t.pnlUSD || 0);
    perSymbol[t.symbol].pnlR += (t.pnlR || 0);
  });

  const totalClosed = closedThisWeek.length;
  const winRate = totalClosed > 0 ? ((wins / totalClosed) * 100).toFixed(1) : "0.0";

  const previousAnchorBalance = getWeeklyAnchorBalance();
  const newAccountBalance = getCurrentAccountBalance();

  let mvpSymbol = "None";
  let mvpPnL = -Infinity;
  let mvpStats = "";
  Object.keys(perSymbol).forEach(s => {
    if (perSymbol[s].pnlUSD > mvpPnL) {
      mvpPnL = perSymbol[s].pnlUSD;
      mvpSymbol = s;
      mvpStats = `${perSymbol[s].wins}W / ${perSymbol[s].losses}L (+$${perSymbol[s].pnlUSD.toFixed(2)})`;
    }
  });

  // Re-anchor weekly balance for upcoming week
  saveWeeklyAnchorBalance(newAccountBalance);

  return {
    period: 'WEEKLY',
    startingBalance: previousAnchorBalance,
    newBalance: newAccountBalance,
    closedCount: totalClosed,
    wins,
    losses,
    breakevens,
    winRate,
    netUSD,
    netR,
    perSymbol,
    mvpSymbol: mvpPnL > 0 ? `${mvpSymbol} [${mvpStats}]` : "Balanced",
    closedTrades: closedThisWeek
  };
}

/**
 * Generate End of Month (EOM) Report
 */
function generateMonthlyReport(yearMonthStr = new Date().toISOString().slice(0, 7)) {
  const history = loadTradeHistory();
  const closedThisMonth = history.filter(t => t.closedTime && t.closedTime.startsWith(yearMonthStr));

  let wins = 0, losses = 0, breakevens = 0, netUSD = 0, netR = 0;
  const perSymbol = {};

  closedThisMonth.forEach(t => {
    if (!perSymbol[t.symbol]) {
      perSymbol[t.symbol] = { wins: 0, losses: 0, breakevens: 0, pnlUSD: 0, pnlR: 0, total: 0 };
    }
    perSymbol[t.symbol].total++;

    if (t.outcome === 'WIN') {
      wins++;
      perSymbol[t.symbol].wins++;
    } else if (t.outcome === 'BREAKEVEN') {
      breakevens++;
      perSymbol[t.symbol].breakevens++;
    } else if (t.outcome === 'LOSS') {
      losses++;
      perSymbol[t.symbol].losses++;
    }

    netUSD += (t.pnlUSD || 0);
    netR += (t.pnlR || 0);
    perSymbol[t.symbol].pnlUSD += (t.pnlUSD || 0);
    perSymbol[t.symbol].pnlR += (t.pnlR || 0);
  });

  const totalClosed = closedThisMonth.length;
  const winRate = totalClosed > 0 ? ((wins / totalClosed) * 100).toFixed(1) : "0.0";

  return {
    period: 'MONTHLY',
    yearMonth: yearMonthStr,
    closedCount: totalClosed,
    wins,
    losses,
    breakevens,
    winRate,
    netUSD,
    netR,
    perSymbol,
    closedTrades: closedThisMonth
  };
}

/**
 * Formats report object into beautiful HTML Telegram Message
 */
function formatReportTelegramHTML(report) {
  const isPositive = report.netUSD >= 0;
  const emojiHeader = report.period === 'DAILY' ? '📅' : (report.period === 'WEEKLY' ? '📊' : '🏛️');
  const periodTitle = report.period === 'DAILY' 
    ? `DAILY PERFORMANCE REPORT (${report.date})`
    : (report.period === 'WEEKLY' ? `WEEKLY PERFORMANCE REPORT` : `END-OF-MONTH REPORT (${report.yearMonth})`);

  const startBalLabel = report.period === 'WEEKLY' ? "Previous Week Start Balance:" : "Yesterday's Start Balance:";

  let stratName = "Strategy 5B Enhanced (Value-Zone Momentum Sniper)";
  try {
    const dynamicStatePath = path.join(CACHE_DIR, 'dynamic_state.json');
    if (fs.existsSync(dynamicStatePath)) {
      const ds = JSON.parse(fs.readFileSync(dynamicStatePath, 'utf8'));
      if (ds.mode6pro === 'LIVE' && ds.mode5b === 'PAPER') {
        stratName = "Strategy 6 Pro Live (GodEyes SMC) | 5B Paper Sandbox";
      } else if (ds.mode6pro === 'LIVE' || ds.activeStrategy === 'STRATEGY_6_PRO') {
        stratName = "Strategy 6 Pro (GodEyes SMC Institutional Sniper)";
      } else if (ds.activeStrategy === 'BOTH') {
        stratName = "Dual Engine (5B Live / 6 Pro Paper)";
      }
    }
  } catch (e) {}

  const lines = [
    `👑 ${emojiHeader} <b>[MYTRADA ${periodTitle}]</b>`,
    `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
    `<b>Strategy:</b> <code>${stratName}</code>`,
    `<b>Positions Closed:</b> <code>${report.closedCount}</code>`,
    `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
    `🟢 <b>Winning Trades:</b> <code>${report.wins} Wins</code>`,
    `🔴 <b>Losing Trades:</b> <code>${report.losses} Losses</code>`,
    `📊 <b>Win Rate:</b> <code>${report.winRate}%</code>`,
    `🏆 <b>Top Winning Pair (MVP):</b> <code>${report.mvpSymbol || 'N/A'}</code>`,
    `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
    `💵 <b>${startBalLabel}</b> <code>$${(report.startingBalance || 100.0).toFixed(2)} USD</code>`,
    `💰 <b>New Account Balance:</b> <code>$${(report.newBalance || 100.0).toFixed(2)} USD</code>`,
    `📈 <b>Net Realized PnL:</b> <code>${isPositive ? '+' : '-'}$${Math.abs(report.netUSD).toFixed(2)} USD (${isPositive ? '+' : ''}${report.netR.toFixed(1)}R)</code>`,
    `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`
  ];

  // ── PAIR-BY-PAIR PERFORMANCE SUMMARY ──
  const perSymbol = report.perSymbol || {};
  const symbolKeys = Object.keys(perSymbol);
  if (symbolKeys.length > 0) {
    lines.push(`📊 <b>PAIRS TRADED BREAKDOWN:</b>`);
    symbolKeys.forEach(sym => {
      const s = perSymbol[sym];
      const pnlSign = s.pnlUSD >= 0 ? '+' : '-';
      const wr = s.total > 0 ? ((s.wins / s.total) * 100).toFixed(0) : '0';
      const statusEmoji = s.pnlUSD > 0 ? '🟢' : (s.pnlUSD < 0 ? '🔴' : '⚪');
      lines.push(`${statusEmoji} <b>${sym}:</b> <code>${s.total} Trades (${s.wins}W / ${s.losses}L) • ${wr}% WR • ${pnlSign}$${Math.abs(s.pnlUSD).toFixed(2)} (${pnlSign}${Math.abs(s.pnlR).toFixed(1)}R)</code>`);
    });
    lines.push(`<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`);
  }

  // ── WEEKLY COMPOUNDING RE-ANCHOR (SUNDAY END-OF-WEEK ONLY) ──
  if (report.period === 'WEEKLY') {
    const riskPercent = config.RISK_PERCENT || 3.0;
    const newWeekRisk = Math.max(config.MIN_RISK_AMOUNT_USD || 3.0, (report.newBalance * (riskPercent / 100)));
    const newWeekTP = newWeekRisk * (config.REWARD_RATIO || 1.3);
    const growthSign = report.newBalance >= report.startingBalance ? '📈' : '🛡️';
    const growthLabel = report.newBalance >= report.startingBalance ? 'SCALED UP' : 'SCALED DOWN (PROTECTION)';
    
    lines.push(`👑 ${growthSign} <b>[MYTRADA WEEKLY COMPOUNDING RE-ANCHOR]</b>`);
    lines.push(`<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`);
    lines.push(`💵 <b>Previous Week Start Balance:</b> <code>$${report.startingBalance.toFixed(2)} USD</code>`);
    lines.push(`💰 <b>New Week Account Balance:</b> <code>$${report.newBalance.toFixed(2)} USD</code>`);
    lines.push(`🎯 <b>This Week's Fixed Trade Risk (3.0%):</b> <code>$${newWeekRisk.toFixed(2)} USD / trade (${growthLabel})</code>`);
    lines.push(`🏆 <b>This Week's Target TP (1.3R):</b> <code>+$${newWeekTP.toFixed(2)} USD / win</code>`);
    lines.push(`<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`);
    lines.push(`🚀 <i>Position sizes locked for the upcoming week's trading sessions!</i>`);
    lines.push(`<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`);
  }

  // ── PAPER FORWARD TEST / INCUBATION AUDIT SUMMARY ──
  const incubationHistory = loadIncubationHistory();
  const incTargetDate = report.date || report.targetDateStr || new Date().toISOString().split('T')[0];
  const incToday = incubationHistory.filter(s => getDateString(s.time) === incTargetDate);
  if (incToday.length > 0) {
    const incWins = incToday.filter(s => s.outcome === 'WIN');
    const incLosses = incToday.filter(s => s.outcome === 'LOSS');
    const incWinRate = incToday.length > 0 ? ((incWins.length / incToday.length) * 100).toFixed(1) : '0.0';
    const incProfitUSD = incToday.reduce((acc, s) => acc + (s.pnlUSD || 0), 0);
    const incNetR = incToday.reduce((acc, s) => acc + (s.rMultiple || s.pnlR || 0), 0);

    // Group by symbol
    const incPerSymbol = {};
    incToday.forEach(s => {
      const sym = s.symbol || 'OTHER';
      if (!incPerSymbol[sym]) incPerSymbol[sym] = { wins: 0, losses: 0, total: 0, pnlUSD: 0, pnlR: 0 };
      incPerSymbol[sym].total++;
      if (s.outcome === 'WIN') incPerSymbol[sym].wins++;
      else if (s.outcome === 'LOSS') incPerSymbol[sym].losses++;
      incPerSymbol[sym].pnlUSD += (s.pnlUSD || 0);
      incPerSymbol[sym].pnlR += (s.rMultiple || s.pnlR || 0);
    });

    lines.push(`🔬 <b>[PAPER FORWARD TEST — DAILY SUMMARY]</b>`);
    lines.push(`<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`);
    lines.push(`🧪 <b>Paper Sandbox Trades:</b> <code>${incToday.length} Trades (${incWins.length}W / ${incLosses.length}L • ${incWinRate}% WR)</code>`);
    lines.push(`📈 <b>Theoretical Net PnL:</b> <code>${incProfitUSD >= 0 ? '+' : ''}$${incProfitUSD.toFixed(2)} USD (${incNetR >= 0 ? '+' : ''}${incNetR.toFixed(1)}R)</code>`);
    lines.push(`💵 <b>Live Capital Impact:</b> <code>$0.00 USD (Real Risk Zero)</code>`);
    
    const symKeys = Object.keys(incPerSymbol);
    if (symKeys.length > 0) {
      lines.push(`📊 <b>Paper Setups by Pair:</b>`);
      symKeys.forEach(sym => {
        const item = incPerSymbol[sym];
        const sign = item.pnlUSD >= 0 ? '+' : '-';
        const emoji = item.pnlUSD > 0 ? '🟢' : (item.pnlUSD < 0 ? '🔴' : '⚪');
        lines.push(`${emoji} <b>${sym}:</b> <code>${item.total} Trades (${item.wins}W / ${item.losses}L) • ${sign}$${Math.abs(item.pnlUSD).toFixed(2)} (${sign}${Math.abs(item.pnlR).toFixed(1)}R)</code>`);
      });
    }
    lines.push(`<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`);
  }

  return lines.join('\n');
}

/**
 * Calculates current live account balance based on starting balance + cumulative realized PnL
 */
function getCurrentAccountBalance() {
  const history = loadTradeHistory();
  let cumulativePnL = 0;
  history.forEach(t => {
    if (t.status === 'CLOSED') {
      cumulativePnL += (t.pnlUSD || 0);
    }
  });
  return (config.STARTING_BALANCE || 100.0) + cumulativePnL;
}

/**
 * Returns active weekly compounded trade risk, reward target, and account balance.
 * Trade risk is fixed based on the Weekly Anchor Balance set at the start of each week.
 */
function getWeeklyCompoundedRisk(customPercent = null) {
  const anchorBalance = getWeeklyAnchorBalance();
  const liveBalance = getCurrentAccountBalance();
  let riskPercent = config.RISK_PERCENT || 3.0;

  if (customPercent && typeof customPercent === 'number' && customPercent > 0) {
    riskPercent = customPercent;
  } else {
    const dynamicStatePath = path.join(CACHE_DIR, 'dynamic_state.json');
    if (fs.existsSync(dynamicStatePath)) {
      try {
        const ds = JSON.parse(fs.readFileSync(dynamicStatePath, 'utf8'));
        if (ds && typeof ds.customRiskPercent === 'number' && ds.customRiskPercent > 0) {
          riskPercent = ds.customRiskPercent;
        }
      } catch (e) {}
    }
  }
  
  if (!config.DYNAMIC_RISK_COMPOUNDING) {
    const fallbackRisk = config.RISK_AMOUNT_USD || 3.0;
    return {
      balance: parseFloat(anchorBalance.toFixed(2)),
      liveBalance: parseFloat(liveBalance.toFixed(2)),
      riskUSD: fallbackRisk,
      rewardUSD: parseFloat((fallbackRisk * (config.REWARD_RATIO || 1.3)).toFixed(2)),
      riskPercent
    };
  }

  const rawRisk = anchorBalance * (riskPercent / 100);
  const minRiskFloor = config.MIN_RISK_AMOUNT_USD || 3.0;
  const riskUSD = parseFloat(Math.max(minRiskFloor, rawRisk).toFixed(2));
  const rewardUSD = parseFloat((riskUSD * (config.REWARD_RATIO || 1.3)).toFixed(2));

  return {
    balance: parseFloat(anchorBalance.toFixed(2)),
    liveBalance: parseFloat(liveBalance.toFixed(2)),
    riskUSD,
    rewardUSD,
    riskPercent
  };
}

module.exports = {
  recordSignal,
  recordTrigger,
  recordClose,
  generateDailyReport,
  generateWeeklyReport,
  generateMonthlyReport,
  formatReportTelegramHTML,
  getCurrentAccountBalance,
  getWeeklyAnchorBalance,
  saveWeeklyAnchorBalance,
  getWeeklyCompoundedRisk,
  getDailyCompoundedRisk: getWeeklyCompoundedRisk,
  loadShadowHistory,
  recordShadowOutcome,
  loadIncubationHistory,
  recordIncubationOutcome,
  checkIncubationGraduation
};
