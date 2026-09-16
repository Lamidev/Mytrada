const fs = require('fs');
const path = require('path');
const { getCandles } = require('../dataFetcher');

const SYMBOLS = [
  { symbol: "CRASH300N", mode: "CRASH", defaultSpikes: 2 },
  { symbol: "CRASH500",  mode: "CRASH", defaultSpikes: 2 },
  { symbol: "BOOM300N",  mode: "BOOM",  defaultSpikes: 3 },
  { symbol: "BOOM200",   mode: "BOOM",  defaultSpikes: 3 },
  { symbol: "BOOM500",   mode: "BOOM",  defaultSpikes: 2 },
  { symbol: "CRASH1000", mode: "CRASH", defaultSpikes: 2 },
  { symbol: "CRASH99",   mode: "CRASH", defaultSpikes: 3 }
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

async function testThresholds() {
  const data = {};
  for (const s of SYMBOLS) {
    const ltfCandles = await getCandles(s.symbol, '5m', 2000, false);
    const htf1hCandles = await getCandles(s.symbol, '1h', 500, false);
    const htf4hCandles = await getCandles(s.symbol, '4h', 200, false);
    const dailyCandles = await getCandles(s.symbol, '1d', 100, false);
    data[s.symbol] = { ltfCandles, htf1hCandles, htf4hCandles, dailyCandles };
  }

  const thresholds = [
    { label: "Strict (Any Opposing Color)", pct: 0.0 },
    { label: "Heavy Opposing Bar (>0.15% drop)", pct: 0.15 },
    { label: "Violent Opposing Bar (>0.25% drop)", pct: 0.25 },
    { label: "Extreme Breakdown (>0.35% drop)", pct: 0.35 }
  ];

  console.log("=== COMPARING THRESHOLD TUNING (AVOIDING MISSED WINS) ===");
  console.log(`| Threshold                                | Total Trades | Wins | Losses | Win Rate | Net Profit (R) | Net USD (@$41.31) |`);
  console.log(`|------------------------------------------|--------------|------|--------|----------|----------------|-------------------|`);

  thresholds.forEach(th => {
    let totalTrades = 0, wins = 0, losses = 0, netR = 0;

    for (const item of SYMBOLS) {
      const sym = item.symbol;
      const mode = item.mode;
      const { ltfCandles, htf1hCandles, htf4hCandles, dailyCandles } = data[sym];

      const h1Closes = htf1hCandles.map(c => c.close);
      const h1Ema50 = calculateEMA(h1Closes, 50);
      const h4Closes = htf4hCandles ? htf4hCandles.map(c => c.close) : [];
      const h4Ema50 = h4Closes.length >= 50 ? calculateEMA(h4Closes, 50) : [];
      const dailyCloses = dailyCandles ? dailyCandles.map(c => c.close) : [];
      const dailyEma50 = dailyCloses.length >= 30 ? calculateEMA(dailyCloses, Math.min(50, dailyCloses.length - 1)) : [];

      let inTrade = false, currentTrade = null, cooldownUntilTime = 0, consecutiveLosses = 0, dailyLosses = 0, currentDayStr = "";

      for (let i = 25; i < ltfCandles.length; i++) {
        const c0 = ltfCandles[i];
        const cTime = (c0.time || c0.epoch * 1000);
        const dayStr = new Date(cTime).toISOString().slice(0, 10);

        if (dayStr !== currentDayStr) {
          currentDayStr = dayStr;
          dailyLosses = 0;
        }

        if (inTrade) {
          const isBullish = currentTrade.direction === 'BUY';
          const hitTP = isBullish ? c0.high >= currentTrade.tp : c0.low <= currentTrade.tp;
          const hitSL = isBullish ? c0.low <= currentTrade.sl : c0.high >= currentTrade.sl;

          if (hitTP) {
            totalTrades++; wins++; netR += 1.3;
            inTrade = false; currentTrade = null; consecutiveLosses = 0;
          } else if (hitSL) {
            totalTrades++; losses++; netR -= 1.0;
            inTrade = false; currentTrade = null; consecutiveLosses++; dailyLosses++;
            const pauseMins = dailyLosses >= 3 ? 1440 : (consecutiveLosses >= 2 ? 60 : 45);
            cooldownUntilTime = cTime + (pauseMins * 60 * 1000);
          }
          continue;
        }

        if (cTime < cooldownUntilTime) continue;
        if (dailyLosses >= 3) continue;

        const h1Idx = htf1hCandles.findIndex(c => (c.time || c.epoch * 1000) > cTime);
        const validH1Idx = h1Idx === -1 ? htf1hCandles.length - 1 : Math.max(0, h1Idx - 1);
        if (validH1Idx < 50) continue;

        const h1Candle = htf1hCandles[validH1Idx];
        const h1Close = h1Closes[validH1Idx];
        const h1Ema = h1Ema50[validH1Idx - (h1Closes.length - h1Ema50.length)];
        if (!h1Ema) continue;

        const h1Clearance = (Math.abs(h1Close - h1Ema) / h1Ema) * 100;
        if (h1Clearance < 0.08) continue;

        let h4Ok = true;
        if (h4Ema50.length > 0) {
          const h4Idx = htf4hCandles.findIndex(c => (c.time || c.epoch * 1000) > cTime);
          const validH4Idx = h4Idx === -1 ? htf4hCandles.length - 1 : Math.max(0, h4Idx - 1);
          if (validH4Idx >= 50) {
            const h4Close = h4Closes[validH4Idx];
            const h4Ema = h4Ema50[validH4Idx - (h4Closes.length - h4Ema50.length)];
            if (mode === 'CRASH' && h4Close <= h4Ema) h4Ok = false;
            if (mode === 'BOOM' && h4Close >= h4Ema) h4Ok = false;
          }
        }
        if (!h4Ok) continue;

        let dailyOk = true;
        if (dailyEma50.length > 0) {
          const dIdx = dailyCandles.findIndex(c => (c.time || c.epoch * 1000) > cTime);
          const validDIdx = dIdx === -1 ? dailyCandles.length - 1 : Math.max(0, dIdx - 1);
          if (validDIdx >= 20) {
            const dClose = dailyCloses[validDIdx];
            const dEma = dailyEma50[validDIdx - (dailyCloses.length - dailyEma50.length)];
            if (mode === 'CRASH' && dClose <= dEma) dailyOk = false;
            if (mode === 'BOOM' && dClose >= dEma) dailyOk = false;
          }
        }
        if (!dailyOk) continue;

        // Threshold check:
        const h1MovePct = ((h1Candle.close - h1Candle.open) / h1Candle.open) * 100;
        if (mode === 'CRASH') {
          // Reject if 1H dropped by more than th.pct %
          if (h1MovePct < -th.pct) continue;
        } else if (mode === 'BOOM') {
          // Reject if 1H rallied by more than th.pct %
          if (h1MovePct > th.pct) continue;
        }

        const c0Body = Math.abs(c0.close - c0.open);
        const c0Range = c0.high - c0.low;
        const bodyRatio = c0Range > 0 ? (c0Body / c0Range) : 0;
        const minSpikes = item.defaultSpikes;

        if (mode === 'BOOM') {
          if (h1Close >= h1Ema) continue;

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

          const tp = entry - (slDist * 1.3);
          inTrade = true;
          currentTrade = { direction: 'SELL', entry, sl, tp };
        } else if (mode === 'CRASH') {
          if (h1Close <= h1Ema) continue;

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

          const tp = entry + (slDist * 1.3);
          inTrade = true;
          currentTrade = { direction: 'BUY', entry, sl, tp };
        }
      }
    }

    const wr = (wins / totalTrades * 100).toFixed(1);
    const usd = (netR * 41.31).toFixed(2);
    console.log(`| ${th.label.padEnd(40)} | ${String(totalTrades).padStart(12)} | ${String(wins).padStart(4)} | ${String(losses).padStart(6)} | ${(wr + "%").padStart(8)} | ${(netR.toFixed(1) + " R").padStart(14)} | ${("$" + usd).padStart(17)} |`);
  });
}

testThresholds();
