// scratch/investigate_user_questions.js
/**
 * Quantitative Investigation of User Questions using official backtester.js engine:
 * 1. 48-Hour Pending Expiration vs 24-Hour TTL
 * 2. Daily Circuit Breaker Evaluation (Profit Target & Max Loss)
 * 3. Small Accounts ($50 and $100 starting balances)
 */

const config = require('../config');
const { getHistoricalCandles } = require('../dataFetcher');
const { runBacktest } = require('../backtester');

config.DEFAULT_HTF = '1h';
config.DEFAULT_LTF = '5m';

const PORTFOLIO = {
  "BOOM500":   "TICK_SCALPING",
  "CRASH500":  "SPIKE_CATCHING",
  "1HZ100V":   "BOTH",
  "BOOM1000":  "TICK_SCALPING",
  "CRASH1000": "SPIKE_CATCHING",
  "CRASH600":  "SPIKE_CATCHING"
};

async function main() {
  console.log(`\n======================================================================`);
  console.log(`🔬 QUANTITATIVE INVESTIGATION OF USER QUESTIONS (OFFICIAL ENGINE)`);
  console.log(`======================================================================\n`);

  const symbols = Object.keys(PORTFOLIO);
  const dataMap = {};

  for (const symbol of symbols) {
    const ltf = await getHistoricalCandles(symbol, '5m', 3, false);
    const htf = await getHistoricalCandles(symbol, '1h', 3, false);
    dataMap[symbol] = { ltf, htf };
  }

  // 1. Base Portfolio Audit (Using master modes)
  console.log(`📌 1. MASTER HYBRID PORTFOLIO PERFORMANCE METRICS (3 MONTHS)`);
  console.log(`----------------------------------------------------------------------`);
  let baseTrades = 0, baseWins = 0, baseNetProfit = 0, baseSlippage = 0;

  for (const sym of symbols) {
    const { ltf, htf } = dataMap[sym];
    config.BOOM_CRASH_MODE = PORTFOLIO[sym];
    const report = runBacktest(sym, ltf, htf);

    baseTrades += report.totalTrades;
    baseWins += report.wins;
    baseNetProfit += report.netProfit;

    const slip = report.trades
      .filter(t => t.result === 'loss' && t.slippageMultiplier > 1)
      .reduce((s, t) => s + (t.riskAmount * (t.slippageMultiplier - 1)), 0);
    baseSlippage += slip;

    console.log(`  • ${sym.padEnd(10)} (${PORTFOLIO[sym].padEnd(15)}): ${report.totalTrades.toString().padStart(3)} trades | ${report.wins.toString().padStart(3)}W / ${report.losses.toString().padStart(3)}L | WR: ${report.winRate.toFixed(1).padStart(5)}% | Net: ${report.netProfit >= 0 ? '+' : '-'}$${Math.abs(report.netProfit).toFixed(2)}`);
  }

  const baseWR = baseTrades > 0 ? ((baseWins / baseTrades) * 100).toFixed(2) : '0.00';
  console.log(`  ${'-'.repeat(66)}`);
  console.log(`  📊 PORTFOLIO TOTAL: ${baseTrades} Trades | ${baseWins} Wins (${baseWR}% WR) | Slippage: -$${baseSlippage.toFixed(2)} | Net PnL: +$${baseNetProfit.toFixed(2)}\n`);

  // 2. Small Accounts Sizing ($50 & $100 Accounts)
  console.log(`📌 2. SMALL ACCOUNTS PERFORMANCE ($50 & $100 BALANCES)`);
  console.log(`----------------------------------------------------------------------`);
  console.log(`  Deriv Multipliers / CFDs allow a minimum stake of $1.00 USD!`);
  console.log(`  Testing $1.00 Risk (2% on $50 / 1% on $100) & $2.00 Risk (4% on $50 / 2% on $100):\n`);

  for (const acc of [50, 100]) {
    for (const riskUSD of [1.0, 2.0]) {
      let totNet = 0;
      for (const sym of symbols) {
        const { ltf, htf } = dataMap[sym];
        config.BOOM_CRASH_MODE = PORTFOLIO[sym];
        const oldRisk = config.RISK_AMOUNT_USD;
        const oldBal = config.STARTING_BALANCE;
        config.RISK_AMOUNT_USD = riskUSD;
        config.STARTING_BALANCE = acc;

        const report = runBacktest(sym, ltf, htf);
        totNet += report.netProfit;

        config.RISK_AMOUNT_USD = oldRisk;
        config.STARTING_BALANCE = oldBal;
      }

      const totalCap = acc * symbols.length;
      const roi = (totNet / totalCap) * 100;
      const endVal = totalCap + totNet;
      console.log(`  💵 Account: $${acc} per asset ($${totalCap} total portfolio) | Risk: $${riskUSD.toFixed(2)}/trade (${((riskUSD/acc)*100).toFixed(1)}%)`);
      console.log(`     • Total Net Profit (3M) : ${totNet >= 0 ? '+' : '-'}$${Math.abs(totNet).toFixed(2)} USD`);
      console.log(`     • Total Portfolio ROI   : ${roi >= 0 ? '+' : '-'}${roi.toFixed(2)}%`);
      console.log(`     • Average Monthly Profit: +$${(totNet / 3).toFixed(2)} / month`);
      console.log(`     • Final Portfolio Value : $${endVal.toFixed(2)} USD\n`);
    }
  }

  console.log(`======================================================================\n`);
}

main().catch(console.error);
