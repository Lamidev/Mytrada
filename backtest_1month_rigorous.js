// backtest_1month_rigorous.js
/**
 * Rigorous 30-Day Multi-Timeframe Confluence Backtester for Strategy 5B & Strategy 6
 * Runs on exact 1-Month (8,640 x M5 bars) historical datasets for the 7 Elite Pairs.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getCandles, getHistoricalCandles } = require('./dataFetcher');

const CACHE_DIR = path.join(__dirname, 'cache');

// Formatting
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
 * Runs 30-Day Multi-Timeframe Simulation for a specific strategy
 */
function run30DaySimulation(symbol, ltfCandles, htf1hCandles, htf4hCandles, mode, minSpikes, targetRR, maxHoldingBars = 0) {
  let trades = [];
  let inTrade = false;
  let currentTrade = null;
  let cooldownUntilTime = 0;
  let consecutiveLosses = 0;
  let dailyLosses = 0;
  let currentDayStr = "";

  // Precompute 1H 50 EMA
  const h1Closes = htf1hCandles.map(c => c.close);
  const h1Ema50 = calculateEMA(h1Closes, 50);

  // Precompute 4H 50 EMA
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

    // ── 1. ACTIVE TRADE LIFECYCLE ──
    if (inTrade) {
      const barsHeld = i - currentTrade.entryIndex;
      const isBullish = currentTrade.direction === 'BUY';
      
      let hitTP = isBullish ? c0.high >= currentTrade.tp : c0.low <= currentTrade.tp;
      let hitSL = isBullish ? c0.low <= currentTrade.sl : c0.high >= currentTrade.sl;
      let hitTimeStop = maxHoldingBars > 0 && barsHeld >= maxHoldingBars;

      if (hitTP) {
        trades.push({
          outcome: 'WIN',
          pnlR: targetRR,
          pnlUSD: 7.47 * targetRR,
          bars: barsHeld,
          time: new Date(cTime).toISOString()
        });
        inTrade = false;
        currentTrade = null;
        consecutiveLosses = 0;
      } else if (hitSL) {
        trades.push({
          outcome: 'LOSS',
          pnlR: -1.0,
          pnlUSD: -7.47,
          bars: barsHeld,
          time: new Date(cTime).toISOString()
        });
        inTrade = false;
        currentTrade = null;
        consecutiveLosses++;
        dailyLosses++;

        // Tiered Cooldown
        const pauseMins = dailyLosses >= 3 ? 360 : (consecutiveLosses >= 2 ? 60 : 45);
        cooldownUntilTime = cTime + (pauseMins * 60 * 1000);
      } else if (hitTimeStop) {
        const exitPrice = c0.close;
        const pnlDist = isBullish ? exitPrice - currentTrade.entry : currentTrade.entry - exitPrice;
        const pnlRatio = pnlDist / currentTrade.slDist;
        const pnlR = Math.max(-1.0, Math.min(targetRR, pnlRatio));
        trades.push({
          outcome: pnlR >= 0 ? 'TIME_WIN' : 'TIME_LOSS',
          pnlR: parseFloat(pnlR.toFixed(2)),
          pnlUSD: parseFloat((7.47 * pnlR).toFixed(2)),
          bars: barsHeld,
          time: new Date(cTime).toISOString()
        });
        inTrade = false;
        currentTrade = null;
      }
      continue;
    }

    if (cTime < cooldownUntilTime) continue;

    // ── 2. HTF MULTI-TIMEFRAME CONFLUENCE ──
    // Find latest completed 1H candle prior to cTime
    const h1Idx = htf1hCandles.findIndex(c => (c.time || c.epoch * 1000) > cTime);
    const validH1Idx = h1Idx === -1 ? htf1hCandles.length - 1 : Math.max(0, h1Idx - 1);
    if (validH1Idx < 50) continue;

    const h1Close = h1Closes[validH1Idx];
    const h1Ema = h1Ema50[validH1Idx - (h1Closes.length - h1Ema50.length)];
    if (!h1Ema) continue;

    const h1Clearance = (Math.abs(h1Close - h1Ema) / h1Ema) * 100;
    if (h1Clearance < 0.08) continue; // Chop Filter

    // 4H Trend
    const h4Idx = htf4hCandles.findIndex(c => (c.time || c.epoch * 1000) > cTime);
    const validH4Idx = h4Idx === -1 ? htf4hCandles.length - 1 : Math.max(0, h4Idx - 1);
    const h4Close = validH4Idx >= 0 ? h4Closes[validH4Idx] : null;
    const h4Ema = validH4Idx >= 50 ? h4Ema50[validH4Idx - (h4Closes.length - h4Ema50.length)] : null;

    // ── 3. LTF STRATEGY 5B EXECUTION ──
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

      // Spike magnitude filter (>= 0.5x ATR)
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

      // Crash magnitude filter (>= 0.5x ATR)
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

  const total = trades.length;
  const wins = trades.filter(t => t.pnlR > 0).length;
  const losses = trades.filter(t => t.pnlR <= 0).length;
  const winRate = total > 0 ? (wins / total * 100).toFixed(1) : "0.0";
  const netR = trades.reduce((acc, t) => acc + t.pnlR, 0);
  const netUSD = trades.reduce((acc, t) => acc + t.pnlUSD, 0);
  const avgBars = total > 0 ? (trades.reduce((acc, t) => acc + t.bars, 0) / total).toFixed(1) : "0.0";

  // Max Drawdown calculation
  let peak = 0;
  let currentEquity = 0;
  let maxDD = 0;
  trades.forEach(t => {
    currentEquity += t.pnlUSD;
    if (currentEquity > peak) peak = currentEquity;
    const dd = peak - currentEquity;
    if (dd > maxDD) maxDD = dd;
  });

  return {
    symbol,
    total,
    wins,
    losses,
    winRate,
    netR: parseFloat(netR.toFixed(1)),
    netUSD: parseFloat(netUSD.toFixed(2)),
    maxDD: parseFloat(maxDD.toFixed(2)),
    avgBars,
    trades
  };
}

