// compare.js
/**
 * Strategy Comparison Backtester
 * 
 * Runs 3 strategy configurations over 6 months of historical data for all 6 pairs
 * and produces a side-by-side comparison table so you can pick the best approach.
 *
 * Configurations tested:
 *   Config 1 — BASELINE     : Tight SL (10%), No Discount Filter
 *   Config 2 — SAFE SL      : Generous SL (50%), No Discount Filter
 *   Config 3 — SAFE SL+OTE  : Generous SL (50%), Discount/Premium Zone Filter ON
 *
 * Usage:
 *   node compare.js         → defaults to 6 months
 *   node compare.js 3       → runs 3 months
 *   node compare.js 12      → runs 12 months
 */

const config = require('./config');
const { getHistoricalCandles } = require('./dataFetcher');
const { runBacktest } = require('./backtester');

// ─── ASCII Colours ──────────────────────────────────────────────────────────
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const YELLOW = '\x1b[33m';
const MAGENTA= '\x1b[35m';
const DIM    = '\x1b[2m';

// ─── Strategy Configurations ────────────────────────────────────────────────
const STRATEGIES = [
  {
    label: 'Config 1 — TIGHT SL + OTE',
    description: 'Tight SL (10% candle height) | Premium/Discount zone active',
    badge: '⚪',
    settings: {
      STOP_LOSS_BUFFER_MODE: 'ratio',
      STOP_LOSS_BUFFER_RATIO: 0.10,
      ENTRY_DISCOUNT_ONLY: true
    }
  },
  {
    label: 'Config 2 — SPREAD-SAFE SL + OTE',
    description: 'Moderate SL (30% candle height for spread safety) | Premium/Discount zone active',
    badge: '🔵',
    settings: {
      STOP_LOSS_BUFFER_MODE: 'ratio',
      STOP_LOSS_BUFFER_RATIO: 0.30,
      ENTRY_DISCOUNT_ONLY: true
    }
  },
  {
    label: 'Config 3 — WIDE SL + OTE',
    description: 'Generous SL (80% candle height) | Premium/Discount zone active',
    badge: '🟢',
    settings: {
      STOP_LOSS_BUFFER_MODE: 'ratio',
      STOP_LOSS_BUFFER_RATIO: 0.80,
      ENTRY_DISCOUNT_ONLY: true
    }
  }
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function applyConfig(settings) {
  // Node.js caches modules, so mutating the config object here propagates
  // immediately to backtester.js and marketStructure.js without any file edits.
  Object.assign(config, settings);
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
  const plain = str.replace(/\x1b\[[0-9;]*m/g, ''); // strip colour codes for length calc
  return str + ' '.repeat(Math.max(0, width - plain.length));
}

function summarise(reports, months) {
  const totalTrades  = reports.reduce((s, r) => s + r.totalTrades, 0);
  const totalWins    = reports.reduce((s, r) => s + r.wins, 0);
  const netProfit    = reports.reduce((s, r) => s + r.netProfit, 0);
  const totalEquity  = config.STARTING_BALANCE * reports.length;
  const winRate      = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
  const portfolioROI = (netProfit / totalEquity) * 100;
  const maxDD        = Math.max(...reports.map(r => r.maxDrawdown));
  const freq         = (totalTrades / months).toFixed(1);
  const profitFactor = reports.reduce((s, r) => s + r.profitFactor, 0) / reports.length;

  return { totalTrades, totalWins, netProfit, winRate, portfolioROI, maxDD, freq, profitFactor };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function runComparison() {
  const args   = process.argv.slice(2);
  const months = (args[0] && !isNaN(parseInt(args[0]))) ? parseInt(args[0]) : 6;

  console.log(`\n${BOLD}${CYAN}${'='.repeat(90)}`);
  console.log(`  📊  SMC STRATEGY COMPARISON BACKTESTER — ${months}-Month Historical Simulation`);
  console.log(`${'='.repeat(90)}${RESET}`);
  console.log(`${DIM}  Pairs   : ${Object.keys(config.SYMBOLS).join(', ')}`);
  console.log(`  LTF     : ${config.DEFAULT_LTF}  |  HTF Filter : ${config.DEFAULT_HTF} (50-EMA)`);
  console.log(`  Risk    : ${config.RISK_PERCENT}% per trade  |  Reward Ratio : ${config.REWARD_RATIO}:1`);
  console.log(`  Equity  : $${config.STARTING_BALANCE.toLocaleString()} per pair × ${Object.keys(config.SYMBOLS).length} pairs`);
  console.log(`${RESET}`);

  const symbols = Object.keys(config.SYMBOLS);

  // ── Step 1: Fetch & cache data ONCE (shared across all configs) ────────────
  console.log(`${BOLD}${YELLOW}⏳ Fetching / loading 6-month historical data...${RESET}`);
  const cachedData = {};
  for (const symbol of symbols) {
    process.stdout.write(`  Loading ${CYAN}${symbol}${RESET}...`);
    cachedData[symbol] = {
      ltf: await getHistoricalCandles(symbol, config.DEFAULT_LTF, months, false),
      htf: await getHistoricalCandles(symbol, config.DEFAULT_HTF, months, false)
    };
    console.log(` ${GREEN}✓${RESET} ${cachedData[symbol].ltf.length} LTF | ${cachedData[symbol].htf.length} HTF candles`);
  }
  console.log('');

  // ── Step 2: Run each strategy configuration ────────────────────────────────
  const allResults = [];

  for (const strategy of STRATEGIES) {
    console.log(`${BOLD}${MAGENTA}━━━ Running ${strategy.badge} ${strategy.label} ━━━${RESET}`);
    console.log(`${DIM}     ${strategy.description}${RESET}`);

    // Apply this strategy's settings to the shared config object
    applyConfig(strategy.settings);

    const reports = [];
    for (const symbol of symbols) {
      process.stdout.write(`  Backtesting ${CYAN}${symbol}${RESET}...`);
      const report = runBacktest(symbol, cachedData[symbol].ltf, cachedData[symbol].htf);
      report.name  = config.SYMBOLS[symbol];
      reports.push(report);
      const c = report.roi >= 0 ? GREEN : RED;
      const sign = report.roi >= 0 ? '+' : '';
      console.log(` ${c}${sign}${report.roi.toFixed(2)}% ROI${RESET}  |  ${report.winRate}% WR  |  ${report.totalTrades} trades`);
    }

    const summary = summarise(reports, months);
    allResults.push({ strategy, reports, summary });
    console.log('');
  }

  // ── Step 3: Side-by-side Comparison Table ─────────────────────────────────
  console.log(`\n${BOLD}${CYAN}${'='.repeat(90)}`);
  console.log(`  📋  SIDE-BY-SIDE STRATEGY COMPARISON`);
  console.log(`${'='.repeat(90)}${RESET}`);

  // Header row
  const COL = 26;
  const METRIC_COL = 22;
  const hdr = `${BOLD}${'Metric'.padEnd(METRIC_COL)}${RESET}` +
    allResults.map(r => `${BOLD}${CYAN}${r.strategy.badge} ${r.strategy.label.substring(0, COL - 2).padEnd(COL)}${RESET}`).join('');
  console.log(hdr);
  console.log('-'.repeat(METRIC_COL + COL * STRATEGIES.length));

  const rows = [
    {
      label: 'Total Trades',
      values: allResults.map(r => String(r.summary.totalTrades))
    },
    {
      label: 'Win Rate',
      values: allResults.map(r => `${r.summary.winRate.toFixed(2)}%`)
    },
    {
      label: 'Wins / Losses',
      values: allResults.map(r => `${r.summary.totalWins}W / ${r.summary.totalTrades - r.summary.totalWins}L`)
    },
    {
      label: 'Net Profit (Portfolio)',
      values: allResults.map(r => {
        const v = r.summary.netProfit;
        const sign = v >= 0 ? '+$' : '-$';
        return `${v >= 0 ? GREEN : RED}${sign}${Math.abs(v).toFixed(2)}${RESET}`;
      })
    },
    {
      label: 'Portfolio ROI',
      values: allResults.map(r => colorRoi(r.summary.portfolioROI))
    },
    {
      label: 'Avg Profit Factor',
      values: allResults.map(r => r.summary.profitFactor.toFixed(2))
    },
    {
      label: 'Max Drawdown',
      values: allResults.map(r => `${RED}${r.summary.maxDD.toFixed(2)}%${RESET}`)
    },
    {
      label: `Trade Freq (/month)`,
      values: allResults.map(r => `${r.summary.freq}/mo`)
    }
  ];

  rows.forEach(row => {
    const label = row.label.padEnd(METRIC_COL);
    const cols  = row.values.map(v => pad(v, COL)).join('');
    console.log(`${label}${cols}`);
  });

  console.log('-'.repeat(METRIC_COL + COL * STRATEGIES.length));

  // ── Step 4: Per-Pair Breakdown ─────────────────────────────────────────────
  console.log(`\n${BOLD}${CYAN}${'='.repeat(90)}`);
  console.log(`  🔎  PER-PAIR BREAKDOWN`);
  console.log(`${'='.repeat(90)}${RESET}`);

  const pairHeader = `${BOLD}${'Pair'.padEnd(10)}${'Config'.padEnd(30)}${'Trades'.padStart(7)}${'WR%'.padStart(8)}${'ROI'.padStart(10)}${'Max DD'.padStart(9)}${RESET}`;
  console.log(pairHeader);
  console.log('-'.repeat(74));

  for (const symbol of symbols) {
    let firstRow = true;
    for (const result of allResults) {
      const r = result.reports.find(rp => rp.symbol === symbol);
      const pairLabel  = firstRow ? CYAN + symbol.padEnd(10) + RESET : ''.padEnd(10);
      const cfgLabel   = `${result.strategy.badge} ${result.strategy.label.substring(9, 35).padEnd(28)}`;
      const trades     = String(r.totalTrades).padStart(7);
      const wr         = `${r.winRate.toFixed(1)}%`.padStart(8);
      const roi        = colorRoi(r.roi).padEnd(20);
      const dd         = `${RED}${r.maxDrawdown.toFixed(2)}%${RESET}`;
      console.log(`${pairLabel}${cfgLabel}${trades}${wr}  ${roi}${dd}`);
      firstRow = false;
    }
    console.log('');
  }

  // ── Step 5: Winner Declaration ─────────────────────────────────────────────
  console.log(`${BOLD}${CYAN}${'='.repeat(90)}`);
  console.log(`  🏆  VERDICT`);
  console.log(`${'='.repeat(90)}${RESET}`);

  const byROI = [...allResults].sort((a, b) => b.summary.portfolioROI - a.summary.portfolioROI);
  const byWR  = [...allResults].sort((a, b) => b.summary.winRate - a.summary.winRate);
  const byDD  = [...allResults].sort((a, b) => a.summary.maxDD - b.summary.maxDD);

  console.log(`  ${BOLD}Highest ROI      ${RESET}: ${byROI[0].strategy.badge} ${BOLD}${byROI[0].strategy.label}${RESET}  ${colorRoi(byROI[0].summary.portfolioROI)}`);
  console.log(`  ${BOLD}Highest Win Rate ${RESET}: ${byWR[0].strategy.badge} ${BOLD}${byWR[0].strategy.label}${RESET}  ${byWR[0].summary.winRate.toFixed(2)}%`);
  console.log(`  ${BOLD}Lowest Drawdown  ${RESET}: ${byDD[0].strategy.badge} ${BOLD}${byDD[0].strategy.label}${RESET}  ${RED}${byDD[0].summary.maxDD.toFixed(2)}%${RESET}`);

  // Composite scoring: normalise each metric
  const scores = allResults.map(r => {
    const maxROI = Math.max(...allResults.map(x => x.summary.portfolioROI));
    const minROI = Math.min(...allResults.map(x => x.summary.portfolioROI));
    const maxWR  = Math.max(...allResults.map(x => x.summary.winRate));
    const minDD  = Math.min(...allResults.map(x => x.summary.maxDD));
    const maxDD  = Math.max(...allResults.map(x => x.summary.maxDD));

    const roiScore = maxROI !== minROI ? (r.summary.portfolioROI - minROI) / (maxROI - minROI) : 1;
    const wrScore  = (r.summary.winRate / maxWR);
    const ddScore  = maxDD !== minDD ? 1 - ((r.summary.maxDD - minDD) / (maxDD - minDD)) : 1;

    // Weighted: ROI 50%, Win Rate 30%, Drawdown Safety 20%
    const composite = (roiScore * 0.50) + (wrScore * 0.30) + (ddScore * 0.20);
    return { strategy: r.strategy, composite };
  });

  scores.sort((a, b) => b.composite - a.composite);
  const winner = scores[0];

  console.log(`\n  ${BOLD}${GREEN}🥇 RECOMMENDED APPROACH:${RESET}`);
  console.log(`  ${BOLD}${GREEN}${winner.strategy.badge} ${winner.strategy.label}${RESET}`);
  console.log(`  ${DIM}${winner.strategy.description}${RESET}`);
  console.log(`  Composite score (50% ROI + 30% WR + 20% DD safety): ${BOLD}${(winner.composite * 100).toFixed(1)}/100${RESET}\n`);

  console.log(`${CYAN}${'='.repeat(90)}${RESET}\n`);
}

runComparison().catch(err => {
  console.error(`${RED}❌ Comparison Error:${RESET}`, err);
  process.exit(1);
});
