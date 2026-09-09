// backtest_strategy6.js
/**
 * Quantitative Backtester for Strategy 6 (Post-Spike Velocity Micro-Scalper)
 * Side-by-side comparative simulation vs Strategy 5B across 7 Elite Boom & Crash Pairs.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getCandles } = require('./dataFetcher');

const CACHE_DIR = path.join(__dirname, 'cache');

// ANSI formatting
const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";

function calculateEMA(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const emaArray = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prevEma = sum / period;
  emaArray.push(prevEma);

  for (let i = period; i < values.length; i++) {
    const currentEma = (values[i] * k) + (prevEma * (1 - k));
    emaArray.push(currentEma);
    prevEma = currentEma;
  }
  return emaArray;
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prev.close),
      Math.abs(current.low - prev.close)
    );
    trs.push(tr);
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

/**
 * Simulates a single configuration on historical candles
 */
function simulateStrategy(candles, mode, minSpikes, targetRR, maxHoldingBars = 0) {
  let trades = [];
  let inTrade = false;
  let currentTrade = null;
  let cooldownUntilIndex = 0;

  // Pre-calculate 50 EMA on dataset
  const closes = candles.map(c => c.close);
  const ema50 = calculateEMA(closes, 50);

  for (let i = 55; i < candles.length; i++) {
    const c0 = candles[i];
    const emaVal = ema50[i - (closes.length - ema50.length)];

    // ── 1. TRADE LIFECYCLE MANAGEMENT ──
    if (inTrade) {
      const barsHeld = i - currentTrade.entryIndex;
      const isBullish = currentTrade.direction === 'BUY';
      
      let hitTP = isBullish ? c0.high >= currentTrade.tp : c0.low <= currentTrade.tp;
      let hitSL = isBullish ? c0.low <= currentTrade.sl : c0.high >= currentTrade.sl;
      let hitTimeStop = maxHoldingBars > 0 && barsHeld >= maxHoldingBars;

      if (hitTP) {
        trades.push({ outcome: 'WIN', pnlR: targetRR, pnlUSD: 7.47 * targetRR, bars: barsHeld });
        inTrade = false;
        currentTrade = null;
      } else if (hitSL) {
        trades.push({ outcome: 'LOSS', pnlR: -1.0, pnlUSD: -7.47, bars: barsHeld });
        inTrade = false;
        currentTrade = null;
        cooldownUntilIndex = i + 9; // 45m cooldown (9 bars)
      } else if (hitTimeStop) {
        // Closed at market on time stop
        const exitPrice = c0.close;
        const pnlDist = isBullish ? exitPrice - currentTrade.entry : currentTrade.entry - exitPrice;
        const pnlRatio = pnlDist / currentTrade.slDist;
        const pnlR = Math.max(-1.0, Math.min(targetRR, pnlRatio));
        trades.push({ 
          outcome: pnlR >= 0 ? 'TIME_WIN' : 'TIME_LOSS', 
          pnlR: parseFloat(pnlR.toFixed(2)), 
          pnlUSD: parseFloat((7.47 * pnlR).toFixed(2)), 
          bars: barsHeld 
        });
        inTrade = false;
        currentTrade = null;
      }
      continue;
    }

    if (i < cooldownUntilIndex) continue;

    // ── 2. SETUP DETECTION ──
    const c0Body = Math.abs(c0.close - c0.open);
    const c0Range = c0.high - c0.low;
    const bodyRatio = c0Range > 0 ? (c0Body / c0Range) : 0;

    if (mode === 'BOOM') {
      // Trend: Price below 50 EMA
      if (c0.close >= emaVal) continue;

      let hasSpikes = true;
      const spikeCandles = [];
      for (let s = 1; s <= minSpikes; s++) {
        const sc = candles[i - s];
        if (!sc || sc.close <= sc.open) { hasSpikes = false; break; }
        spikeCandles.push(sc);
      }
      const c0Exhaustion = c0.close < c0.open && bodyRatio >= 0.50;
      if (!hasSpikes || !c0Exhaustion) continue;

      const atrSlice = candles.slice(Math.max(0, i - 20), i + 1);
      const atr = calculateATR(atrSlice, 14);
      if (!atr || atr === 0) continue;

      // Spike magnitude filter
      const spikeClusterRange = Math.max(...spikeCandles.map(c => c.high)) - Math.min(...spikeCandles.map(c => c.low));
      if (spikeClusterRange < (0.50 * atr)) continue;

      const spikePeak = Math.max(c0.high, ...spikeCandles.map(c => c.high));
      const entry = c0.close;
      const sl = spikePeak + (atr * 1.5);
      const slDist = sl - entry;
      if (slDist <= 0) continue;

      const tp = entry - (slDist * targetRR);

      inTrade = true;
      currentTrade = {
        direction: 'SELL',
        entry,
        sl,
        tp,
        slDist,
        entryIndex: i
      };
    } else if (mode === 'CRASH') {
      // Trend: Price above 50 EMA
      if (c0.close <= emaVal) continue;

      let hasCrashes = true;
      const crashCandles = [];
      for (let s = 1; s <= minSpikes; s++) {
        const sc = candles[i - s];
        if (!sc || sc.close >= sc.open) { hasCrashes = false; break; }
        crashCandles.push(sc);
      }
      const c0Exhaustion = c0.close > c0.open && bodyRatio >= 0.50;
      if (!hasCrashes || !c0Exhaustion) continue;

      const atrSlice = candles.slice(Math.max(0, i - 20), i + 1);
      const atr = calculateATR(atrSlice, 14);
      if (!atr || atr === 0) continue;

      // Crash magnitude filter
      const crashClusterRange = Math.max(...crashCandles.map(c => c.high)) - Math.min(...crashCandles.map(c => c.low));
      if (crashClusterRange < (0.50 * atr)) continue;

      const crashTrough = Math.min(c0.low, ...crashCandles.map(c => c.low));
      const entry = c0.close;
      const sl = crashTrough - (atr * 1.5);
      const slDist = entry - sl;
      if (slDist <= 0) continue;

      const tp = entry + (slDist * targetRR);

      inTrade = true;
      currentTrade = {
        direction: 'BUY',
        entry,
        sl,
        tp,
        slDist,
        entryIndex: i
      };
    }
  }

  // Calculate stats
  const total = trades.length;
  const wins = trades.filter(t => t.pnlR > 0).length;
  const losses = trades.filter(t => t.pnlR <= 0).length;
  const winRate = total > 0 ? (wins / total * 100).toFixed(1) : "0.0";
  const netR = trades.reduce((acc, t) => acc + t.pnlR, 0);
  const netUSD = trades.reduce((acc, t) => acc + t.pnlUSD, 0);
  const avgBars = total > 0 ? (trades.reduce((acc, t) => acc + t.bars, 0) / total).toFixed(1) : "0.0";

  return {
    total,
    wins,
    losses,
    winRate,
    netR: parseFloat(netR.toFixed(1)),
    netUSD: parseFloat(netUSD.toFixed(2)),
    avgBars
  };
}

