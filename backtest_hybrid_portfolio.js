// backtest_hybrid_portfolio.js
/**
 * 1-Month SMC Historical Backtest: OPTIMAL HYBRID PORTFOLIO
 * Combines the quantitatively superior strategy for each specific asset:
 *  - CRASH500, CRASH1000, CRASH600 -> SPIKE_CATCHING (SELL ONLY - Catching Downward Spikes)
 *  - BOOM500, BOOM1000, BOOM900    -> TICK_SCALPING  (SELL ONLY - Micro-candle harvesting)
 *  - 1HZ100V                       -> BOTH           (Standard two-way SMC)
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getHistoricalCandles } = require('./dataFetcher');
const { runBacktest } = require('./backtester');

config.DEFAULT_HTF = '1h';
config.DEFAULT_LTF = '5m';

const HYBRID_PORTFOLIO = {
  "BOOM500":   { name: "Boom 500 Index",            mode: "TICK_SCALPING" },
  "CRASH500":  { name: "Crash 500 Index",           mode: "SPIKE_CATCHING" },
  "BOOM1000":  { name: "Boom 1000 Index",           mode: "TICK_SCALPING" },
  "CRASH1000": { name: "Crash 1000 Index",          mode: "SPIKE_CATCHING" },
  "CRASH600":  { name: "Crash 600 Index",           mode: "SPIKE_CATCHING" },
  "1HZ100V":   { name: "Volatility 100 (1s) Index", mode: "BOTH" }
};

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

async function main() {
  const months = 1;
  console.log(`\n${BOLD}${CYAN}=================================================================================================`);
  console.log(`🏆 1-MONTH HISTORICAL BACKTEST: OPTIMAL HYBRID SCALPING PORTFOLIO`);
  console.log(`=================================================================================================${RESET}`);
  console.log(`Timeframe Matrix : LTF = ${config.DEFAULT_LTF} | HTF Filter = ${config.DEFAULT_HTF} (50 EMA)`);
  console.log(`Risk Settings    : Risk per Trade = 1% | Target Reward-to-Risk = ${config.REWARD_RATIO}:1`);
  console.log(`Starting Balance : $${config.STARTING_BALANCE.toLocaleString()} per asset`);
  console.log(`-------------------------------------------------------------------------------------------------`);

  const symbols = Object.keys(HYBRID_PORTFOLIO);
  const reports = [];

  for (const symbol of symbols) {
    const item = HYBRID_PORTFOLIO[symbol];
    config.BOOM_CRASH_MODE = item.mode;

    console.log(`\n- Running ${CYAN}${symbol}${RESET} (${item.name}) in ${BOLD}${item.mode}${RESET} mode...`);
    try {
      const ltfCandles = await getHistoricalCandles(symbol, config.DEFAULT_LTF, months, false);
      const htfCandles = await getHistoricalCandles(symbol, config.DEFAULT_HTF, months, false);

      const report = runBacktest(symbol, ltfCandles, htfCandles);
      report.name = item.name;
      report.mode = item.mode;
      reports.push(report);
    } catch (err) {
      console.error(`❌ Error backtesting ${symbol}:`, err.message);
    }
  }

  reports.sort((a, b) => b.roi - a.roi);

  console.log(`\n${BOLD}================================= HYBRID PORTFOLIO PERFORMANCE REPORT =================================${RESET}`);
  const tableHeader = String.prototype.concat(
    `| ${"Asset".padEnd(10)} | `,
    `${"Optimal Mode".padEnd(16)} | `,
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
      `${r.mode.padEnd(16)} | `,
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

  console.log(`\n${BOLD}${CYAN}📊 CONSOLIDATED HYBRID PORTFOLIO METRICS (1 MONTH):${RESET}`);
  console.log(`-------------------------------------------------------------------------------------------------`);
  console.log(`🟢 Total Portfolio Trades Executed : ${BOLD}${totalTrades}${RESET}`);
  console.log(`🟢 Overall Portfolio Win Rate      : ${BOLD}${winRate.toFixed(2)}%${RESET} (${totalWins} Wins / ${totalTrades - totalWins} Losses)`);
  console.log(`🟢 Total Net Realized Profit       : ${BOLD}${netProfit >= 0 ? GREEN : RED}${netProfit >= 0 ? "+" : ""}$${netProfit.toFixed(2)}${RESET}`);
  console.log(`🟢 Portfolio Consolidated ROI      : ${BOLD}${netProfit >= 0 ? GREEN : RED}${netProfit >= 0 ? "+" : ""}${portfolioROI.toFixed(2)}%${RESET} (on $${totalStartingBalance.toLocaleString()} total capital)`);
  console.log(`🔴 Max Drawdown Exposure           : ${BOLD}${RED}${maxDrawdown.toFixed(2)}%${RESET}`);
  console.log(`=================================================================================================\n`);
}

main().catch(console.error);
