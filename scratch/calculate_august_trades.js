const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const config = require('../config');

// List of symbols to evaluate (Top 8 and also check all pairs)
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

const ALL_BOOM_CRASH_SYMBOLS = {
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

function fetchCandlesWS(symbol, granularity, count = 2000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(config.DERIV_WS_URL);
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        ws.terminate();
        reject(new Error(`Timeout fetching ${symbol} ${granularity}`));
      }
    }, 15000);

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
          reject(new Error(data.error.message));
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
          resolve(candles);
        }
      } catch (err) {
        done = true;
        clearTimeout(timer);
        ws.close();
        reject(err);
      }
    });

    ws.on('error', (err) => {
      done = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function calculateEMA(prices, period) {
  const ema = [];
  if (prices.length === 0) return ema;
  let sum = 0;
  for (let i = 0; i < Math.min(period, prices.length); i++) {
    sum += prices[i];
  }
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

async function runAnalysis(symbolsDict, filterStartTimeStr = "2026-08-13T00:00:00Z") {
  const filterStartTime = new Date(filterStartTimeStr).getTime();
  const allTrades = [];

  for (const [symbol, meta] of Object.entries(symbolsDict)) {
    try {
      // 5M candles (300s) and 1H candles (3600s)
      // Count 1500 5m candles = ~5.2 days of data
      const ltfCandles = await fetchCandlesWS(symbol, 300, 1500);
      const htfCandles = await fetchCandlesWS(symbol, 3600, 200);

      const mode = meta.mode;
      const rewardRatio = 1.3;
      const riskUSD = 100.0;

      // Precalculate 1H EMAs
      const htfCloses = htfCandles.map(c => c.close);
      const htfEMA = calculateEMA(htfCloses, 50);

      // Track active trade to enforce max 1 concurrent trade per symbol
      let activeTrade = null;

      for (let i = 20; i < ltfCandles.length; i++) {
        const c0 = ltfCandles[i];
        const c1 = ltfCandles[i - 1];
        const c2 = ltfCandles[i - 2];

        // Check if an active trade is hit
        if (activeTrade) {
          let hitTP = false;
          let hitSL = false;

          if (activeTrade.direction === 'SELL') { // BOOM
            if (c0.high >= activeTrade.sl) {
              hitSL = true;
            } else if (c0.low <= activeTrade.tp) {
              hitTP = true;
            }
          } else { // CRASH (BUY)
            if (c0.low <= activeTrade.sl) {
              hitSL = true;
            } else if (c0.high >= activeTrade.tp) {
              hitTP = true;
            }
          }

          if (hitTP || hitSL) {
            activeTrade.closedTime = new Date(c0.time).toISOString();
            activeTrade.outcome = hitTP ? 'WIN' : 'LOSS';
            activeTrade.exitPrice = hitTP ? activeTrade.tp : activeTrade.sl;
            activeTrade.pnlR = hitTP ? rewardRatio : -1.0;
            activeTrade.pnlUSD = hitTP ? (riskUSD * rewardRatio) : -riskUSD;
            activeTrade = null;
          }
        }

        // Only evaluate setups from filterStartTime onwards
        if (c0.time < filterStartTime) continue;

        // Skip if symbol currently has active trade
        if (activeTrade) continue;

        // Find 1H trend at c0.time
        let htfIdx = -1;
        for (let h = 0; h < htfCandles.length; h++) {
          if (htfCandles[h].time <= c0.time) {
            htfIdx = h;
          } else {
            break;
          }
        }
        if (htfIdx < 50) continue;

        const currentHtfClose = htfCandles[htfIdx].close;
        const currentHtfEma = htfEMA[htfIdx];
        const htfTrend = currentHtfClose > currentHtfEma ? 'bullish' : 'bearish';

        if (mode === 'BOOM' && htfTrend !== 'bearish') continue;
        if (mode === 'CRASH' && htfTrend !== 'bullish') continue;

        const sliceLtf = ltfCandles.slice(0, i + 1);
        const atr = calculateATR(sliceLtf, 14);
        if (!atr || atr === 0) continue;

        let setup = null;

        if (mode === 'BOOM') {
          const c1Spike = c1.close > c1.open;
          const c2Spike = c2.close > c2.open;
          const c0Range = c0.high - c0.low;
          const c0Body = Math.abs(c0.close - c0.open);
          const c0Exhaustion = c0.close < c0.open && c0Range > 0 && (c0Body / c0Range) >= 0.5;

          if (c1Spike && c2Spike && c0Exhaustion) {
            const spikePeak = Math.max(c0.high, c1.high, c2.high);
            const entry = c0.close;
            const sl = spikePeak + (atr * 1.5);
            const slDist = Math.abs(entry - sl);
            const tp = entry - (slDist * rewardRatio);
            setup = {
              symbol,
              symbolName: meta.name,
              mode,
              direction: 'SELL',
              signalTime: new Date(c0.time).toISOString(),
              entryPrice: entry,
              sl,
              tp,
              slDist,
              atr,
              spikeRef: spikePeak
            };
          }
        } else {
          // CRASH
          const c1Crash = c1.close < c1.open;
          const c2Crash = c2.close < c2.open;
          const c0Range = c0.high - c0.low;
          const c0Body = Math.abs(c0.close - c0.open);
          const c0Exhaustion = c0.close > c0.open && c0Range > 0 && (c0Body / c0Range) >= 0.5;

          if (c1Crash && c2Crash && c0Exhaustion) {
            const crashTrough = Math.min(c0.low, c1.low, c2.low);
            const entry = c0.close;
            const sl = crashTrough - (atr * 1.5);
            const slDist = Math.abs(entry - sl);
            const tp = entry + (slDist * rewardRatio);
            setup = {
              symbol,
              symbolName: meta.name,
              mode,
              direction: 'BUY',
              signalTime: new Date(c0.time).toISOString(),
              entryPrice: entry,
              sl,
              tp,
              slDist,
              atr,
              spikeRef: crashTrough
            };
          }
        }

        if (setup) {
          const tradeRecord = {
            ...setup,
            status: 'CLOSED', // will be updated if still open
            outcome: null,
            closedTime: null,
            exitPrice: null,
            pnlR: 0,
            pnlUSD: 0
          };
          activeTrade = tradeRecord;
          allTrades.push(tradeRecord);
        }
      }

      if (activeTrade) {
        activeTrade.status = 'OPEN';
        activeTrade.outcome = 'OPEN';
      }

    } catch (e) {
      console.error(`Error processing ${symbol}:`, e.message);
    }
  }

  return allTrades;
}

async function main() {
  console.log("=== Fetching & Calculating Real Data for Top 8 Portfolio ===");
  const top8Trades = await runAnalysis(TOP_8_SYMBOLS, "2026-08-13T00:00:00Z");
  fs.writeFileSync(path.join(__dirname, 'top8_august_trades.json'), JSON.stringify(top8Trades, null, 2));

  console.log("=== Fetching & Calculating Real Data for All 20 Boom & Crash Pairs ===");
  const allTrades = await runAnalysis(ALL_BOOM_CRASH_SYMBOLS, "2026-08-13T00:00:00Z");
  fs.writeFileSync(path.join(__dirname, 'all20_august_trades.json'), JSON.stringify(allTrades, null, 2));

  console.log(`Done! Top 8 generated ${top8Trades.length} trades, All 20 generated ${allTrades.length} trades.`);
}

main();
