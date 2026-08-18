// reportManager.js
/**
 * Senior Institutional Trade Logging & Periodic Performance Reporter.
 * Generates End-of-Day (EOD), End-of-Week (EOW), and End-of-Month (EOM) reports.
 * Tracks balance progression, win rates, net USD/R, and MVP winning pairs.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const TRADE_HISTORY_FILE = path.join(DATA_DIR, 'trade_history.json');

function loadTradeHistory() {
  if (fs.existsSync(TRADE_HISTORY_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(TRADE_HISTORY_FILE, 'utf8'));
    } catch (e) {
      console.error("[reportManager] Error reading trade_history.json:", e.message);
      return [];
    }
  }
  return [];
}

function saveTradeHistory(history) {
  fs.writeFileSync(TRADE_HISTORY_FILE, JSON.stringify(history, null, 2));
}

/**
 * Log new setup signal when detected
 */
function recordSignal(setup) {
  const history = loadTradeHistory();
  const existing = history.find(t => t.setupId === setup.setupId);
  if (!existing) {
    const record = {
      setupId: setup.setupId,
      symbol: setup.symbol,
      symbolName: config.SYMBOLS[setup.symbol] ? config.SYMBOLS[setup.symbol].name : setup.symbol,
      type: setup.type,
      entryPrice: setup.entryPrice,
      stopLoss: setup.stopLoss,
      takeProfit: setup.takeProfit,
      confluenceScore: setup.confluenceScore,
      status: 'PENDING', // PENDING | ACTIVE | CLOSED
      signalTime: new Date().toISOString(),
      triggeredTime: null,
      closedTime: null,
      outcome: null, // WIN | LOSS | BREAKEVEN
      pnlR: 0,
      pnlUSD: 0
    };
    history.push(record);
    saveTradeHistory(history);
  }
}

/**
 * Log when pending trade triggers entry price
 */
function recordTrigger(setupId) {
  const history = loadTradeHistory();
  const trade = history.find(t => t.setupId === setupId);
  if (trade && trade.status === 'PENDING') {
    trade.status = 'ACTIVE';
    trade.triggeredTime = new Date().toISOString();
    saveTradeHistory(history);
  }
}

/**
 * Log when trade closes (TP, SL, or BE)
 */
function recordClose(setupId, outcome, exitPrice, pnlUSD, pnlR) {
  const history = loadTradeHistory();
  const trade = history.find(t => t.setupId === setupId);
  if (trade) {
    trade.status = 'CLOSED';
    trade.closedTime = new Date().toISOString();
    trade.outcome = outcome; // WIN | LOSS | BREAKEVEN
    trade.exitPrice = exitPrice;
    trade.pnlUSD = pnlUSD;
    trade.pnlR = pnlR;
    saveTradeHistory(history);
  }
}

/**
 * Helper to get date string YYYY-MM-DD
 */
function getDateString(isoStr) {
  if (!isoStr) return "";
  return isoStr.split('T')[0];
}

/**
 * Generate End of Day (EOD) Report
 */
function generateDailyReport(targetDateStr) {
  const history = loadTradeHistory();
  
  if (!targetDateStr) {
    // Default to yesterday's date if called at midnight
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    targetDateStr = d.toISOString().split('T')[0];
  }

  // Trades closed before targetDateStr (Historical cumulative PnL for starting balance)
  const priorClosed = history.filter(t => t.closedTime && getDateString(t.closedTime) < targetDateStr);
  let priorPnL = 0;
  priorClosed.forEach(t => priorPnL += (t.pnlUSD || 0));

  const startingBalance = (config.STARTING_BALANCE || 100.0) + priorPnL;

  // Signals generated on target date
  const signalsToday = history.filter(t => getDateString(t.signalTime) === targetDateStr);
  // Trades triggered on target date
  const triggeredToday = history.filter(t => getDateString(t.triggeredTime) === targetDateStr);
  // Trades closed on target date (Realized PnL)
  const closedToday = history.filter(t => getDateString(t.closedTime) === targetDateStr);

  let wins = 0, losses = 0, breakevens = 0, netUSD = 0, netR = 0;
  const perSymbol = {};

  closedToday.forEach(t => {
    if (!perSymbol[t.symbol]) {
      perSymbol[t.symbol] = { wins: 0, losses: 0, pnlUSD: 0 };
    }

    if (t.outcome === 'WIN') {
      wins++;
      perSymbol[t.symbol].wins++;
    } else if (t.outcome === 'BREAKEVEN') {
      breakevens++;
    } else if (t.outcome === 'LOSS') {
      losses++;
      perSymbol[t.symbol].losses++;
    }
    
    netUSD += (t.pnlUSD || 0);
    netR += (t.pnlR || 0);
    perSymbol[t.symbol].pnlUSD += (t.pnlUSD || 0);
  });

  const totalClosed = closedToday.length;
  const winRate = totalClosed > 0 ? ((wins / totalClosed) * 100).toFixed(1) : "0.0";
  const newBalance = startingBalance + netUSD;

  // Identify MVP / Best Performing Pair of the Day
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
  closedThisWeek.forEach(t => {
    if (t.outcome === 'WIN') wins++;
    else if (t.outcome === 'BREAKEVEN') breakevens++;
    else if (t.outcome === 'LOSS') losses++;
    netUSD += (t.pnlUSD || 0);
    netR += (t.pnlR || 0);
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
  closedThisMonth.forEach(t => {
    if (t.outcome === 'WIN') wins++;
    else if (t.outcome === 'BREAKEVEN') breakevens++;
    else if (t.outcome === 'LOSS') losses++;
    netUSD += (t.pnlUSD || 0);
    netR += (t.pnlR || 0);
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
    ? `END-OF-DAY PERFORMANCE REPORT (${report.date})`
    : (report.period === 'WEEKLY' ? `END-OF-WEEK PERFORMANCE REPORT` : `END-OF-MONTH REPORT (${report.yearMonth})`);

  const lines = [
    `👑 ${emojiHeader} <b>[MYTRADA ${periodTitle}]</b>`,
    `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
    `<b>Strategy:</b> <code>Strategy 5 Enhanced (Multi-TF + 3 Spikes)</code>`,
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

  if (report.closedTrades && report.closedTrades.length > 0) {
    lines.push(`📋 <b>TRADE LIFECYCLE BREAKDOWN:</b>`);
    report.closedTrades.forEach(t => {
      const outEmoji = t.outcome === 'WIN' ? '🟢 WIN (+1.3R)' : (t.outcome === 'BREAKEVEN' ? '🟡 BE' : '🔴 LOSS (-1.0R)');
      const sigDate = t.signalTime ? t.signalTime.slice(11, 16) : 'N/A';
      lines.push(`• <b>${t.symbol}</b> (${t.type ? t.type.toUpperCase() : 'TRADE'}): ${outEmoji} @ ${sigDate}`);
    });
    lines.push(`<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`);
  } else {
    lines.push(`<i>No trades closed during this session.</i>`);
  }

  return lines.join('\n');
}

module.exports = {
  recordSignal,
  recordTrigger,
  recordClose,
  generateDailyReport,
  generateWeeklyReport,
  generateMonthlyReport,
  formatReportTelegramHTML
};
