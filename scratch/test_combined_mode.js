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

function loadCandles() {
  const symbolsData = {};
  for (const [sym, meta] of Object.entries(TOP_8_SYMBOLS)) {
    const cacheFile = path.join(__dirname, '..', 'cache', `${sym}_300_3000_test.json`);
    if (fs.existsSync(cacheFile)) {
      const ltf = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
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

function runStrategy(symbolsData, opts = {}, filterStartTime = 0) {
  const {
    rewardRatio = 1.4,
    atrMultiplier = 1.5,
    minBodyRatio = 0.50,
    minSpikes = 3,
    useHtfDistance = true
  } = opts;

  let allTrades = [];

  for (const [sym, data] of Object.entries(symbolsData)) {
    const { ltf, htf, meta } = data;
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

      if (c0.time < filterStartTime) continue;
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

      if (useHtfDistance) {
        const emaDistPct = Math.abs(currentHtfClose - currentHtfEma) / currentHtfEma;
        if (emaDistPct < 0.0008) continue; // Skip 50 EMA flat chop
      }

      const sliceLtf = ltf.slice(0, i + 1);
      const atr = calculateATR(sliceLtf, 14);
      if (!atr || atr === 0) continue;

      const c0Range = c0.high - c0.low;
      const c0Body = Math.abs(c0.close - c0.open);

      if (pairMode === 'BOOM') {
        const c1Spike = c1.close > c1.open;
        const c2Spike = c2.close > c2.open;
        const c0Exhaustion = c0.close < c0.open && c0Range > 0 && (c0Body / c0Range) >= minBodyRatio;

        if (!c1Spike || !c2Spike || !c0Exhaustion) continue;

        if (minSpikes === 3) {
          const c3 = ltf[i - 3];
          if (!c3 || !(c3.close > c3.open)) continue;
        }

        const spikePeak = Math.max(c0.high, c1.high, c2.high);
        const entry = c0.close;
        const sl = spikePeak + (atr * atrMultiplier);
        const slDist = Math.abs(entry - sl);
        const tp = entry - (slDist * rewardRatio);
        activeTrade = { symbol: sym, direction: 'SELL', signalTime: new Date(c0.time).toISOString(), entry, sl, tp, slDist };
      } else {
        const c1Crash = c1.close < c1.open;
        const c2Crash = c2.close < c2.open;
        const c0Exhaustion = c0.close > c0.open && c0Range > 0 && (c0Body / c0Range) >= minBodyRatio;

        if (!c1Crash || !c2Crash || !c0Exhaustion) continue;

        if (minSpikes === 3) {
          const c3 = ltf[i - 3];
          if (!c3 || !(c3.close < c3.open)) continue;
        }

        const crashTrough = Math.min(c0.low, c1.low, c2.low);
        const entry = c0.close;
        const sl = crashTrough - (atr * atrMultiplier);
        const slDist = Math.abs(entry - sl);
        const tp = entry + (slDist * rewardRatio);
        activeTrade = { symbol: sym, direction: 'BUY', signalTime: new Date(c0.time).toISOString(), entry, sl, tp, slDist };
      }
    }
  }

  return allTrades;
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

function main() {
  const symbolsData = loadCandles();
  const augustStartTime = new Date("2026-08-13T00:00:00Z").getTime();

  console.log("==========================================================================================");
  console.log("🔬 TESTING COMBINED STRATEGY: (1H Trend Clearance) + (3+ Consecutive Spikes)");
  console.log("==========================================================================================\n");

  const testConfigs = [
    {
      name: "1. Current Baseline (2 Spikes | No Chop Filter | 1:1.3 RR)",
      opts: { minSpikes: 2, useHtfDistance: false, rewardRatio: 1.3 }
    },
    {
      name: "2. Combined Hybrid (3+ Spikes + 1H Chop Filter | 1:1.3 RR)",
      opts: { minSpikes: 3, useHtfDistance: true, rewardRatio: 1.3 }
    },
    {
      name: "3. Combined Hybrid (3+ Spikes + 1H Chop Filter | 1:1.4 RR)",
      opts: { minSpikes: 3, useHtfDistance: true, rewardRatio: 1.4 }
    },
    {
      name: "4. Combined Hybrid (3+ Spikes + 1H Chop Filter | 1:1.5 RR)",
      opts: { minSpikes: 3, useHtfDistance: true, rewardRatio: 1.5 }
    }
  ];

  testConfigs.forEach(conf => {
    const trades = runStrategy(symbolsData, conf.opts, augustStartTime);
    const wins = trades.filter(t => t.outcome === 'WIN').length;
    const losses = trades.filter(t => t.outcome === 'LOSS').length;
    const total = wins + losses;
    const winRate = total > 0 ? (wins / total * 100).toFixed(1) : "0.0";

    const simFixed = simulateAccount(trades, 100.0, 0.03, false);
    const simCompound = simulateAccount(trades, 100.0, 0.03, true);

    console.log(`------------------------------------------------------------------------------------------`);
    console.log(`📌 ${conf.name.toUpperCase()}`);
    console.log(`   • Total Closed Trades: ${total} (${wins} Wins / ${losses} Losses)`);
    console.log(`   • Win Rate:            ${winRate}%`);
    console.log(`   • Fixed $3 Risk:       +$${simFixed.netProfit.toFixed(2)} Net Profit ➔ Final Balance: $${simFixed.finalBalance.toFixed(2)} (+${simFixed.returnPct.toFixed(1)}%)`);
    console.log(`   • Max Drawdown:        -$${simFixed.maxDrawdownUSD.toFixed(2)} (${simFixed.maxDrawdownPct.toFixed(1)}%)`);
    console.log(`   • Dynamic Compounding: +$${simCompound.netProfit.toFixed(2)} Net Profit ➔ Final Balance: $${simCompound.finalBalance.toFixed(2)} (+${simCompound.returnPct.toFixed(1)}%)`);

    // Day by day
    const days = ['2026-08-13', '2026-08-14', '2026-08-15'];
    console.log(`   📅 Daily Balance Progression (Fixed $3 Risk):`);
    let runningBal = 100.0;
    days.forEach(d => {
      const dTrades = simFixed.tradeLogs.filter(t => t.closedTime && t.closedTime.startsWith(d));
      const dWins = dTrades.filter(t => t.outcome === 'WIN').length;
      const dLoss = dTrades.filter(t => t.outcome === 'LOSS').length;
      const dPnL = dTrades.reduce((s, t) => s + t.pnlUSD, 0);
      runningBal += dPnL;
      console.log(`      • ${d}: ${dTrades.length} trades (${dWins}W / ${dLoss}L) | Net PnL: ${dPnL >= 0 ? '+' : ''}$${dPnL.toFixed(2)} ➔ Balance: $${runningBal.toFixed(2)}`);
    });
    console.log();
  });
}

main();
