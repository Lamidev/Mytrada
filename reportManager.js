// reportManager.js
/**
 * Senior Institutional Trade Logging & Periodic Performance Reporter.
 * Generates End-of-Day (EOD), End-of-Week (EOW), and End-of-Month (EOM) reports.
 * Solves multi-day pending order lifecycle accounting by tracking:
 * 1. signalTime    -> Timestamp when signal was generated
 * 2. triggeredTime -> Timestamp when order block tapped / position activated
 * 3. closedTime    -> Timestamp when trade hit TP (+2R), SL (-1R), or Break-Even ($0)
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
      symbolName: config.SYMBOLS[setup.symbol] || setup.symbol,
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
 * Groups closed trades strictly by closedTime date
 */
function generateDailyReport(targetDateStr = getDateString(new Date().toISOString())) {
  const history = loadTradeHistory();

  // Signals generated on target date
  const signalsToday = history.filter(t => getDateString(t.signalTime) === targetDateStr);
  // Trades triggered on target date
  const triggeredToday = history.filter(t => getDateString(t.triggeredTime) === targetDateStr);
  // Trades closed on target date (Realized PnL)
  const closedToday = history.filter(t => getDateString(t.closedTime) === targetDateStr);

  let wins = 0, losses = 0, breakevens = 0, netUSD = 0, netR = 0;

  closedToday.forEach(t => {
    if (t.outcome === 'WIN') wins++;
    else if (t.outcome === 'BREAKEVEN') breakevens++;
    else if (t.outcome === 'LOSS') losses++;
    netUSD += (t.pnlUSD || 0);
    netR += (t.pnlR || 0);
  });

  const totalClosed = closedToday.length;
  const winRate = totalClosed > 0 ? ((wins / totalClosed) * 100).toFixed(2) : "0.00";

  return {
    period: 'DAILY',
    date: targetDateStr,
    signalsCount: signalsToday.length,
    triggeredCount: triggeredToday.length,
    closedCount: totalClosed,
    wins,
    losses,
    breakevens,
    winRate,
    netUSD,
    netR,
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
  const winRate = totalClosed > 0 ? ((wins / totalClosed) * 100).toFixed(2) : "0.00";

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
  const winRate = totalClosed > 0 ? ((wins / totalClosed) * 100).toFixed(2) : "0.00";

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
    `${emojiHeader} <b>[SMC ${periodTitle}]</b>`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `<b>Signals Broadcasted:</b> <code>${report.signalsCount || 0}</code>`,
    `<b>Orders Triggered:</b> <code>${report.triggeredCount || 0}</code>`,
    `<b>Positions Closed:</b> <code>${report.closedCount}</code>`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `🟢 <b>Realized Wins (+$200 / +2R):</b> <code>${report.wins}</code>`,
    `🟡 <b>Risk-Free Break-Evens ($0):</b> <code>${report.breakevens}</code>`,
    `🔴 <b>Realized Losses (-$100 / -1R):</b> <code>${report.losses}</code>`,
    `📊 <b>Realized Win Rate:</b> <code>${report.winRate}%</code>`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `💰 <b>TOTAL NET REALIZED PnL:</b> <code>${isPositive ? '+' : ''}$${report.netUSD.toFixed(2)} USD (${isPositive ? '+' : ''}${report.netR.toFixed(2)}R)</code>`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`
  ];

  if (report.closedTrades && report.closedTrades.length > 0) {
    lines.push(`📋 <b>TRADE LIFECYCLE BREAKDOWN:</b>`);
    report.closedTrades.forEach(t => {
      const outEmoji = t.outcome === 'WIN' ? '🟢 WIN' : (t.outcome === 'BREAKEVEN' ? '🟡 BE' : '🔴 LOSS');
      const sigDate = t.signalTime ? t.signalTime.slice(5, 16).replace('T', ' ') : 'N/A';
      const trigDate = t.triggeredTime ? t.triggeredTime.slice(5, 16).replace('T', ' ') : 'N/A';
      lines.push(`• <b>${t.symbol}</b> (${t.type.toUpperCase()}): ${outEmoji} (Signal: ${sigDate} ➔ Trig: ${trigDate})`);
    });
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━`);
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
