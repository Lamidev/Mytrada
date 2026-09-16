// scratch/compare_2_vs_3_spikes.js
const fs = require('fs');
const path = require('path');
const config = require('../config');

// Formatting
const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";

const CACHE_DIR = path.join(__dirname, '..', 'cache');

const ALL_SYMBOLS = [
  // Monitored
  { symbol: "BOOM100",  name: "Boom 100 Index",  mode: "BOOM", monitored: true },
  { symbol: "BOOM300N", name: "Boom 300 Index",  mode: "BOOM", monitored: true },
  { symbol: "BOOM600",  name: "Boom 600 Index",  mode: "BOOM", monitored: true },
  { symbol: "BOOM900",  name: "Boom 900 Index",  mode: "BOOM", monitored: true },
  { symbol: "CRASH1000", name: "Crash 1000 Index", mode: "CRASH", monitored: true },
  { symbol: "CRASH200",  name: "Crash 200 Index",  mode: "CRASH", monitored: true },
  { symbol: "CRASH500",  name: "Crash 500 Index",  mode: "CRASH", monitored: true },

  // Non-monitored
  { symbol: "BOOM500",   name: "Boom 500 Index",   mode: "BOOM", monitored: false },
  { symbol: "CRASH600",  name: "Crash 600 Index",  mode: "CRASH", monitored: false },
  { symbol: "CRASH900",  name: "Crash 900 Index",  mode: "CRASH", monitored: false },
  { symbol: "CRASH300N", name: "Crash 300 Index",  mode: "CRASH", monitored: false },
  { symbol: "CRASH50",   name: "Crash 50 Index",   mode: "CRASH", monitored: false },
  { symbol: "BOOM200",   name: "Boom 200 Index",   mode: "BOOM", monitored: false },
  { symbol: "CRASH99",   name: "Crash 99 Index",   mode: "CRASH", monitored: false },
  { symbol: "CRASH100",  name: "Crash 100 Index",  mode: "CRASH", monitored: false },
  { symbol: "BOOM1000",  name: "Boom 1000 Index",  mode: "BOOM", monitored: false },
  { symbol: "CRASH150N", name: "Crash 150 Index",  mode: "CRASH", monitored: false },
  { symbol: "BOOM150N",  name: "Boom 150 Index",   mode: "BOOM", monitored: false },
  { symbol: "BOOM50",    name: "Boom 50 Index",    mode: "BOOM", monitored: false },
  { symbol: "BOOM99",    name: "Boom 99 Index",    mode: "BOOM", monitored: false }
];

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

