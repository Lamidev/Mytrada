const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const ALL_20_SYMBOLS = {
  "BOOM50":    { name: "Boom 50 Index",   mode: "BOOM" },
  "BOOM99":    { name: "Boom 99 Index",   mode: "BOOM" },
  "BOOM100":   { name: "Boom 100 Index",  mode: "BOOM" },
  "BOOM150N":  { name: "Boom 150 Index",  mode: "BOOM" },
  "BOOM200":   { name: "Boom 200 Index",  mode: "BOOM" },
  "BOOM300N":  { name: "Boom 300 Index",  mode: "BOOM" },
  "BOOM500":   { name: "Boom 500 Index",  mode: "BOOM" },
  "BOOM600":   { name: "Boom 600 Index",  mode: "BOOM" },
  "BOOM900":   { name: "Boom 900 Index",  mode: "BOOM" },
  "BOOM1000":  { name: "Boom 1000 Index", mode: "BOOM" },
  "CRASH50":   { name: "Crash 50 Index",   mode: "CRASH" },
  "CRASH99":   { name: "Crash 99 Index",   mode: "CRASH" },
  "CRASH100":  { name: "Crash 100 Index",  mode: "CRASH" },
  "CRASH150N": { name: "Crash 150 Index",  mode: "CRASH" },
  "CRASH200":  { name: "Crash 200 Index",  mode: "CRASH" },
  "CRASH300N": { name: "Crash 300 Index",  mode: "CRASH" },
  "CRASH500":  { name: "Crash 500 Index",  mode: "CRASH" },
  "CRASH600":  { name: "Crash 600 Index",  mode: "CRASH" },
  "CRASH900":  { name: "Crash 900 Index",  mode: "CRASH" },
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

function fetchCandlesWS(symbol, granularity, count = 2000) {
  const cacheFile = path.join(__dirname, '..', 'cache', `${symbol}_${granularity}_${count}_test.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(data) && data.length > 0) return Promise.resolve(data);
    } catch(e){}
  }

  return new Promise((resolve, reject) => {
    let retries = 3;
    function attempt() {
      const ws = new WebSocket(config.DERIV_WS_URL);
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          ws.terminate();
          if (--retries > 0) setTimeout(attempt, 2000);
          else reject(new Error(`Timeout fetching ${symbol}`));
        }
      }, 20000);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          ticks_history: symbol,
          adjust_start_time: 1,
          count: count,
          end: "latest",
          style: "candles",
          granularity: granularity
        }));
      });

      ws.on('message', (msg) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.error) {
            done = true;
            clearTimeout(timer);
            ws.close();
            if (--retries > 0) setTimeout(attempt, 2000);
            else reject(new Error(data.error.message));
            return;
          }
          if (data.candles) {
            done = true;
            clearTimeout(timer);
            ws.close();
            const candles = data.candles.map(c => ({
              time: c.epoch * 1000,
              epoch: c.epoch,
              open: parseFloat(c.open),
              high: parseFloat(c.high),
              low: parseFloat(c.low),
              close: parseFloat(c.close)
            }));
            try { fs.writeFileSync(cacheFile, JSON.stringify(candles)); } catch(e){}
            resolve(candles);
          }
        } catch (err) {
          done = true;
          clearTimeout(timer);
          ws.close();
          if (--retries > 0) setTimeout(attempt, 2000);
          else reject(err);
        }
      });

      ws.on('error', (err) => {
        done = true;
        clearTimeout(timer);
        if (--retries > 0) setTimeout(attempt, 2000);
        else reject(err);
      });
    }
    attempt();
  });
}

function simulateAccount(trades, initialBalance = 100.0, riskPct = 0.03, isCompound = false) {
  let balance = initialBalance;
  let peakBalance = initialBalance;
  let maxDrawdownUSD = 0;
  let maxDrawdownPct = 0;

  const sorted = [...trades].sort((a, b) => new Date(a.closedTime).getTime() - new Date(b.closedTime).getTime());
  const tradeLogs = [];

  sorted.forEach(t => {
    const riskUSD = isCompound ? (balance * riskPct) : (initialBalance * riskPct);
    const pnlUSD = t.pnlR * riskUSD;
    balance += pnlUSD;

    if (balance > peakBalance) peakBalance = balance;
    const ddUSD = peakBalance - balance;
    const ddPct = peakBalance > 0 ? (ddUSD / peakBalance) * 100 : 0;
    if (ddUSD > maxDrawdownUSD) maxDrawdownUSD = ddUSD;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

    tradeLogs.push({ ...t, riskUSD, pnlUSD, balance });
  });

  return {
    initialBalance,
    finalBalance: balance,
    netProfit: balance - initialBalance,
    returnPct: ((balance - initialBalance) / initialBalance) * 100,
    maxDrawdownUSD,
    maxDrawdownPct,
    tradeLogs
  };
}

async function main() {
  console.log("Loading candle data for All 20 Pairs...");
  const symbolsData = {};
  for (const [sym, meta] of Object.entries(ALL_20_SYMBOLS)) {
    try {
      const ltf = await fetchCandlesWS(sym, 300, 2000);
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
    } catch (e) {
      // console.error(`Error ${sym}:`, e.message);
    }
  }

  const augustStartTime = new Date("2026-08-13T00:00:00Z").getTime();
  const rewardRatio = 1.4;

  // Test Option 1: Combined Hybrid on Top 8 (Baseline high WR)
  // Test Option 2: Combined Hybrid (3+ spikes + 1H Chop Filter) expanded to All 20 pairs
  // Test Option 3: Dynamic Adaptive Spikes (3 spikes OR 2 large spikes >= 2x ATR + 1H Chop Filter) on Top 8
  // Test Option 4: Dynamic Adaptive Spikes on All 20 pairs

  function runHybrid(symbolsList, allow2LargeSpikes = false) {
    let allTrades = [];
    for (const sym of symbolsList) {
      if (!symbolsData[sym]) continue;
      const { ltf, htf, meta } = symbolsData[sym];
      const pairMode = meta.mode;
      const htfCloses = htf.map(c => c.close);
      const htfEMA = calculateEMA(htfCloses, 50);

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
            activeTrade.closedTime = new Date(c0.time).toISOString();
            activeTrade.outcome = hitTP ? 'WIN' : 'LOSS';
            activeTrade.pnlR = hitTP ? rewardRatio : -1.0;
            allTrades.push(activeTrade);
            activeTrade = null;
          }
        }

        if (c0.time < augustStartTime) continue;
        if (activeTrade) continue;

        let htfIdx = -1;
        for (let h = 0; h < htf.length; h++) {
          if (htf[h].time <= c0.time) htfIdx = h;
          else break;
        }
        if (htfIdx < 50) continue;

        const currentHtfClose = htf[htfIdx].close;
        const currentHtfEma = htfEMA[htfIdx];
        const htfTrend = currentHtfClose > currentHtfEma ? 'bullish' : 'bearish';

        if (pairMode === 'BOOM' && htfTrend !== 'bearish') continue;
        if (pairMode === 'CRASH' && htfTrend !== 'bullish') continue;

        // 1H Chop filter
        const emaDistPct = Math.abs(currentHtfClose - currentHtfEma) / currentHtfEma;
        if (emaDistPct < 0.0008) continue;

        const sliceLtf = ltf.slice(0, i + 1);
        const atr = calculateATR(sliceLtf, 14);
        if (!atr || atr === 0) continue;

        const c0Range = c0.high - c0.low;
        const c0Body = Math.abs(c0.close - c0.open);

        if (pairMode === 'BOOM') {
          const c1Spike = c1.close > c1.open;
          const c2Spike = c2.close > c2.open;
          const c0Exhaustion = c0.close < c0.open && c0Range > 0 && (c0Body / c0Range) >= 0.50;

          if (!c1Spike || !c2Spike || !c0Exhaustion) continue;

          const c3 = ltf[i - 3];
          const has3Spikes = c3 && c3.close > c3.open;

          const spikePeak = Math.max(c0.high, c1.high, c2.high);
          const spikeHeight = spikePeak - Math.min(c1.low, c2.low);
          const isLarge2Spike = allow2LargeSpikes && spikeHeight >= (atr * 2.0);

          if (!has3Spikes && !isLarge2Spike) continue;

          const entry = c0.close;
          const sl = spikePeak + (atr * 1.5);
          const slDist = Math.abs(entry - sl);
          const tp = entry - (slDist * rewardRatio);
          activeTrade = { symbol: sym, direction: 'SELL', signalTime: new Date(c0.time).toISOString(), entry, sl, tp, slDist };
        } else {
          const c1Crash = c1.close < c1.open;
          const c2Crash = c2.close < c2.open;
          const c0Exhaustion = c0.close > c0.open && c0Range > 0 && (c0Body / c0Range) >= 0.50;

          if (!c1Crash || !c2Crash || !c0Exhaustion) continue;

          const c3 = ltf[i - 3];
          const has3Spikes = c3 && c3.close < c3.open;

          const crashTrough = Math.min(c0.low, c1.low, c2.low);
          const crashDepth = Math.max(c1.high, c2.high) - crashTrough;
          const isLarge2Spike = allow2LargeSpikes && crashDepth >= (atr * 2.0);

          if (!has3Spikes && !isLarge2Spike) continue;

          const entry = c0.close;
          const sl = crashTrough - (atr * 1.5);
          const slDist = Math.abs(entry - sl);
          const tp = entry + (slDist * rewardRatio);
          activeTrade = { symbol: sym, direction: 'BUY', signalTime: new Date(c0.time).toISOString(), entry, sl, tp, slDist };
        }
      }
    }
    return allTrades;
  }

  const top8List = ["BOOM200", "BOOM500", "BOOM300N", "BOOM1000", "CRASH500", "CRASH600", "CRASH200", "CRASH1000"];
  const all20List = Object.keys(ALL_20_SYMBOLS);

  const t1 = runHybrid(top8List, false);
  const t2 = runHybrid(all20List, false);
  const t3 = runHybrid(top8List, true);
  const t4 = runHybrid(all20List, true);

  const setups = [
    { title: "Option 1: Combined Hybrid on Top 8 Pairs", trades: t1 },
    { title: "Option 2: Combined Hybrid on All 20 Pairs (High Win Rate + 2x Trade Volume)", trades: t2 },
    { title: "Option 3: Adaptive Hybrid (3 Spikes OR 2 Mega-Spikes) on Top 8 Pairs", trades: t3 },
    { title: "Option 4: Adaptive Hybrid on All 20 Pairs (Maximum Winning Volume)", trades: t4 }
  ];

  console.log("\n==========================================================================================");
  console.log("🚀 EXPANDING HIGH-WIN-RATE HYBRID STRATEGY: $100 ACCOUNT (AUG 13 - AUG 15)");
  console.log("==========================================================================================\n");

  setups.forEach(s => {
    const w = s.trades.filter(t => t.outcome === 'WIN').length;
    const l = s.trades.filter(t => t.outcome === 'LOSS').length;
    const tot = w + l;
    const wr = tot > 0 ? (w / tot * 100).toFixed(1) : "0.0";
    const simFix = simulateAccount(s.trades, 100.0, 0.03, false);
    const simComp = simulateAccount(s.trades, 100.0, 0.03, true);

    console.log(`📌 ${s.title.toUpperCase()}`);
    console.log(`   • Trades:            ${tot} (${w} Wins / ${l} Losses)`);
    console.log(`   • Win Rate:          ${wr}%`);
    console.log(`   • Fixed $3 Risk:     +$${simFix.netProfit.toFixed(2)} Net Profit ➔ Final Balance: $${simFix.finalBalance.toFixed(2)} (+${simFix.returnPct.toFixed(1)}%)`);
    console.log(`   • Compounding 3%:    +$${simComp.netProfit.toFixed(2)} Net Profit ➔ Final Balance: $${simComp.finalBalance.toFixed(2)} (+${simComp.returnPct.toFixed(1)}%)`);
    console.log(`   • Max Drawdown:      -$${simFix.maxDrawdownUSD.toFixed(2)} (${simFix.maxDrawdownPct.toFixed(1)}%)`);
    console.log(`------------------------------------------------------------------------------------------`);
  });
}

main();
