// exportTradesForBacktest.js
/**
 * Master Trade Archive & Backtest Export Engine for Mytrada
 * Aggregates all closed trades across live sessions, Telegram feeds, and system caches
 * into permanent, standardized JSON and CSV archives for quantitative backtesting.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const CACHE_DIR = path.join(__dirname, 'cache');
const MASTER_JSON = path.join(DATA_DIR, 'trades_master_backtest_archive.json');
const MASTER_CSV = path.join(DATA_DIR, 'trades_master_backtest_archive.csv');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJSON(filePath) {
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.warn(`[exportTrades] Error reading ${filePath}:`, e.message);
      return [];
    }
  }
  return [];
}

function syncMasterArchive() {
  console.log("=== MYTRADA MASTER TRADE ARCHIVE SYNC ===");

  const existingMaster = loadJSON(MASTER_JSON);
  const telegramHistory = loadJSON(path.join(DATA_DIR, 'telegram_live_trade_history.json'));
  const cacheHistory = loadJSON(path.join(CACHE_DIR, 'trade_history.json'));

  const tradeMap = new Map();

  // 1. Ingest existing master
  for (const t of existingMaster) {
    const key = t.setupId || `${t.symbol}_${t.date}_${t.time}`;
    tradeMap.set(key, t);
  }

  // 2. Ingest Telegram trade history (Sept 14 - Sept 23)
  for (const t of telegramHistory) {
    const date = t.date || (t.time ? t.time.slice(0, 10) : "");
    const time = t.time || `${date}T00:00:00Z`;
    const key = `${t.symbol}_${t.type}_${time}`;
    
    if (!tradeMap.has(key)) {
      tradeMap.set(key, {
        setupId: key,
        date,
        time,
        symbol: t.symbol,
        type: t.type === 'BUY' || t.type === 'bullish' ? 'BUY' : 'SELL',
        entryPrice: t.entry || 0,
        stopLoss: 0,
        takeProfit: 0,
        exitPrice: 0,
        outcome: t.outcome || 'UNKNOWN',
        pnlUSD: t.outcome === 'WIN' ? 1.3 : (t.outcome === 'LOSS' ? -1.0 : 0),
        pnlR: t.outcome === 'WIN' ? 1.3 : (t.outcome === 'LOSS' ? -1.0 : 0),
        confluenceScore: 10,
        strategy: "Strategy 5B Enhanced"
      });
    }
  }

  // 3. Ingest Cache trade history (detailed execution records)
  for (const t of cacheHistory) {
    if (t.status === 'CLOSED' || t.outcome) {
      const key = t.setupId || `${t.symbol}_${t.type}_${t.signalTime}`;
      tradeMap.set(key, {
        setupId: key,
        date: t.closedTime ? t.closedTime.slice(0, 10) : (t.signalTime ? t.signalTime.slice(0, 10) : ""),
        time: t.closedTime || t.signalTime || "",
        symbol: t.symbol,
        type: t.type === 'BUY' || t.type === 'bullish' ? 'BUY' : 'SELL',
        entryPrice: t.entryPrice || 0,
        stopLoss: t.stopLoss || 0,
        takeProfit: t.takeProfit || 0,
        exitPrice: t.exitPrice || 0,
        outcome: t.outcome || 'UNKNOWN',
        pnlUSD: t.pnlUSD || 0,
        pnlR: t.pnlR || (t.outcome === 'WIN' ? 1.3 : (t.outcome === 'LOSS' ? -1.0 : 0)),
        confluenceScore: t.confluenceScore || 10,
        strategy: "Strategy 5B Enhanced"
      });
    }
  }

  // Convert map to sorted array (chronological)
  const masterList = Array.from(tradeMap.values()).sort((a, b) => {
    const timeA = new Date(a.time || a.date).getTime() || 0;
    const timeB = new Date(b.time || b.date).getTime() || 0;
    return timeA - timeB;
  });

  // Save JSON
  fs.writeFileSync(MASTER_JSON, JSON.stringify(masterList, null, 2), 'utf8');

  // Generate CSV
  const headers = [
    "setupId",
    "date",
    "time",
    "symbol",
    "type",
    "entryPrice",
    "stopLoss",
    "takeProfit",
    "exitPrice",
    "outcome",
    "pnlUSD",
    "pnlR",
    "confluenceScore",
    "strategy"
  ];

  const csvRows = [headers.join(",")];
  for (const t of masterList) {
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

  fs.writeFileSync(MASTER_CSV, csvRows.join("\n"), 'utf8');

  // Calculate summary metrics
  const total = masterList.length;
  const wins = masterList.filter(t => t.outcome === 'WIN').length;
  const losses = masterList.filter(t => t.outcome === 'LOSS').length;
  const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : 0;
  const netR = masterList.reduce((acc, t) => acc + (Number(t.pnlR) || 0), 0).toFixed(2);

  console.log(`✅ Master Trade Archive Synced:`);
  console.log(`   • Total Trades Stored: ${total}`);
  console.log(`   • Wins: ${wins} | Losses: ${losses} | Win Rate: ${winRate}%`);
  console.log(`   • Cumulative Return: ${netR}R`);
  console.log(`   • JSON Archive: ${MASTER_JSON}`);
  console.log(`   • CSV Archive:  ${MASTER_CSV}`);

  return { total, wins, losses, winRate, netR };
}

if (require.main === module) {
  syncMasterArchive();
}

module.exports = {
  syncMasterArchive,
  MASTER_JSON,
  MASTER_CSV
};
