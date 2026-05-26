// testAssets.js
/**
 * Asset Category Backtest Comparison Script (Volatility vs. Boom/Crash)
 * 
 * Runs a rigorous 6-month historical simulation over 12 synthetic indices
 * on the 30-minute timeframe using our optimal winning SMC Strategy:
 * - Timeframe: LTF = 30m, HTF Trend Bias Filter = 4h (50-EMA)
 * - Stop Loss Mode: 'ratio' with Tight SL Buffer Ratio (0.10)
 * - Premium/Discount OTE active (ENTRY_DISCOUNT_ONLY = true)
 * 
 * Assets compared:
 *   Group A — Volatility Indices: R_10, R_25, R_50, R_75, 1HZ50V, 1HZ100V
 *   Group B — Boom & Crash Indices: BOOM300, BOOM500, BOOM1000, CRASH300, CRASH500, CRASH1000
 * 
 * Usage:
 *   node testAssets.js [months]  → defaults to 6 months
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getHistoricalCandles } = require('./dataFetcher');
const { runBacktest } = require('./backtester');

// ─── ASCII Colors ──────────────────────────────────────────────────────────
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const YELLOW = '\x1b[33m';
const MAGENTA= '\x1b[35m';
const BLUE   = '\x1b[34m';
const DIM    = '\x1b[2m';

// Define asset groups
const VOL_PAIRS = {
  "R_10": "Volatility 10 Index",
  "R_25": "Volatility 25 Index",
  "R_50": "Volatility 50 Index",
  "R_75": "Volatility 75 Index",
  "1HZ50V": "Volatility 50 (1s) Index",
  "1HZ100V": "Volatility 100 (1s) Index"
};

const BOOM_CRASH_PAIRS = {
  "BOOM300": "Boom 300 Index",
  "BOOM500": "Boom 500 Index",
  "BOOM1000": "Boom 1000 Index",
  "CRASH300": "Crash 300 Index",
  "CRASH500": "Crash 500 Index",
  "CRASH1000": "Crash 1000 Index"
};

// Force Config 1 Winner Parameters in memory for this comparison
const STRATEGY_SETTINGS = {
  STOP_LOSS_BUFFER_MODE: 'ratio',
  STOP_LOSS_BUFFER_RATIO: 0.10,
  ENTRY_DISCOUNT_ONLY: true,
  DEFAULT_LTF: '30m',
  DEFAULT_HTF: '4h'
};

function applySettings() {
  Object.assign(config, STRATEGY_SETTINGS);
}

function colorRoi(value) {
  const sign = value >= 0 ? '+' : '';
  return value >= 0
    ? `${GREEN}${sign}${value.toFixed(2)}%${RESET}`
    : `${RED}${value.toFixed(2)}%${RESET}`;
}

function colorProfit(value) {
  const sign = value >= 0 ? '+$' : '-$';
  const abs  = Math.abs(value).toFixed(2);
  return value >= 0
    ? `${GREEN}${sign}${abs}${RESET}`
    : `${RED}${sign}${abs}${RESET}`;
}

function pad(str, width) {
  const plain = str.replace(/\x1b\[[0-9;]*m/g, ''); // strip color codes
  return str + ' '.repeat(Math.max(0, width - plain.length));
}

function summarise(reports, months) {
  const totalTrades  = reports.reduce((s, r) => s + r.totalTrades, 0);
  const totalWins    = reports.reduce((s, r) => s + r.wins, 0);
  const netProfit    = reports.reduce((s, r) => s + r.netProfit, 0);
  const totalStartingBalance = config.STARTING_BALANCE * reports.length;
  const winRate      = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
  const portfolioROI = (netProfit / totalStartingBalance) * 100;
  const maxDD        = Math.max(...reports.map(r => r.maxDrawdown));
  const freq         = (totalTrades / months).toFixed(1);
  
  const pfFiltered = reports.filter(r => isFinite(r.profitFactor) && r.profitFactor > 0).map(r => r.profitFactor);
  const avgPF = pfFiltered.length > 0 ? pfFiltered.reduce((s, val) => s + val, 0) / pfFiltered.length : 1;

  return { totalTrades, totalWins, netProfit, winRate, portfolioROI, maxDD, freq, profitFactor: avgPF };
}

async function main() {
  const args = process.argv.slice(2);
  const months = (args[0] && !isNaN(parseInt(args[0]))) ? parseInt(args[0]) : 6;

  // Apply Config 1 winner parameters
  applySettings();

  console.log(`\n${BOLD}${CYAN}${'='.repeat(95)}`);
  console.log(`  📊  ASSET CATEGORY PERFORMANCE ANALYSIS — ${months}-Month Historical Backtest`);
  console.log(`      Strategy: Optimal SMC Config 1 (30m TF | OTE Discount Filter | Tight SL)`);
  console.log(`${'='.repeat(95)}${RESET}`);
  console.log(`  Risk settings: ${config.RISK_PERCENT}% per trade | Reward Ratio: ${config.REWARD_RATIO}:1`);
  console.log(`  Starting balance: $${config.STARTING_BALANCE.toLocaleString()} per asset`);
  console.log(`-----------------------------------------------------------------------------------------------`);

  // 1. Load Data for Group A (Volatility Indices)
  console.log(`\n${BOLD}${BLUE}⏳ [1/2] Loading Volatility Group historical candles...${RESET}`);
  const volReports = [];
  for (const symbol of Object.keys(VOL_PAIRS)) {
    try {
      process.stdout.write(`   Loading ${symbol}...`);
      const ltf = await getHistoricalCandles(symbol, config.DEFAULT_LTF, months, false);
      const htf = await getHistoricalCandles(symbol, config.DEFAULT_HTF, months, false);
      process.stdout.write(` ${GREEN}Loaded${RESET} (${ltf.length} candles). Backtesting...`);
      
      const report = runBacktest(symbol, ltf, htf);
      report.name = VOL_PAIRS[symbol];
      volReports.push(report);
      console.log(` ${report.roi >= 0 ? GREEN : RED}${report.roi >= 0 ? '+' : ''}${report.roi.toFixed(2)}% ROI${RESET} (${report.winRate}% WR)`);
    } catch (err) {
      console.log(` ${RED}FAILED: ${err.message}${RESET}`);
    }
  }

  // 2. Load Data for Group B (Boom & Crash Indices)
  console.log(`\n${BOLD}${MAGENTA}⏳ [2/2] Loading Boom & Crash Group historical candles...${RESET}`);
  const bcReports = [];
  for (const symbol of Object.keys(BOOM_CRASH_PAIRS)) {
    try {
      process.stdout.write(`   Loading ${symbol}...`);
      const ltf = await getHistoricalCandles(symbol, config.DEFAULT_LTF, months, false);
      const htf = await getHistoricalCandles(symbol, config.DEFAULT_HTF, months, false);
      process.stdout.write(` ${GREEN}Loaded${RESET} (${ltf.length} candles). Backtesting...`);
      
      const report = runBacktest(symbol, ltf, htf);
      report.name = BOOM_CRASH_PAIRS[symbol];
      bcReports.push(report);
      console.log(` ${report.roi >= 0 ? GREEN : RED}${report.roi >= 0 ? '+' : ''}${report.roi.toFixed(2)}% ROI${RESET} (${report.winRate}% WR)`);
    } catch (err) {
      console.log(` ${RED}FAILED: ${err.message}${RESET}`);
    }
  }

  // 3. Summarize statistics
  const volSummary = summarise(volReports, months);
  const bcSummary = summarise(bcReports, months);

  // 4. Print Side-by-side Table
  console.log(`\n${BOLD}${CYAN}${'='.repeat(95)}`);
  console.log(`  📋  SIDE-BY-SIDE CATEGORY COMPARISON`);
  console.log(`${'='.repeat(95)}${RESET}`);

  const COL_W = 32;
  const METRIC_W = 26;
  
  const headerRow = `${BOLD}${'Metric'.padEnd(METRIC_W)}${RESET}` +
    `${BOLD}${BLUE}${'Volatility Group'.padEnd(COL_W)}${RESET}` +
    `${BOLD}${MAGENTA}${'Boom & Crash Group'.padEnd(COL_W)}${RESET}`;
  console.log(headerRow);
  console.log('-'.repeat(METRIC_W + COL_W * 2));

  const compareRows = [
    { label: 'Total Assets Backtested', v1: `${volReports.length} Pairs`, v2: `${bcReports.length} Pairs` },
    { label: 'Total Trades Triggered', v1: String(volSummary.totalTrades), v2: String(bcSummary.totalTrades) },
    { label: 'Overall Win Rate', v1: `${volSummary.winRate.toFixed(2)}%`, v2: `${bcSummary.winRate.toFixed(2)}%` },
    { label: 'Wins vs Losses', v1: `${volSummary.totalWins}W / ${volSummary.totalTrades - volSummary.totalWins}L`, v2: `${bcSummary.totalWins}W / ${bcSummary.totalTrades - bcSummary.totalWins}L` },
    { label: 'Average Profit Factor', v1: volSummary.profitFactor.toFixed(2), v2: bcSummary.profitFactor.toFixed(2) },
    { label: 'Consolidated Net Profit', v1: colorProfit(volSummary.netProfit), v2: colorProfit(bcSummary.netProfit) },
    { label: 'Consolidated Portfolio ROI', v1: colorRoi(volSummary.portfolioROI), v2: colorRoi(bcSummary.portfolioROI) },
    { label: 'Max Drawdown Safe Limit', v1: `${RED}${volSummary.maxDD.toFixed(2)}%${RESET}`, v2: `${RED}${bcSummary.maxDD.toFixed(2)}%${RESET}` },
    { label: 'Trade Frequency (Combined)', v1: `${volSummary.freq}/mo`, v2: `${bcSummary.freq}/mo` }
  ];

  compareRows.forEach(row => {
    const lbl = row.label.padEnd(METRIC_W);
    const c1 = pad(row.v1, COL_W);
    const c2 = pad(row.v2, COL_W);
    console.log(`${lbl}${c1}${c2}`);
  });
  console.log('-'.repeat(METRIC_W + COL_W * 2));

  // 5. Complete breakdown table
  console.log(`\n${BOLD}${CYAN}${'='.repeat(95)}`);
  console.log(`  🔎  COMPLETE INDIVIDUAL PAIR BREAKDOWN`);
  console.log(`${'='.repeat(95)}${RESET}`);
  
  const detailHeader = `${BOLD}${'Asset'.padEnd(12)}${'Group'.padEnd(16)}${'Trades'.padStart(7)}${'WR%'.padStart(8)}${'Net Profit'.padStart(15)}${'ROI (%)'.padStart(12)}${'Max DD'.padStart(9)}${RESET}`;
  console.log(detailHeader);
  console.log('-'.repeat(detailHeader.length + 8)); // +8 for escape color padding

  // Combine and sort individual reports by ROI descending
  const combined = [
    ...volReports.map(r => ({ ...r, group: 'Volatility' })),
    ...bcReports.map(r => ({ ...r, group: 'Boom/Crash' }))
  ].sort((a, b) => b.roi - a.roi);

  combined.forEach(r => {
    const assetStr = r.symbol.replace('R_', 'VIX ').padEnd(12);
    const grpColor = r.group === 'Volatility' ? BLUE : MAGENTA;
    const grpStr = `${grpColor}${r.group.padEnd(16)}${RESET}`;
    const trdsStr = String(r.totalTrades).padStart(7);
    const wrStr = `${r.winRate.toFixed(1)}%`.padStart(8);
    const profitStr = colorProfit(r.netProfit).padStart(24); // extra padding for ansi characters
    const roiStr = colorRoi(r.roi).padStart(21);
    const ddStr = `${RED}${r.maxDrawdown.toFixed(2)}%${RESET}`.padStart(18);
    
    console.log(`${assetStr}${grpStr}${trdsStr}${wrStr}${profitStr}${roiStr}${ddStr}`);
  });
  console.log('-'.repeat(detailHeader.length + 8));

  // 6. Verdict
  console.log(`\n${BOLD}${CYAN}${'='.repeat(95)}`);
  console.log(`  🏆  THE VERDICT`);
  console.log(`${'='.repeat(95)}${RESET}`);

  const volROI = volSummary.portfolioROI;
  const bcROI = bcSummary.portfolioROI;

  if (volROI > bcROI) {
    console.log(`  🥇 ${BOLD}${GREEN}WINNER: VOLATILITY INDICES GROUP${RESET}`);
    console.log(`  • ROI: ${colorRoi(volROI)} vs. ${colorRoi(bcROI)}`);
    console.log(`  • Win Rate: ${BOLD}${volSummary.winRate.toFixed(2)}%${RESET} vs. ${BOLD}${bcSummary.winRate.toFixed(2)}%${RESET}`);
    console.log(`  💡 ${YELLOW}Explanation:${RESET} Volatility indices behave in a highly structured and symmetrical way. Retracements are cleanly respected, and sweeps target liquidity precisely. Boom & Crash indices are prone to sharp, asymmetric spikes (Boom spike bullishly, Crash spike bearishly) which can suddenly run past wicks or invalidate SMC structures aggressively, resulting in higher drawdowns or random stop-outs.`);
  } else if (bcROI > volROI) {
    console.log(`  🥇 ${BOLD}${GREEN}WINNER: BOOM & CRASH GROUP${RESET}`);
    console.log(`  • ROI: ${colorRoi(bcROI)} vs. ${colorRoi(volROI)}`);
    console.log(`  • Win Rate: ${BOLD}${bcSummary.winRate.toFixed(2)}%${RESET} vs. ${BOLD}${volSummary.winRate.toFixed(2)}%${RESET}`);
    console.log(`  💡 ${YELLOW}Explanation:${RESET} The OTE and Tight SL strategy is capturing boom/crash spike continuations flawlessly. By only buying in discount and selling in premium, the strategy is perfectly entering orders right before massive spike events occur, compounding profits aggressively.`);
  } else {
    console.log(`  🤝 ${BOLD}IT IS A DRAW!${RESET}`);
  }
  console.log(`${CYAN}${'='.repeat(95)}${RESET}\n`);
}

main().catch(err => {
  console.error("❌ Comparison execution failed:", err);
});
