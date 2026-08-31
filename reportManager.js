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
const TRADE_HISTORY_FILE = path.join(CACHE_DIR, 'trade_history.json');

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
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

function getDateString(isoString) {
  if (!isoString) return "";
  return isoString.split('T')[0];
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
    pnlR: 0
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
function recordClose(setupId, outcome, exitPrice, pnlUSD, pnlR) {
  const history = loadTradeHistory();
  const trade = history.find(t => t.setupId === setupId);
  if (trade) {
    trade.status = 'CLOSED';
    trade.closedTime = new Date().toISOString();
    trade.outcome = outcome; // 'WIN', 'LOSS', 'BREAKEVEN'
    trade.exitPrice = exitPrice;
    trade.pnlUSD = pnlUSD;
    trade.pnlR = pnlR;
    saveTradeHistory(history);
  }
}

/**
 * Generate End of Day (EOD) Report
 */
function generateDailyReport(targetDateStr) {
  const history = loadTradeHistory();
  
  if (!targetDateStr) {
    // Default to yesterday's date if called at 12:00 AM midnight
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
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
    closedTrades: closedToday
  };
}

/**
 * Generate End of Week (EOW) Report
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

  return {
    period: 'WEEKLY',
    closedCount: totalClosed,
    wins,
    losses,
    breakevens,
    winRate,
    netUSD,
    netR,
    perSymbol,
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
    : (report.period === 'WEEKLY' ? `END-OF-WEEK PERFORMANCE REPORT` : `END-OF-MONTH REPORT (${report.yearMonth})`);

  const lines = [
    `👑 ${emojiHeader} <b>[MYTRADA ${periodTitle}]</b>`,
    `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
    `<b>Strategy:</b> <code>Strategy 5B High-Frequency Momentum Model</code>`,
    `<b>Signals Generated:</b> <code>${report.signalsCount || report.closedCount}</code>`,
    `<b>Positions Closed:</b> <code>${report.closedCount}</code>`,
    `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
    `🟢 <b>Winning Trades:</b> <code>${report.wins} Wins</code>`,
    `🔴 <b>Losing Trades:</b> <code>${report.losses} Losses</code>`,
    `📊 <b>Daily Win Rate:</b> <code>${report.winRate}%</code>`,
    `🏆 <b>Top Winning Pair (MVP):</b> <code>${report.mvpSymbol || 'N/A'}</code>`,
    `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
    `💵 <b>Yesterday's Start Balance:</b> <code>$${(report.startingBalance || 100.0).toFixed(2)} USD</code>`,
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

  // ── TRADE LIFECYCLE BREAKDOWN ──
  if (report.closedTrades && report.closedTrades.length > 0) {
    lines.push(`📋 <b>TRADE LIFECYCLE LOG:</b>`);
    report.closedTrades.forEach(t => {
      const outEmoji = t.outcome === 'WIN' ? '🟢 WIN (+1.3R)' : (t.outcome === 'BREAKEVEN' ? '🟡 BE' : '🔴 LOSS (-1.0R)');
      const sigTime = t.signalTime ? t.signalTime.slice(11, 16) : 'N/A';
      lines.push(`• <b>${t.symbol}</b>: ${outEmoji} @ ${sigTime}`);
    });
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
 * Returns active weekly compounded trade risk, reward target, and account balance
 */
function getWeeklyCompoundedRisk() {
  const currentBalance = getCurrentAccountBalance();
  const riskPercent = config.RISK_PERCENT || 3.0;
  
  if (!config.DYNAMIC_RISK_COMPOUNDING) {
    const fallbackRisk = config.RISK_AMOUNT_USD || 3.0;
    return {
      balance: parseFloat(currentBalance.toFixed(2)),
      riskUSD: fallbackRisk,
      rewardUSD: parseFloat((fallbackRisk * (config.REWARD_RATIO || 1.3)).toFixed(2)),
      riskPercent
    };
  }

  const rawRisk = currentBalance * (riskPercent / 100);
  const minRiskFloor = config.MIN_RISK_AMOUNT_USD || 3.0;
  const riskUSD = parseFloat(Math.max(minRiskFloor, rawRisk).toFixed(2));
  const rewardUSD = parseFloat((riskUSD * (config.REWARD_RATIO || 1.3)).toFixed(2));

  return {
    balance: parseFloat(currentBalance.toFixed(2)),
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
  getWeeklyCompoundedRisk
};