function runSim(ltfCandles, htf1hCandles, htf4hCandles, mode, minSpikes) {
  let trades = [];
  let inTrade = false;
  let currentTrade = null;
  let cooldownUntilTime = 0;
  let consecutiveLosses = 0;
  let dailyLosses = 0;
  let currentDayStr = "";
  const targetRR = 1.3;

  const h1Closes = htf1hCandles.map(c => c.close);
  const h1Ema50 = calculateEMA(h1Closes, 50);
  const h4Closes = htf4hCandles.map(c => c.close);
  const h4Ema50 = calculateEMA(h4Closes, 50);

  for (let i = 25; i < ltfCandles.length; i++) {
    const c0 = ltfCandles[i];
    const cTime = c0.time || c0.epoch * 1000;
    const dayStr = new Date(cTime).toISOString().slice(0, 10);

    if (dayStr !== currentDayStr) {
      currentDayStr = dayStr;
      dailyLosses = 0;
    }

    if (inTrade) {
      const barsHeld = i - currentTrade.entryIndex;
      const isBullish = currentTrade.direction === 'BUY';
      let hitTP = isBullish ? c0.high >= currentTrade.tp : c0.low <= currentTrade.tp;
      let hitSL = isBullish ? c0.low <= currentTrade.sl : c0.high >= currentTrade.sl;

      if (hitTP) {
        trades.push({ outcome: 'WIN', pnlR: targetRR, pnlUSD: 3.0 * targetRR, bars: barsHeld });
        inTrade = false;
        currentTrade = null;
        consecutiveLosses = 0;
      } else if (hitSL) {
        trades.push({ outcome: 'LOSS', pnlR: -1.0, pnlUSD: -3.0, bars: barsHeld });
        inTrade = false;
        currentTrade = null;
        consecutiveLosses++;
        dailyLosses++;
        const pauseMins = dailyLosses >= 3 ? 360 : (consecutiveLosses >= 2 ? 60 : 45);
        cooldownUntilTime = cTime + (pauseMins * 60 * 1000);
      }
      continue;
    }

    if (cTime < cooldownUntilTime) continue;

    const h1Idx = htf1hCandles.findIndex(c => (c.time || c.epoch * 1000) > cTime);
    const validH1Idx = h1Idx === -1 ? htf1hCandles.length - 1 : Math.max(0, h1Idx - 1);
    if (validH1Idx < 50) continue;

    const h1Close = h1Closes[validH1Idx];
    const h1Ema = h1Ema50[validH1Idx - (h1Closes.length - h1Ema50.length)];
    if (!h1Ema) continue;

    const h1Clearance = (Math.abs(h1Close - h1Ema) / h1Ema) * 100;
    if (h1Clearance < 0.08) continue;

    const h4Idx = htf4hCandles.findIndex(c => (c.time || c.epoch * 1000) > cTime);
    const validH4Idx = h4Idx === -1 ? htf4hCandles.length - 1 : Math.max(0, h4Idx - 1);
    const h4Close = validH4Idx >= 0 ? h4Closes[validH4Idx] : null;
    const h4Ema = validH4Idx >= 50 ? h4Ema50[validH4Idx - (h4Closes.length - h4Ema50.length)] : null;

    const c0Body = Math.abs(c0.close - c0.open);
    const c0Range = c0.high - c0.low;
    const bodyRatio = c0Range > 0 ? (c0Body / c0Range) : 0;

    if (mode === 'BOOM') {
      if (h1Close >= h1Ema) continue;
      if (h4Close && h4Ema && h4Close >= h4Ema) continue;

      let hasSpikes = true;
      const spikeCandles = [];
      for (let s = 1; s <= minSpikes; s++) {
        const sc = ltfCandles[i - s];
        if (!sc || sc.close <= sc.open) { hasSpikes = false; break; }
        spikeCandles.push(sc);
      }
      const c0Exhaustion = c0.close < c0.open && bodyRatio >= 0.50;
      if (!hasSpikes || !c0Exhaustion) continue;

      const atrSlice = ltfCandles.slice(Math.max(0, i - 20), i + 1);
      const atr = calculateATR(atrSlice, 14);
      if (!atr || atr === 0) continue;

      const spikeClusterRange = Math.max(...spikeCandles.map(c => c.high)) - Math.min(...spikeCandles.map(c => c.low));
      if (spikeClusterRange < (0.50 * atr)) continue;

      const spikePeak = Math.max(c0.high, ...spikeCandles.map(c => c.high));
      const entry = c0.close;
      const sl = spikePeak + (atr * 1.5);
      const slDist = sl - entry;
      if (slDist <= 0) continue;

      const tp = entry - (slDist * targetRR);
      inTrade = true;
      currentTrade = { direction: 'SELL', entry, sl, tp, slDist, entryIndex: i };
    } else if (mode === 'CRASH') {
      if (h1Close <= h1Ema) continue;
      if (h4Close && h4Ema && h4Close <= h4Ema) continue;

      let hasCrashes = true;
      const crashCandles = [];
      for (let s = 1; s <= minSpikes; s++) {
        const sc = ltfCandles[i - s];
        if (!sc || sc.close >= sc.open) { hasCrashes = false; break; }
        crashCandles.push(sc);
      }
      const c0Exhaustion = c0.close > c0.open && bodyRatio >= 0.50;
      if (!hasCrashes || !c0Exhaustion) continue;

      const atrSlice = ltfCandles.slice(Math.max(0, i - 20), i + 1);
      const atr = calculateATR(atrSlice, 14);
      if (!atr || atr === 0) continue;

      const crashClusterRange = Math.max(...crashCandles.map(c => c.high)) - Math.min(...crashCandles.map(c => c.low));
      if (crashClusterRange < (0.50 * atr)) continue;

      const crashTrough = Math.min(c0.low, ...crashCandles.map(c => c.low));
      const entry = c0.close;
      const sl = crashTrough - (atr * 1.5);
      const slDist = entry - sl;
      if (slDist <= 0) continue;

      const tp = entry + (slDist * targetRR);
      inTrade = true;
      currentTrade = { direction: 'BUY', entry, sl, tp, slDist, entryIndex: i };
    }
  }

  const total = trades.length;
  const wins = trades.filter(t => t.pnlR > 0).length;
  const losses = trades.filter(t => t.pnlR <= 0).length;
  const winRate = total > 0 ? (wins / total * 100).toFixed(1) : "0.0";
  const netR = trades.reduce((acc, t) => acc + t.pnlR, 0);
  const netUSD = trades.reduce((acc, t) => acc + t.pnlUSD, 0);

  let peak = 0, currentEquity = 0, maxDD = 0;
  trades.forEach(t => {
    currentEquity += t.pnlUSD;
    if (currentEquity > peak) peak = currentEquity;
    const dd = peak - currentEquity;
    if (dd > maxDD) maxDD = dd;
  });

  return { total, wins, losses, winRate: parseFloat(winRate), netR: parseFloat(netR.toFixed(1)), netUSD: parseFloat(netUSD.toFixed(2)), maxDD: parseFloat(maxDD.toFixed(2)) };
}

