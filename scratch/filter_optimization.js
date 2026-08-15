const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const TOP_8_SYMBOLS = {
  "BOOM200":   { name: "Boom 200 Index",  mode: "BOOM" },
  "BOOM500":   { name: "Boom 500 Index",  mode: "BOOM" },
  "BOOM300N":  { name: "Boom 300 Index",  mode: "BOOM" },
  "BOOM1000":  { name: "Boom 1000 Index", mode: "BOOM" },
  "CRASH500":  { name: "Crash 500 Index",  mode: "CRASH" },
  "CRASH600":  { name: "Crash 600 Index",  mode: "CRASH" },
  "CRASH200":  { name: "Crash 200 Index",  mode: "CRASH" },
  "CRASH1000": { name: "Crash 1000 Index", mode: "CRASH" }
};

function calculateEMA(prices, period) {
  const ema = [];
  if (prices.length === 0) return ema;
  let sum = 0;
  for (let i = 0; i < Math.min(period, prices.length); i++) sum += prices[i];
  const k = 2 / (period + 1);
  let currentEma = sum / Math.min(period, prices.length);
  ema[Math.min(period, prices.length) - 1] = currentEma;
  for (let i = period; i < prices.length; i++) {
    currentEma = prices[i] * k + currentEma * (1 - k);
    ema[i] = currentEma;
  }
  return ema;
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let trSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    trSum += tr;
  }
  return trSum / period;
}