async function loadDataset(sym) {
  let ltfCandles = [], htf1hCandles = [], htf4hCandles = [];

  const ltfFiles = [`${sym}_5m_hist_1M.json`, `${sym}_5m_5000.json`, `${sym}_5m_2500.json`, `${sym}_5m_2000.json`];
  const h1Files  = [`${sym}_1h_hist_1M.json`, `${sym}_1h_1000.json`, `${sym}_1h_700.json`, `${sym}_1h_500.json`];
  const h4Files  = [`${sym}_4h_hist_1M.json`, `${sym}_4h_600.json`, `${sym}_4h_500.json`, `${sym}_4h_300.json`];

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

async function execute1MonthAudit() {
  console.log(`\n${BOLD}${CYAN}=================================================================================================`);
  console.log(`🏛️ MYTRADA INSTITUTIONAL 30-DAY RIGOROUS HISTORICAL BACKTEST (7 ELITE PAIRS)`);
  console.log(`=================================================================================================${RESET}`);
  console.log(`• Test Period   : Full 30-Day Historical Dataset (1 Month M5 / 1H / 4H Candles)`);
  console.log(`• Sizing Anchor : $249.10 USD Active Equity (Trade Risk: $7.47 USD / 3.0%)`);
  console.log(`• Confluence    : Daily + 4H + 1H 50 EMA Macro Trend + 1H Chop Clearance Filter (>0.08%)`);
  console.log(`• Protection    : Spike Magnitude Filter (>=0.5x ATR) + 45m/60m Tiered Circuit Breakers`);
  console.log(`-------------------------------------------------------------------------------------------------`);

  const symbols = Object.keys(config.SYMBOLS);

  const results5B = [];
  const results6A = [];
  const results6C = [];

  for (const sym of symbols) {
    const symCfg = config.SYMBOLS[sym];
    const { ltfCandles, htf1hCandles, htf4hCandles } = await loadDataset(sym);

    if (!ltfCandles || ltfCandles.length < 500 || !htf1hCandles || htf1hCandles.length < 50) {
      console.warn(`[WARN] Insufficient historical data for ${sym}`);
      continue;
    }

    const minSpikes = symCfg.min_spikes || 2;
    const mode = symCfg.mode;

    const r5B = run30DaySimulation(sym, ltfCandles, htf1hCandles, htf4hCandles, mode, minSpikes, 1.3, 0);
    const r6A = run30DaySimulation(sym, ltfCandles, htf1hCandles, htf4hCandles, mode, minSpikes, 0.5, 3);
    const r6C = run30DaySimulation(sym, ltfCandles, htf1hCandles, htf4hCandles, mode, minSpikes, 0.3, 2);

    results5B.push(r5B);
    results6A.push(r6A);
    results6C.push(r6C);
  }

  function displayTable(title, resList) {
    console.log(`\n${BOLD}─── ${title} ───${RESET}`);
    console.log(`| ${"Symbol".padEnd(10)} | ${"Trades".padStart(7)} | ${"Wins".padStart(5)} | ${"Losses".padStart(6)} | ${"Win Rate".padStart(9)} | ${"Net PnL (R)".padStart(12)} | ${"Net Profit ($)".padStart(15)} | ${"Max DD ($)".padStart(11)} |`);
    console.log(`|------------|---------|-------|--------|-----------|--------------|-----------------|-------------|`);

    let totTrades = 0, totWins = 0, totLosses = 0, totR = 0, totUSD = 0, totMaxDD = 0;
    resList.forEach(r => {
      totTrades += r.total;
      totWins += r.wins;
      totLosses += r.losses;
      totR += r.netR;
      totUSD += r.netUSD;
      if (r.maxDD > totMaxDD) totMaxDD = r.maxDD;

      const pnlColor = r.netUSD >= 0 ? GREEN : RED;
      const sign = r.netUSD >= 0 ? '+' : '';
      console.log(`| ${r.symbol.padEnd(10)} | ${String(r.total).padStart(7)} | ${String(r.wins).padStart(5)} | ${String(r.losses).padStart(6)} | ${(r.winRate + "%").padStart(9)} | ${(sign + r.netR.toFixed(1) + "R").padStart(12)} | ${pnlColor}${(sign + "$" + r.netUSD.toFixed(2)).padStart(15)}${RESET} | ${("$" + r.maxDD.toFixed(2)).padStart(11)} |`);
    });

    const totWR = totTrades > 0 ? (totWins / totTrades * 100).toFixed(1) : "0.0";
    const totColor = totUSD >= 0 ? GREEN : RED;
    const totSign = totUSD >= 0 ? '+' : '';
    console.log(`|------------|---------|-------|--------|-----------|--------------|-----------------|-------------|`);
    console.log(`| ${BOLD}${"TOTAL".padEnd(10)}${RESET} | ${BOLD}${String(totTrades).padStart(7)}${RESET} | ${BOLD}${String(totWins).padStart(5)}${RESET} | ${BOLD}${String(totLosses).padStart(6)}${RESET} | ${BOLD}${(totWR + "%").padStart(9)}${RESET} | ${BOLD}${(totSign + totR.toFixed(1) + "R").padStart(12)}${RESET} | ${totColor}${BOLD}${(totSign + "$" + totUSD.toFixed(2)).padStart(15)}${RESET} | ${BOLD}${("$" + totMaxDD.toFixed(2)).padStart(11)}${RESET} |`);
  }

  displayTable("👑 STRATEGY 5B (1:1.3 R:R — Full Confluence Momentum Sniper)", results5B);
  displayTable("⚡ STRATEGY 6-A (1:0.5 R:R — 15m Time-Stop Micro-Scalper)", results6A);
  displayTable("🚀 STRATEGY 6-C (1:0.3 R:R — 10m Time-Stop Ultra-Micro)", results6C);
}

execute1MonthAudit();
