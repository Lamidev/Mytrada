// backtest_3month_hybrid.js
/**
 * 3-Month Rigorous SMC Historical Backtest: MASTER HYBRID SCALPING PORTFOLIO
 * Rigorous long-term consistency test across 3 months (~26,000 5m candles per asset).
 * Asset Strategy Allocation:
 *  - BOOM500   -> TICK_SCALPING  (SELL ONLY)
 *  - CRASH500  -> SPIKE_CATCHING (SELL ONLY)
 *  - 1HZ100V   -> BOTH           (BUY & SELL)
 *  - BOOM1000  -> TICK_SCALPING  (SELL ONLY)
 *  - CRASH1000 -> SPIKE_CATCHING (SELL ONLY)
 *  - CRASH600  -> SPIKE_CATCHING (SELL ONLY)
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getHistoricalCandles } = require('./dataFetcher');
const { runBacktest } = require('./backtester');

config.DEFAULT_HTF = '1h';
config.DEFAULT_LTF = '5m';

const MASTER_HYBRID_PORTFOLIO = {
  "BOOM500":   { name: "Boom 500 Index",            mode: "TICK_SCALPING" },
  "CRASH500":  { name: "Crash 500 Index",           mode: "SPIKE_CATCHING" },
  "1HZ100V":   { name: "Volatility 100 (1s) Index", mode: "BOTH" },
  "BOOM1000":  { name: "Boom 1000 Index",           mode: "TICK_SCALPING" },
  "CRASH1000": { name: "Crash 1000 Index",          mode: "SPIKE_CATCHING" },
  "CRASH600":  { name: "Crash 600 Index",           mode: "SPIKE_CATCHING" }
};

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

async function main() {
  const months = 3; // 3-Month Rigorous Historical Depth
  console.log(`\n${BOLD}${CYAN}=================================================================================================`);
  console.log(`🏆 3-MONTH RIGOROUS HISTORICAL BACKTEST: MASTER HYBRID SCALPING PORTFOLIO`);
  console.log(`=================================================================================================${RESET}`);
  console.log(`Timeframe Matrix : LTF = ${config.DEFAULT_LTF} | HTF Filter = ${config.DEFAULT_HTF} (50 EMA)`);
  console.log(`Historical Depth : ${months} Months (~26,000 5m candles per asset)`);
  console.log(`Risk Settings    : Risk per Trade = 1% | Target Reward-to-Risk = ${config.REWARD_RATIO}:1`);
  console.log(`Starting Balance : $${config.STARTING_BALANCE.toLocaleString()} per asset`);
  console.log(`-------------------------------------------------------------------------------------------------`);
  console.log(`Loading 3-Month historical candle data from Deriv WS API...`);

  const symbols = Object.keys(MASTER_HYBRID_PORTFOLIO);
  const reports = [];

  for (const symbol of symbols) {
    const item = MASTER_HYBRID_PORTFOLIO[symbol];
    config.BOOM_CRASH_MODE = item.mode;

    console.log(`\n- Fetching 3-Month data for ${CYAN}${symbol}${RESET} (${item.name}) [Mode: ${BOLD}${item.mode}${RESET}]...`);
    try {
      const ltfCandles = await getHistoricalCandles(symbol, config.DEFAULT_LTF, months, false);
      const htfCandles = await getHistoricalCandles(symbol, config.DEFAULT_HTF, months, false);

      console.log(`  * Loaded ${ltfCandles.length} LTF (5m) candles and ${htfCandles.length} HTF (1h) candles.`);
      console.log(`  * Simulating 3-month chronological SMC execution...`);

      const report = runBacktest(symbol, ltfCandles, htfCandles);
      report.name = item.name;
      report.mode = item.mode;
      reports.push(report);
    } catch (err) {
      console.error(`❌ Error backtesting ${symbol}:`, err.message);
    }
  }

  reports.sort((a, b) => b.roi - a.roi);

  // ── Per-Asset Monthly Breakdown ────────────────────────────────────────────
  console.log(`\n${BOLD}${CYAN}============================================================`);
  console.log(`📅 MONTHLY BREAKDOWN PER ASSET (WITH SPIKE SLIPPAGE)`);
  console.log(`============================================================${RESET}`);

  // Collect all unique months across all reports
  const allMonths = [...new Set(
    reports.flatMap(r => r.monthlyBreakdown.map(m => m.month))
  )].sort();

  for (const r of reports) {
    const sym = r.symbol;
    const mode = r.mode;
    console.log(`\n${BOLD}${CYAN}▸ ${sym} (${r.name}) — ${mode}${RESET}`);
    console.log(`  ${'-'.repeat(82)}`);
    console.log(`  | ${'Month'.padEnd(10)} | ${'Trades'.padStart(6)} | ${'Wins'.padStart(4)} | ${'Losses'.padStart(6)} | ${'Win Rate'.padStart(8)} | ${'Slippage Cost'.padStart(13)} | ${'Monthly Profit'.padStart(14)} |`);
    console.log(`  | ${'-'.repeat(10)} | ${'-'.repeat(6)} | ${'-'.repeat(4)} | ${'-'.repeat(6)} | ${'-'.repeat(8)} | ${'-'.repeat(13)} | ${'-'.repeat(14)} |`);

    let totalT = 0, totalW = 0, totalL = 0, totalP = 0, totalSlip = 0;
    for (const month of allMonths) {
      const m = r.monthlyBreakdown.find(x => x.month === month);
      if (!m) {
        console.log(`  | ${month.padEnd(10)} | ${'—'.padStart(6)} | ${'—'.padStart(4)} | ${'—'.padStart(6)} | ${'—'.padStart(8)} | ${'—'.padStart(13)} | ${'—'.padStart(14)} |`);
        continue;
      }
      const wr = m.trades > 0 ? ((m.wins / m.trades) * 100).toFixed(1) + '%' : '0.0%';
      const pnl = m.netProfit >= 0 ? `+$${m.netProfit.toFixed(2)}` : `-$${Math.abs(m.netProfit).toFixed(2)}`;
      const slip = m.slippageCost > 0 ? `-$${m.slippageCost.toFixed(2)}` : '$0.00';
      const pColor = m.netProfit >= 0 ? GREEN : RED;
      console.log(`  | ${month.padEnd(10)} | ${m.trades.toString().padStart(6)} | ${GREEN}${m.wins.toString().padStart(4)}${RESET} | ${RED}${m.losses.toString().padStart(6)}${RESET} | ${wr.padStart(8)} | ${RED}${slip.padStart(13)}${RESET} | ${pColor}${pnl.padStart(14)}${RESET} |`);
      totalT += m.trades; totalW += m.wins; totalL += m.losses;
      totalP += m.netProfit; totalSlip += m.slippageCost;
    }
    const totalWr = totalT > 0 ? ((totalW / totalT) * 100).toFixed(1) + '%' : '0.0%';
    const totalPstr = totalP >= 0 ? `+$${totalP.toFixed(2)}` : `-$${Math.abs(totalP).toFixed(2)}`;
    const totalSlipStr = totalSlip > 0 ? `-$${totalSlip.toFixed(2)}` : '$0.00';
    console.log(`  | ${'-'.repeat(10)} | ${'-'.repeat(6)} | ${'-'.repeat(4)} | ${'-'.repeat(6)} | ${'-'.repeat(8)} | ${'-'.repeat(13)} | ${'-'.repeat(14)} |`);
    console.log(`  | ${'TOTAL'.padEnd(10)} | ${BOLD}${totalT.toString().padStart(6)}${RESET} | ${GREEN}${BOLD}${totalW.toString().padStart(4)}${RESET} | ${RED}${BOLD}${totalL.toString().padStart(6)}${RESET} | ${BOLD}${totalWr.padStart(8)}${RESET} | ${RED}${BOLD}${totalSlipStr.padStart(13)}${RESET} | ${totalP >= 0 ? GREEN : RED}${BOLD}${totalPstr.padStart(14)}${RESET} |`);
  }

  // ── Consolidated Portfolio Monthly Totals ──────────────────────────────────
  console.log(`\n${BOLD}${CYAN}============================================================`);
  console.log(`📊 CONSOLIDATED PORTFOLIO MONTHLY TOTALS (ALL PAIRS)`);
  console.log(`============================================================${RESET}`);
  console.log(`  | ${'Month'.padEnd(10)} | ${'Trades'.padStart(6)} | ${'Wins'.padStart(4)} | ${'Losses'.padStart(6)} | ${'Win Rate'.padStart(8)} | ${'Slippage Cost'.padStart(13)} | ${'Portfolio Profit'.padStart(16)} |`);
  console.log(`  | ${'-'.repeat(10)} | ${'-'.repeat(6)} | ${'-'.repeat(4)} | ${'-'.repeat(6)} | ${'-'.repeat(8)} | ${'-'.repeat(13)} | ${'-'.repeat(16)} |`);

  let grandT = 0, grandW = 0, grandL = 0, grandP = 0, grandSlip = 0;
  for (const month of allMonths) {
    let mT = 0, mW = 0, mL = 0, mP = 0, mSlip = 0;
    for (const r of reports) {
      const m = r.monthlyBreakdown.find(x => x.month === month);
      if (m) { mT += m.trades; mW += m.wins; mL += m.losses; mP += m.netProfit; mSlip += m.slippageCost; }
    }
    const wr = mT > 0 ? ((mW / mT) * 100).toFixed(1) + '%' : '0.0%';
    const pnl = mP >= 0 ? `+$${mP.toFixed(2)}` : `-$${Math.abs(mP).toFixed(2)}`;
    const slip = mSlip > 0 ? `-$${mSlip.toFixed(2)}` : '$0.00';
    console.log(`  | ${month.padEnd(10)} | ${mT.toString().padStart(6)} | ${GREEN}${mW.toString().padStart(4)}${RESET} | ${RED}${mL.toString().padStart(6)}${RESET} | ${wr.padStart(8)} | ${RED}${slip.padStart(13)}${RESET} | ${mP >= 0 ? GREEN : RED}${pnl.padStart(16)}${RESET} |`);
    grandT += mT; grandW += mW; grandL += mL; grandP += mP; grandSlip += mSlip;
  }
  const grandWr = grandT > 0 ? ((grandW / grandT) * 100).toFixed(1) + '%' : '0.0%';
  const grandPstr = grandP >= 0 ? `+$${grandP.toFixed(2)}` : `-$${Math.abs(grandP).toFixed(2)}`;
  const grandSlipStr = grandSlip > 0 ? `-$${grandSlip.toFixed(2)}` : '$0.00';
  console.log(`  | ${'-'.repeat(10)} | ${'-'.repeat(6)} | ${'-'.repeat(4)} | ${'-'.repeat(6)} | ${'-'.repeat(8)} | ${'-'.repeat(13)} | ${'-'.repeat(16)} |`);
  console.log(`  | ${'3M TOTAL'.padEnd(10)} | ${BOLD}${grandT.toString().padStart(6)}${RESET} | ${GREEN}${BOLD}${grandW.toString().padStart(4)}${RESET} | ${RED}${BOLD}${grandL.toString().padStart(6)}${RESET} | ${BOLD}${grandWr.padStart(8)}${RESET} | ${RED}${BOLD}${grandSlipStr.padStart(13)}${RESET} | ${grandP >= 0 ? GREEN : RED}${BOLD}${grandPstr.padStart(16)}${RESET} |`);

  // ── Final Summary ───────────────────────────────────────────────────────────
  const totalTrades = reports.reduce((s, r) => s + r.totalTrades, 0);
  const totalWins   = reports.reduce((s, r) => s + r.wins, 0);
  const netProfit   = reports.reduce((s, r) => s + r.netProfit, 0);
  const totalCap    = config.STARTING_BALANCE * reports.length;
  const portfolioROI  = (netProfit / totalCap) * 100;
  const avgMonthROI   = (portfolioROI / months).toFixed(2);
  const maxDD         = Math.max(...reports.map(r => r.maxDrawdown));

  console.log(`\n${BOLD}${CYAN}📊 CONSOLIDATED 3-MONTH HYBRID PORTFOLIO METRICS (WITH SLIPPAGE):${RESET}`);
  console.log(`-------------------------------------------------------------------------------------------------`);
  console.log(`🟢 Total Portfolio Trades (3M) : ${BOLD}${totalTrades}${RESET} (${(totalTrades/months).toFixed(1)} trades/month)`);
  console.log(`🟢 Overall Portfolio Win Rate  : ${BOLD}${((totalWins/totalTrades)*100).toFixed(2)}%${RESET} (${totalWins} Wins / ${totalTrades - totalWins} Losses)`);
  console.log(`🟢 Total Net Realized Profit   : ${BOLD}${netProfit >= 0 ? GREEN : RED}${netProfit >= 0 ? '+' : ''}$${netProfit.toFixed(2)}${RESET}`);
  console.log(`🟢 Avg Monthly Realized Profit : ${BOLD}${netProfit >= 0 ? GREEN : RED}${netProfit >= 0 ? '+' : ''}$${(netProfit/months).toFixed(2)} USD/month${RESET}`);
  console.log(`🟢 Total 3-Month Portfolio ROI : ${BOLD}${netProfit >= 0 ? GREEN : RED}${netProfit >= 0 ? '+' : ''}${portfolioROI.toFixed(2)}%${RESET} (${avgMonthROI}% avg/month)`);
  console.log(`🔴 Total Spike Slippage Cost   : ${BOLD}${RED}-$${grandSlip.toFixed(2)}${RESET}`);
  console.log(`🔴 Max Drawdown Exposure       : ${BOLD}${RED}${maxDD.toFixed(2)}%${RESET}`);
  console.log(`=================================================================================================\n`);
}

main().catch(console.error);
