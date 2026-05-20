// index.js
/**
 * Algo Market Structure (SMC) Portfolio CLI Backtester.
 * Runs high-fidelity, historical multi-pair simulation instantly in the terminal.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getCandles, getHistoricalCandles } = require('./dataFetcher');
const { runBacktest } = require('./backtester');

// ASCII Color codes for premium terminal formatting
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";

async function runCLIBacktester() {
  const args = process.argv.slice(2);
  let months = 12; // default to 1-year rigorous test
  let isQuick = false;

  if (args[0]) {
    if (args[0].toLowerCase() === 'quick') {
      isQuick = true;
    } else {
      const parsed = parseInt(args[0], 10);
      if (!isNaN(parsed) && parsed > 0) {
        months = parsed;
      }
    }
  }

  console.log(`\n${BOLD}${CYAN}=================================================================================================`);
  console.log(`🤖 ALGO MARKET STRUCTURE (SMC) PORTFOLIO BACKTESTER`);
  console.log(`=================================================================================================${RESET}`);
  console.log(`Timeframe Settings: LTF = ${config.DEFAULT_LTF} | HTF Filter = ${config.DEFAULT_HTF} (50 EMA)`);
  console.log(`Risk Settings: Risk per Trade = ${config.RISK_PERCENT}% | Target Reward-to-Risk = ${config.REWARD_RATIO}:1`);
  console.log(`Starting Balance per Asset: $${config.STARTING_BALANCE.toLocaleString()}`);
  
  if (isQuick) {
    console.log(`Simulation Mode  : QUICK (Runs over cached 2,000 candles)`);
  } else {
    console.log(`Simulation Mode  : RIGOROUS HISTORICAL (${months} Months depth)`);
  }
  console.log(`-------------------------------------------------------------------------------------------------`);
  console.log(`Compiling historical simulation logs... Please wait (chunked downloads trigger on fresh files)...`);

  const symbols = Object.keys(config.SYMBOLS);
  const reports = [];

  try {
    for (const symbol of symbols) {
      console.log(`\n- Preparing data for ${CYAN}${symbol}${RESET} (${config.SYMBOLS[symbol]})...`);
      let ltfCandles, htfCandles;
      
      if (isQuick) {
        ltfCandles = await getCandles(symbol, config.DEFAULT_LTF, 2000, false);
        htfCandles = await getCandles(symbol, config.DEFAULT_HTF, 500, false);
      } else {
        ltfCandles = await getHistoricalCandles(symbol, config.DEFAULT_LTF, months, false);
        htfCandles = await getHistoricalCandles(symbol, config.DEFAULT_HTF, months, false);
      }
      
      console.log(`  * Loaded ${ltfCandles.length} LTF (${config.DEFAULT_LTF}) candles and ${htfCandles.length} HTF (${config.DEFAULT_HTF}) candles.`);
      console.log(`  * Simulating chronological SMC trades...`);
      const report = runBacktest(symbol, ltfCandles, htfCandles);
      report.name = config.SYMBOLS[symbol];
      reports.push(report);
    }

    // Sort by ROI descending to establish clear performance ranking
    reports.sort((a, b) => b.roi - a.roi);

    // Build Formatted Output Table
    console.log(`\n${BOLD}=========================================== PERFORMANCE REPORT ===========================================${RESET}`);
    const tableHeader = String.prototype.concat(
      `| ${"Asset".padEnd(8)} | `,
      `${"Asset Full Name".padEnd(25)} | `,
      `${"Trades".padStart(6)} | `,
      `${"Wins".padStart(4)} | `,
      `${"Losses".padStart(6)} | `,
      `${"Win Rate".padStart(8)} | `,
      `${"Net Profit".padStart(12)} | `,
      `${"ROI (%)".padStart(8)} | `,
      `${"Max DD".padStart(8)} | `,
      `${"Freq(/M)".padStart(8)} |`
    );
    console.log(tableHeader);
    console.log("-".repeat(tableHeader.length));

    reports.forEach(r => {
      const isRoiNeg = r.roi < 0;
      const roiColor = isRoiNeg ? RED : GREEN;
      const profitSign = r.netProfit >= 0 ? "+" : "";
      const divisor = isQuick ? 1.0 : months; // Avoid division issues in quick mode
      const tradesPerMonth = (r.totalTrades / divisor).toFixed(1);
      
      const row = String.prototype.concat(
        `| ${CYAN}${r.symbol.padEnd(8)}${RESET} | `,
        `${r.name.padEnd(25)} | `,
        `${r.totalTrades.toString().padStart(6)} | `,
        `${GREEN}${r.wins.toString().padStart(4)}${RESET} | `,
        `${RED}${r.losses.toString().padStart(6)}${RESET} | `,
        `${r.winRate.toFixed(2).padStart(7)}% | `,
        `${roiColor}${profitSign}$${r.netProfit.toFixed(2).padStart(10)}${RESET} | `,
        `${roiColor}${profitSign}${r.roi.toFixed(2).padStart(6)}%${RESET} | `,
        `${RED}${r.maxDrawdown.toFixed(2).padStart(6)}%${RESET} | `,
        `${tradesPerMonth.padStart(8)} |`
      );
      console.log(row);
    });
    console.log("=".repeat(tableHeader.length));

    // Consolidated Metrics
    const totalTrades = reports.reduce((sum, r) => sum + r.totalTrades, 0);
    const totalWins = reports.reduce((sum, r) => sum + r.wins, 0);
    const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
    const netProfit = reports.reduce((sum, r) => sum + r.netProfit, 0);
    const totalStartingBalance = config.STARTING_BALANCE * reports.length;
    const portfolioROI = (netProfit / totalStartingBalance) * 100;
    const maxDrawdown = Math.max(...reports.map(r => r.maxDrawdown));
    
    console.log(`\n${BOLD}${CYAN}📊 CONSOLIDATED PORTFOLIO METRICS:${RESET}`);
    console.log(`-------------------------------------------------------------------------------------------------`);
    console.log(`🟢 Total Portfolio Trades Executed : ${BOLD}${totalTrades}${RESET}`);
    console.log(`🟢 Overall Portfolio Win Rate      : ${BOLD}${winRate.toFixed(2)}%${RESET} (${totalWins} Wins / ${totalTrades - totalWins} Losses)`);
    console.log(`🟢 Total Consolidated Net Profit   : ${BOLD}${netProfit >= 0 ? GREEN : RED}${netProfit >= 0 ? "+" : ""}$${netProfit.toFixed(2)}${RESET}`);
    console.log(`🟢 Consolidated Portfolio ROI      : ${BOLD}${netProfit >= 0 ? GREEN : RED}${netProfit >= 0 ? "+" : ""}${portfolioROI.toFixed(2)}%${RESET} (on $${totalStartingBalance.toLocaleString()} equity)`);
    console.log(`🔴 Max Drawdown Safe Limit         : ${BOLD}${RED}${maxDrawdown.toFixed(2)}%${RESET}`);
    console.log(`=================================================================================================\n`);

    // Dynamic strategy feedback and improvement tips
    console.log(`${BOLD}${YELLOW}💡 STRATEGY FEEDBACK & IMPROVEMENT SUGGESTIONS:${RESET}`);
    console.log(`-------------------------------------------------------------------------------------------------`);
    if (portfolioROI > 0) {
      console.log(`🟢 ${GREEN}Strategy has a positive net expectancy!${RESET} Some index assets show high win rates.`);
    } else {
      console.log(`⚠️ ${YELLOW}Strategy ROI is currently flat/negative.${RESET} Market structural noise is impacting win rates across some indexes.`);
    }
    
    // Sort to suggest top indices for frequency and win rate
    const topByWinRate = [...reports].sort((a, b) => b.winRate - a.winRate).slice(0, 3);
    const topByFrequency = [...reports].sort((a, b) => b.totalTrades - a.totalTrades).slice(0, 3);
    
    console.log(`\n${BOLD}🏆 TOP 3 ASSETS BY WIN RATE:${RESET}`);
    topByWinRate.forEach((r, idx) => {
      console.log(`   ${idx + 1}. ${CYAN}${r.symbol.padEnd(8)}${RESET} - ${BOLD}${r.winRate.toFixed(2)}%${RESET} win rate (${r.totalTrades} trades, Net: ${r.netProfit >= 0 ? '+' : ''}$${r.netProfit.toFixed(2)})`);
    });

    console.log(`\n${BOLD}🔥 TOP 3 ASSETS BY SETUP FREQUENCY (Most Active):${RESET}`);
    topByFrequency.forEach((r, idx) => {
      const divisor = isQuick ? 1.0 : months;
      console.log(`   ${idx + 1}. ${CYAN}${r.symbol.padEnd(8)}${RESET} - ${BOLD}${r.totalTrades}${RESET} total setups (${(r.totalTrades / divisor).toFixed(1)}/month, Win Rate: ${r.winRate.toFixed(2)}%)`);
    });
    
    console.log(`\n-------------------------------------------------------------------------------------------------`);

  } catch (err) {
    console.error("❌ CLI Backtester Error:", err);
  }
}

runCLIBacktester();