async function runComparativeBacktest() {
  console.log(`\n${BOLD}${CYAN}=================================================================================================`);
  console.log(`🧪 STRATEGY 6 (MICRO-SCALPER) VS STRATEGY 5B (SNIPER) COMPARATIVE BACKTEST`);
  console.log(`=================================================================================================${RESET}`);
  console.log(`Testing Models:`);
  console.log(`  1. Strategy 5B (Baseline): 1:1.3 R:R (Target: +$9.71 USD) | No Time Stop`);
  console.log(`  2. Strategy 6-A (Micro Scalp): 1:0.5 R:R (Target: +$3.74 USD) | 3-Bar (15m) Time Stop`);
  console.log(`  3. Strategy 6-B (Quick Scalp): 1:0.8 R:R (Target: +$5.98 USD) | 4-Bar (20m) Time Stop`);
  console.log(`  4. Strategy 6-C (Ultra Micro): 1:0.3 R:R (Target: +$2.24 USD) | 2-Bar (10m) Time Stop`);
  console.log(`-------------------------------------------------------------------------------------------------`);

  const symbols = Object.keys(config.SYMBOLS);

  const model5BResults = [];
  const model6AResults = [];
  const model6BResults = [];
  const model6CResults = [];

  for (const sym of symbols) {
    const symCfg = config.SYMBOLS[sym];
    let candles = [];

    // Load from cache
    const cacheFiles = [
      `${sym}_5m_5000.json`,
      `${sym}_5m_2500.json`,
      `${sym}_5m_2000.json`,
      `${sym}_5m_1000.json`
    ];

    for (const f of cacheFiles) {
      const p = path.join(CACHE_DIR, f);
      if (fs.existsSync(p)) {
        try {
          candles = JSON.parse(fs.readFileSync(p, 'utf8'));
          break;
        } catch (e) {}
      }
    }

    if (!candles || candles.length === 0) {
      try {
        candles = await getCandles(sym, '5m', 2000, false);
      } catch (e) {
        continue;
      }
    }

    const minSpikes = symCfg.min_spikes || 2;
    const mode = symCfg.mode;

    const res5B = simulateStrategy(candles, mode, minSpikes, 1.3, 0);
    const res6A = simulateStrategy(candles, mode, minSpikes, 0.5, 3);
    const res6B = simulateStrategy(candles, mode, minSpikes, 0.8, 4);
    const res6C = simulateStrategy(candles, mode, minSpikes, 0.3, 2);

    res5B.symbol = sym;
    res6A.symbol = sym;
    res6B.symbol = sym;
    res6C.symbol = sym;

    model5BResults.push(res5B);
    model6AResults.push(res6A);
    model6BResults.push(res6B);
    model6CResults.push(res6C);
  }

  function printModelTable(title, results) {
    console.log(`\n${BOLD}─── ${title} ───${RESET}`);
    console.log(`| ${"Symbol".padEnd(10)} | ${"Trades".padStart(7)} | ${"Wins".padStart(5)} | ${"Losses".padStart(6)} | ${"Win Rate".padStart(9)} | ${"Net PnL (R)".padStart(12)} | ${"Net PnL ($)".padStart(13)} | ${"Avg Bars".padStart(9)} |`);
    console.log(`|------------|---------|-------|--------|-----------|--------------|---------------|-----------|`);

    let totTrades = 0, totWins = 0, totLosses = 0, totR = 0, totUSD = 0;
    results.forEach(r => {
      totTrades += r.total;
      totWins += r.wins;
      totLosses += r.losses;
      totR += r.netR;
      totUSD += r.netUSD;

      const pnlColor = r.netUSD >= 0 ? GREEN : RED;
      const sign = r.netUSD >= 0 ? '+' : '';
      console.log(`| ${r.symbol.padEnd(10)} | ${String(r.total).padStart(7)} | ${String(r.wins).padStart(5)} | ${String(r.losses).padStart(6)} | ${(r.winRate + "%").padStart(9)} | ${(sign + r.netR.toFixed(1) + "R").padStart(12)} | ${pnlColor}${(sign + "$" + r.netUSD.toFixed(2)).padStart(13)}${RESET} | ${(r.avgBars + " b").padStart(9)} |`);
    });

    const totWR = totTrades > 0 ? (totWins / totTrades * 100).toFixed(1) : "0.0";
    const totColor = totUSD >= 0 ? GREEN : RED;
    const totSign = totUSD >= 0 ? '+' : '';
    console.log(`|------------|---------|-------|--------|-----------|--------------|---------------|-----------|`);
    console.log(`| ${BOLD}${"TOTAL".padEnd(10)}${RESET} | ${BOLD}${String(totTrades).padStart(7)}${RESET} | ${BOLD}${String(totWins).padStart(5)}${RESET} | ${BOLD}${String(totLosses).padStart(6)}${RESET} | ${BOLD}${(totWR + "%").padStart(9)}${RESET} | ${BOLD}${(totSign + totR.toFixed(1) + "R").padStart(12)}${RESET} | ${totColor}${BOLD}${(totSign + "$" + totUSD.toFixed(2)).padStart(13)}${RESET} | ${"---".padStart(9)} |`);
  }

  printModelTable("STRATEGY 5B BASELINE (1:1.3 R:R — Full Target Sniper)", model5BResults);
  printModelTable("STRATEGY 6-A (1:0.5 R:R Micro Scalp — 15m Time Stop)", model6AResults);
  printModelTable("STRATEGY 6-B (1:0.8 R:R Quick Scalp — 20m Time Stop)", model6BResults);
  printModelTable("STRATEGY 6-C (1:0.3 R:R Ultra Micro — 10m Time Stop)", model6CResults);
}

runComparativeBacktest();