function loadCandles(sym) {
  let ltfCandles = [], htf1hCandles = [], htf4hCandles = [];
  const ltfFiles = [`${sym}_5m_hist_1M.json`, `${sym}_5m_5000.json`, `${sym}_5m_2500.json`, `${sym}_5m_2000.json`];
  const h1Files  = [`${sym}_1h_hist_1M.json`, `${sym}_1h_1000.json`, `${sym}_1h_700.json`, `${sym}_1h_500.json`, `${sym}_1h_200.json`];
  const h4Files  = [`${sym}_4h_hist_1M.json`, `${sym}_4h_600.json`, `${sym}_4h_500.json`, `${sym}_4h_300.json`, `${sym}_4h_200.json`];

  for (const f of ltfFiles) {
    const p = path.join(CACHE_DIR, f);
    if (fs.existsSync(p)) {
      try { ltfCandles = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch (e) {}
    }
  }
  for (const f of h1Files) {
    const p = path.join(CACHE_DIR, f);
    if (fs.existsSync(p)) {
      try { htf1hCandles = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch (e) {}
    }
  }
  for (const f of h4Files) {
    const p = path.join(CACHE_DIR, f);
    if (fs.existsSync(p)) {
      try { htf4hCandles = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch (e) {}
    }
  }
  return { ltfCandles, htf1hCandles, htf4hCandles };
}

function executeComparison() {
  const comparison = [];

  for (const item of ALL_SYMBOLS) {
    const { symbol, name, mode, monitored } = item;
    const { ltfCandles, htf1hCandles, htf4hCandles } = loadCandles(symbol);
    if (!ltfCandles || ltfCandles.length < 300 || !htf1hCandles || htf1hCandles.length < 50) continue;

    const res2 = runSim(ltfCandles, htf1hCandles, htf4hCandles, mode, 2);
    const res3 = runSim(ltfCandles, htf1hCandles, htf4hCandles, mode, 3);

    comparison.push({
      symbol,
      name,
      monitored,
      res2,
      res3
    });
  }

  function printGroup(title, items) {
    console.log(`\n${BOLD}========================================================================================================================`);
    console.log(` ${title}`);
    console.log(`========================================================================================================================${RESET}`);
    console.log(`| Symbol     | Name             | 2-Spike Trades | 2-Spike WR | 2-Spike PnL ($) | 3-Spike Trades | 3-Spike WR | 3-Spike PnL ($) | Verdict / Impact |`);
    console.log(`|------------|------------------|----------------|------------|-----------------|----------------|------------|-----------------|------------------|`);

    items.forEach(c => {
      const { symbol, name, res2, res3 } = c;
      const pnl2Color = res2.netUSD >= 0 ? GREEN : RED;
      const pnl3Color = res3.netUSD >= 0 ? GREEN : RED;
      const sign2 = res2.netUSD >= 0 ? '+' : '';
      const sign3 = res3.netUSD >= 0 ? '+' : '';

      let verdict = "";
      const pnlDiff = res3.netUSD - res2.netUSD;
      const wrDiff = res3.winRate - res2.winRate;

      if (res3.netUSD > res2.netUSD && res3.winRate >= res2.winRate) {
        verdict = `${GREEN}3-Spike Wins (+${wrDiff.toFixed(1)}% WR)${RESET}`;
      } else if (res2.netUSD > res3.netUSD) {
        verdict = `${CYAN}2-Spike Wins (+$${(-pnlDiff).toFixed(1)})${RESET}`;
      } else {
        verdict = `Comparable`;
      }

      console.log(`| ${symbol.padEnd(10)} | ${name.padEnd(16)} | ${String(res2.total).padStart(14)} | ${(res2.winRate + "%").padStart(10)} | ${pnl2Color}${(sign2 + "$" + res2.netUSD.toFixed(2)).padStart(15)}${RESET} | ${String(res3.total).padStart(14)} | ${(res3.winRate + "%").padStart(10)} | ${pnl3Color}${(sign3 + "$" + res3.netUSD.toFixed(2)).padStart(15)}${RESET} | ${verdict.padEnd(25)} |`);
    });
  }

  const monitoredItems = comparison.filter(c => c.monitored);
  const unmonitoredItems = comparison.filter(c => !c.monitored);

  printGroup("🟢 CURRENTLY MONITORED PAIRS (2-SPIKE vs 3-SPIKE)", monitoredItems);
  printGroup("⭐ UNMONITORED PAIRS (2-SPIKE vs 3-SPIKE)", unmonitoredItems);
}

executeComparison();
