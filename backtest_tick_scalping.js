// backtest_tick_scalping.js
/**
 * 1-Month SMC Historical Backtest: TICK-SCALPING STRATEGY
 * Rules:
 *  - Boom Pairs  (BOOM1000, BOOM900, BOOM600, BOOM500)   -> SELL ONLY (Micro-candle harvesting between spikes)
 *  - Crash Pairs (CRASH1000, CRASH900, CRASH600, CRASH500) -> BUY ONLY  (Micro-candle harvesting between spikes)
 * Timeframe: LTF = 5m | HTF = 1h (50 EMA)
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getHistoricalCandles } = require('./dataFetcher');
const { runBacktest } = require('./backtester');

// Enforce Tick-Scalping Mode programmatically
config.BOOM_CRASH_MODE = 'TICK_SCALPING';
config.DEFAULT_HTF = '1h';
config.DEFAULT_LTF = '5m';

const BOOM_CRASH_SYMBOLS = {
  "BOOM1000":  "Boom 1000 Index",
  "BOOM900":   "Boom 900 Index",
  "BOOM600":   "Boom 600 Index",
  "BOOM500":   "Boom 500 Index",
  "CRASH1000": "Crash 1000 Index",
  "CRASH900":  "Crash 900 Index",
  "CRASH600":  "Crash 600 Index",
  "CRASH500":  "Crash 500 Index"
};

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";

async function main() {
  const months = 1; // 1 Month historical depth
  console.log(`\n${BOLD}${CYAN}=================================================================================================`);
  console.log(`⚡ 1-MONTH HISTORICAL BACKTEST: TICK-SCALPING STRATEGY`);
  console.log(`=================================================================================================${RESET}`);
  console.log(`Operating Mode   : TICK_SCALPING (Boom = SELL ONLY | Crash = BUY ONLY)`);
  console.log(`Timeframe Matrix : LTF = ${config.DEFAULT_LTF} | HTF Filter = ${config.DEFAULT_HTF} (50 EMA)`);
  console.log(`Risk Settings    : Risk per Trade = 1% | Target Reward-to-Risk = ${config.REWARD_RATIO}:1`);
  console.log(`Starting Balance : $${config.STARTING_BALANCE.toLocaleString()} per asset`);
  console.log(`Asset Portfolio  : All 8 Boom & Crash Pairs`);
  console.log(`-------------------------------------------------------------------------------------------------`);
  console.log(`Loading 1-Month historical 5m & 1h candle data...`);

  const symbols = Object.keys(BOOM_CRASH_SYMBOLS);
  const reports = [];

  for (const symbol of symbols) {
    console.log(`\n- Loading data for ${CYAN}${symbol}${RESET} (${BOOM_CRASH_SYMBOLS[symbol]})...`);
    try {
      const ltfCandles = await getHistoricalCandles(symbol, config.DEFAULT_LTF, months, false);
      const htfCandles = await getHistoricalCandles(symbol, config.DEFAULT_HTF, months, false);

      console.log(`  * Loaded ${ltfCandles.length} LTF (${config.DEFAULT_LTF}) candles and ${htfCandles.length} HTF (${config.DEFAULT_HTF}) candles.`);
      console.log(`  * Running chronological Tick-Scalping backtest...`);

      const report = runBacktest(symbol, ltfCandles, htfCandles);
      report.name = BOOM_CRASH_SYMBOLS[symbol];
      reports.push(report);
    } catch (err) {
      console.error(`❌ Error backtesting ${symbol}:`, err.message);
    }
  }

  // Sort reports by ROI descending
  reports.sort((a, b) => b.roi - a.roi);

  // Formatted Output Table
  console.log(`\n${BOLD}================================= TICK-SCALPING PERFORMANCE REPORT =================================${RESET}`);
  const tableHeader = String.prototype.concat(
    `| ${"Asset".padEnd(10)} | `,
    `${"Asset Full Name".padEnd(20)} | `,
    `${"Trades".padStart(6)} | `,
    `${"Wins".padStart(4)} | `,
    `${"Losses".padStart(6)} | `,
    `${"Win Rate".padStart(8)} | `,
    `${"Net Profit".padStart(12)} | `,
    `${"ROI (%)".padStart(8)} | `,
    `${"Max DD".padStart(8)} |`
  );
  console.log(tableHeader);
  console.log("-".repeat(tableHeader.length));

  reports.forEach(r => {
    const isRoiNeg = r.roi < 0;
    const roiColor = isRoiNeg ? RED : GREEN;
    const profitSign = r.netProfit >= 0 ? "+" : "";

    const row = String.prototype.concat(
      `| ${CYAN}${r.symbol.padEnd(10)}${RESET} | `,
      `${r.name.padEnd(20)} | `,
      `${r.totalTrades.toString().padStart(6)} | `,
      `${GREEN}${r.wins.toString().padStart(4)}${RESET} | `,
      `${RED}${r.losses.toString().padStart(6)}${RESET} | `,
      `${r.winRate.toFixed(2).padStart(7)}% | `,
      `${roiColor}${profitSign}$${r.netProfit.toFixed(2).padStart(10)}${RESET} | `,
      `${roiColor}${profitSign}${r.roi.toFixed(2).padStart(6)}%${RESET} | `,
      `${RED}${r.maxDrawdown.toFixed(2).padStart(6)}%${RESET} |`
    );
    console.log(row);
  });
  console.log("=".repeat(tableHeader.length));

  const totalTrades = reports.reduce((sum, r) => sum + r.totalTrades, 0);
  const totalWins = reports.reduce((sum, r) => sum + r.wins, 0);
  const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
  const netProfit = reports.reduce((sum, r) => sum + r.netProfit, 0);
  const totalStartingBalance = config.STARTING_BALANCE * reports.length;
  const portfolioROI = (netProfit / totalStartingBalance) * 100;
  const maxDrawdown = Math.max(...reports.map(r => r.maxDrawdown));

  console.log(`\n${BOLD}${CYAN}📊 CONSOLIDATED TICK-SCALPING METRICS (1 MONTH):${RESET}`);
  console.log(`-------------------------------------------------------------------------------------------------`);
  console.log(`🟢 Total Portfolio Trades Executed : ${BOLD}${totalTrades}${RESET}`);
  console.log(`🟢 Overall Portfolio Win Rate      : ${BOLD}${winRate.toFixed(2)}%${RESET} (${totalWins} Wins / ${totalTrades - totalWins} Losses)`);
  console.log(`🟢 Total Net Realized Profit       : ${BOLD}${netProfit >= 0 ? GREEN : RED}${netProfit >= 0 ? "+" : ""}$${netProfit.toFixed(2)}${RESET}`);
  console.log(`🟢 Portfolio Consolidated ROI      : ${BOLD}${netProfit >= 0 ? GREEN : RED}${netProfit >= 0 ? "+" : ""}${portfolioROI.toFixed(2)}%${RESET} (on $${totalStartingBalance.toLocaleString()} total capital)`);
  console.log(`🔴 Max Drawdown Exposure           : ${BOLD}${RED}${maxDrawdown.toFixed(2)}%${RESET}`);
  console.log(`=================================================================================================\n`);
}

main().catch(console.error);
