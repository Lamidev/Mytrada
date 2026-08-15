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

function fetchCandlesWS(symbol, granularity, count = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(config.DERIV_WS_URL);
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        ws.terminate();
        reject(new Error(`Timeout fetching ${symbol} ${granularity}`));
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

function evaluateTrades(ltfCandles, htfCandles, mode, rewardRatio, riskUSD = 100.0, filterStartTime = 0) {
  const htfCloses = htfCandles.map(c => c.close);
  const htfEMA = calculateEMA(htfCloses, 50);

  let activeTrade = null;
  const closedTrades = [];

  for (let i = 20; i < ltfCandles.length; i++) {
    const c0 = ltfCandles[i];
    const c1 = ltfCandles[i - 1];
    const c2 = ltfCandles[i - 2];

    if (activeTrade) {
      let hitTP = false;
      let hitSL = false;

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
        activeTrade.pnlUSD = hitTP ? (riskUSD * rewardRatio) : -riskUSD;
        closedTrades.push(activeTrade);
        activeTrade = null;
      }
    }

    if (c0.time < filterStartTime) continue;
    if (activeTrade) continue;

    let htfIdx = -1;
    for (let h = 0; h < htfCandles.length; h++) {
      if (htfCandles[h].time <= c0.time) htfIdx = h;
      else break;
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
        activeTrade = {
          direction: 'SELL',
          signalTime: new Date(c0.time).toISOString(),
          entryPrice: entry,
          sl,
          tp,
          slDist
        };
      }
    } else {
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
        activeTrade = {
          direction: 'BUY',
          signalTime: new Date(c0.time).toISOString(),
          entryPrice: entry,
          sl,
          tp,
          slDist
        };
      }
    }
  }

  return closedTrades;
}

async function main() {
  console.log("Fetching candle data for Top 8 Portfolio...");
  const symbolsData = {};
  for (const [sym, meta] of Object.entries(TOP_8_SYMBOLS)) {
    try {
      const ltf = await fetchCandlesWS(sym, 300, 3000); // 3000 5m bars (~10.5 days)
      const htf = await fetchCandlesWS(sym, 3600, 300); // 300 1h bars
      symbolsData[sym] = { ltf, htf, meta };
      console.log(`Fetched ${sym}: ${ltf.length} 5M candles, ${htf.length} 1H candles`);
    } catch (e) {
      console.error(`Failed ${sym}:`, e.message);
    }
  }

  const ratios = [1.3, 1.4, 1.5];
  const augustStartTime = new Date("2026-08-13T00:00:00Z").getTime();

  console.log("\n==========================================================================");
  console.log("📊 SECTION 1: RECENT 3-DAY PERFORMANCE (AUG 13 - AUG 15)");
  console.log("==========================================================================");

  const results3Day = {};

  for (const rr of ratios) {
    let allTrades = [];
    for (const [sym, data] of Object.entries(symbolsData)) {
      const trades = evaluateTrades(data.ltf, data.htf, data.meta.mode, rr, 100.0, augustStartTime);
      trades.forEach(t => t.symbol = sym);
      allTrades = allTrades.concat(trades);
    }

    const wins = allTrades.filter(t => t.outcome === 'WIN').length;
    const losses = allTrades.filter(t => t.outcome === 'LOSS').length;
    const total = wins + losses;
    const winRate = total > 0 ? (wins / total * 100).toFixed(2) : 0;
    const totalGrossProfit = wins * (100.0 * rr);
    const totalGrossLoss = losses * 100.0;
    const netUSD = totalGrossProfit - totalGrossLoss;
    const netR = (netUSD / 100.0).toFixed(2);
    const profitFactor = totalGrossLoss > 0 ? (totalGrossProfit / totalGrossLoss).toFixed(2) : 'N/A';

    results3Day[rr] = { total, wins, losses, winRate, totalGrossProfit, totalGrossLoss, netUSD, netR, profitFactor };
  }

  console.table(results3Day);

  // Group by day for each RR
  const days = ['2026-08-13', '2026-08-14', '2026-08-15'];
  for (const rr of ratios) {
    console.log(`\n📅 Daily Breakdown for 1:${rr} R:R:`);
    let allTrades = [];
    for (const [sym, data] of Object.entries(symbolsData)) {
      const trades = evaluateTrades(data.ltf, data.htf, data.meta.mode, rr, 100.0, augustStartTime);
      trades.forEach(t => t.symbol = sym);
      allTrades = allTrades.concat(trades);
    }

    days.forEach(day => {
      const dayTrades = allTrades.filter(t => t.closedTime && t.closedTime.startsWith(day));
      const w = dayTrades.filter(t => t.outcome === 'WIN').length;
      const l = dayTrades.filter(t => t.outcome === 'LOSS').length;
      const tot = w + l;
      const wr = tot > 0 ? (w / tot * 100).toFixed(1) : '0';
      const profit = (w * 100 * rr) - (l * 100);
      console.log(`  ${day}: ${tot} trades | ${w}W / ${l}L (${wr}% WR) | Net PnL: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} (${(profit/100).toFixed(1)}R)`);
    });
  }

  console.log("\n==========================================================================");
  console.log("📊 SECTION 2: EXTENDED MULTI-DAY BACKTEST (ALL AVAILABLE DATA ~10.5 DAYS)");
  console.log("==========================================================================");

  const resultsExtended = {};
  for (const rr of ratios) {
    let allTrades = [];
    for (const [sym, data] of Object.entries(symbolsData)) {
      const trades = evaluateTrades(data.ltf, data.htf, data.meta.mode, rr, 100.0, 0);
      trades.forEach(t => t.symbol = sym);
      allTrades = allTrades.concat(trades);
    }

    const wins = allTrades.filter(t => t.outcome === 'WIN').length;
    const losses = allTrades.filter(t => t.outcome === 'LOSS').length;
    const total = wins + losses;
    const winRate = total > 0 ? (wins / total * 100).toFixed(2) : 0;
    const totalGrossProfit = wins * (100.0 * rr);
    const totalGrossLoss = losses * 100.0;
    const netUSD = totalGrossProfit - totalGrossLoss;
    const netR = (netUSD / 100.0).toFixed(2);
    const profitFactor = totalGrossLoss > 0 ? (totalGrossProfit / totalGrossLoss).toFixed(2) : 'N/A';

    resultsExtended[rr] = { total, wins, losses, winRate, totalGrossProfit, totalGrossLoss, netUSD, netR, profitFactor };
  }

  console.table(resultsExtended);
}

main();