function calculateRSI(candles, period = 14) {
  const rsi = [];
  if (candles.length < period + 1) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

function loadCandles() {
  const symbolsData = {};
  for (const [sym, meta] of Object.entries(TOP_8_SYMBOLS)) {
    const cacheFile = path.join(__dirname, '..', 'cache', `${sym}_300_3000_test.json`);
    const htfCache = path.join(__dirname, '..', 'cache', `${sym}_1h_hist_1M.json`); // or fallback
    if (fs.existsSync(cacheFile)) {
      const ltf = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      // Build 1H candles from 5M candles if needed or use existing
      const htf = [];
      for (let i = 0; i < ltf.length; i += 12) {
        const slice = ltf.slice(i, i + 12);
        if (slice.length > 0) {
          htf.push({
            time: slice[0].time,
            open: slice[0].open,
            high: Math.max(...slice.map(c => c.high)),
            low: Math.min(...slice.map(c => c.low)),
            close: slice[slice.length - 1].close
          });
        }
      }
      symbolsData[sym] = { ltf, htf, meta };
    }
  }
  return symbolsData;
}

function testFilterSetup(symbolsData, options = {}) {
  const {
    rewardRatio = 1.3,
    atrMultiplier = 1.5,
    minBodyRatio = 0.50,
    minSpikes = 2,
    useRSIFilter = false,
    minSpikeSizeATR = 0.0, // spike height must be >= X * ATR
    useHtfDistance = false, // price must be at least 0.05% away from 50 EMA (no flat chop)
    riskUSD = 100.0
  } = options;

  let allTrades = [];

  for (const [sym, data] of Object.entries(symbolsData)) {
    const { ltf, htf, meta } = data;
    const mode = meta.mode;
    const htfCloses = htf.map(c => c.close);
    const htfEMA = calculateEMA(htfCloses, 50);
    const rsiValues = useRSIFilter ? calculateRSI(ltf, 14) : null;

    let activeTrade = null;

    for (let i = 20; i < ltf.length; i++) {
      const c0 = ltf[i];
      const c1 = ltf[i - 1];
      const c2 = ltf[i - 2];

      if (activeTrade) {
        let hitTP = false, hitSL = false;
        if (activeTrade.direction === 'SELL') {
          if (c0.high >= activeTrade.sl) hitSL = true;
          else if (c0.low <= activeTrade.tp) hitTP = true;
        } else {
          if (c0.low <= activeTrade.sl) hitSL = true;
          else if (c0.high >= activeTrade.tp) hitTP = true;
        }

        if (hitTP || hitSL) {
          activeTrade.outcome = hitTP ? 'WIN' : 'LOSS';
          activeTrade.pnlR = hitTP ? rewardRatio : -1.0;
          activeTrade.pnlUSD = hitTP ? (riskUSD * rewardRatio) : -riskUSD;
          allTrades.push(activeTrade);
          activeTrade = null;
        }
      }

      if (activeTrade) continue;

      // 1H trend alignment
      let htfIdx = -1;
      for (let h = 0; h < htf.length; h++) {
        if (htf[h].time <= c0.time) htfIdx = h;
        else break;
      }
      if (htfIdx < 50) continue;

      const currentHtfClose = htf[htfIdx].close;
      const currentHtfEma = htfEMA[htfIdx];
      const htfTrend = currentHtfClose > currentHtfEma ? 'bullish' : 'bearish';

      if (mode === 'BOOM' && htfTrend !== 'bearish') continue;
      if (mode === 'CRASH' && htfTrend !== 'bullish') continue;

      if (useHtfDistance) {
        const emaDistPct = Math.abs(currentHtfClose - currentHtfEma) / currentHtfEma;
        if (emaDistPct < 0.0008) continue; // Skip if hovering directly on EMA line
      }

      const sliceLtf = ltf.slice(0, i + 1);
      const atr = calculateATR(sliceLtf, 14);
      if (!atr || atr === 0) continue;

      const c0Range = c0.high - c0.low;
      const c0Body = Math.abs(c0.close - c0.open);

      if (mode === 'BOOM') {
        const c1Spike = c1.close > c1.open;
        const c2Spike = c2.close > c2.open;
        const c0Exhaustion = c0.close < c0.open && c0Range > 0 && (c0Body / c0Range) >= minBodyRatio;

        if (!c1Spike || !c2Spike || !c0Exhaustion) continue;

        if (minSpikes === 3) {
          const c3 = ltf[i - 3];
          if (!(c3.close > c3.open)) continue;
        }

        const spikePeak = Math.max(c0.high, c1.high, c2.high);
        const spikeHeight = spikePeak - Math.min(c1.low, c2.low);
        if (minSpikeSizeATR > 0 && spikeHeight < atr * minSpikeSizeATR) continue;

        if (useRSIFilter && rsiValues) {
          const rsiAtPeak = Math.max(rsiValues[i - 1] || 50, rsiValues[i - 2] || 50);
          if (rsiAtPeak < 65) continue; // Must be overbought
        }

        const entry = c0.close;
        const sl = spikePeak + (atr * atrMultiplier);
        const slDist = Math.abs(entry - sl);
        const tp = entry - (slDist * rewardRatio);
        activeTrade = { symbol: sym, direction: 'SELL', entry, sl, tp, slDist };
      } else {
        const c1Crash = c1.close < c1.open;
        const c2Crash = c2.close < c2.open;
        const c0Exhaustion = c0.close > c0.open && c0Range > 0 && (c0Body / c0Range) >= minBodyRatio;

        if (!c1Crash || !c2Crash || !c0Exhaustion) continue;

        if (minSpikes === 3) {
          const c3 = ltf[i - 3];
          if (!(c3.close < c3.open)) continue;
        }

        const crashTrough = Math.min(c0.low, c1.low, c2.low);
        const crashDepth = Math.max(c1.high, c2.high) - crashTrough;
        if (minSpikeSizeATR > 0 && crashDepth < atr * minSpikeSizeATR) continue;

        if (useRSIFilter && rsiValues) {
          const rsiAtTrough = Math.min(rsiValues[i - 1] || 50, rsiValues[i - 2] || 50);
          if (rsiAtTrough > 35) continue; // Must be oversold
        }

        const entry = c0.close;
        const sl = crashTrough - (atr * atrMultiplier);
        const slDist = Math.abs(entry - sl);
        const tp = entry + (slDist * rewardRatio);
        activeTrade = { symbol: sym, direction: 'BUY', entry, sl, tp, slDist };
      }
    }
  }

  const wins = allTrades.filter(t => t.outcome === 'WIN').length;
  const losses = allTrades.filter(t => t.outcome === 'LOSS').length;
  const total = wins + losses;
  const winRate = total > 0 ? (wins / total * 100).toFixed(2) : '0';
  const grossProfit = wins * (riskUSD * rewardRatio);
  const grossLoss = losses * riskUSD;
  const netUSD = grossProfit - grossLoss;
  const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : 'N/A';

  return { total, wins, losses, winRate, netUSD, profitFactor };
}

function main() {
  const symbolsData = loadCandles();
  console.log("Loaded symbols data for optimization testing.\n");

  const filterTests = [
    { name: "1. Baseline (Current Settings: 1:1.3 RR, 1.5x ATR SL, 50% Body)", opts: { rewardRatio: 1.3, atrMultiplier: 1.5, minBodyRatio: 0.50 } },
    { name: "2. Higher SL Buffer (1.8x ATR SL - Prevents Re-Test Stopouts)", opts: { rewardRatio: 1.3, atrMultiplier: 1.8, minBodyRatio: 0.50 } },
    { name: "3. Stronger Exhaustion Body (60% Body Ratio)", opts: { rewardRatio: 1.3, atrMultiplier: 1.5, minBodyRatio: 0.60 } },
    { name: "4. Stronger Exhaustion Body (70% Body Ratio - Institutional Close)", opts: { rewardRatio: 1.3, atrMultiplier: 1.5, minBodyRatio: 0.70 } },
    { name: "5. Minimum Spike Height Filter (Spike >= 1.5x ATR - Avoid Micro Noise)", opts: { rewardRatio: 1.3, atrMultiplier: 1.5, minSpikeSizeATR: 1.5 } },
    { name: "6. RSI Momentum Filter (Overbought >65 on Boom / Oversold <35 on Crash)", opts: { rewardRatio: 1.3, atrMultiplier: 1.5, useRSIFilter: true } },
    { name: "7. 1H Trend Clearance (Avoid Flat 50 EMA Chop)", opts: { rewardRatio: 1.3, atrMultiplier: 1.5, useHtfDistance: true } },
    { name: "8. 3+ Consecutive Spikes (Ultra-Exhaustion)", opts: { rewardRatio: 1.3, atrMultiplier: 1.5, minSpikes: 3 } },
    { name: "9. Optimized Combo A (1:1.4 RR + 60% Body + 1.8x ATR SL)", opts: { rewardRatio: 1.4, atrMultiplier: 1.8, minBodyRatio: 0.60 } },
    { name: "10. Optimized Combo B (1:1.5 RR + 60% Body + 1.8x ATR SL + Spike>=1.5xATR)", opts: { rewardRatio: 1.5, atrMultiplier: 1.8, minBodyRatio: 0.60, minSpikeSizeATR: 1.5 } },
    { name: "11. Elite Sniper Combo (1:1.4 RR + 65% Body + RSI Filter + 1.8x ATR SL)", opts: { rewardRatio: 1.4, atrMultiplier: 1.8, minBodyRatio: 0.65, useRSIFilter: true } },
  ];

  const results = {};
  filterTests.forEach(test => {
    results[test.name] = testFilterSetup(symbolsData, test.opts);
  });

  console.table(results);
}

main();
