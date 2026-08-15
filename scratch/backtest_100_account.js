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

function fetchCandlesWS(symbol, granularity, count = 3000) {
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
          else reject(new Error(`Timeout fetching ${symbol} ${granularity}`));
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

function evaluateTrades(ltfCandles, htfCandles, mode, rewardRatio, filterStartTime = 0) {
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

function simulateAccount(trades, initialBalance = 100.0, riskPct = 0.03, isCompound = false) {
  let balance = initialBalance;
  let peakBalance = initialBalance;
  let maxDrawdownUSD = 0;
  let maxDrawdownPct = 0;

  const tradeLogs = [];

  // Sort trades strictly by closed time
  const sorted = [...trades].sort((a, b) => new Date(a.closedTime).getTime() - new Date(b.closedTime).getTime());

  sorted.forEach(t => {
    const riskUSD = isCompound ? (balance * riskPct) : (initialBalance * riskPct);
    const pnlUSD = t.pnlR * riskUSD;
    balance += pnlUSD;

    if (balance > peakBalance) {
      peakBalance = balance;
    }
    const ddUSD = peakBalance - balance;
    const ddPct = peakBalance > 0 ? (ddUSD / peakBalance) * 100 : 0;
    if (ddUSD > maxDrawdownUSD) maxDrawdownUSD = ddUSD;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

    tradeLogs.push({
      ...t,
      riskUSD,
      pnlUSD,
      balance
    });
  });

  const netProfit = balance - initialBalance;
  const returnPct = (netProfit / initialBalance) * 100;

  return {
    initialBalance,
    finalBalance: balance,
    netProfit,
    returnPct,
    maxDrawdownUSD,
    maxDrawdownPct,
    tradeLogs
  };
}

async function main() {
  console.log("Fetching candle data for $100 Account Backtest...");
  const symbolsData = {};
  for (const [sym, meta] of Object.entries(TOP_8_SYMBOLS)) {
    try {
      const ltf = await fetchCandlesWS(sym, 300, 3000);
      const htf = await fetchCandlesWS(sym, 3600, 300);
      symbolsData[sym] = { ltf, htf, meta };
    } catch (e) {
      console.error(`Failed ${sym}:`, e.message);
    }
  }

  const ratios = [1.3, 1.4, 1.5];
  const augustStartTime = new Date("2026-08-13T00:00:00Z").getTime();

  console.log("\n=========================================================================================");
  console.log("💵 $100 STARTING ACCOUNT BACKTEST: 3-DAY REAL DATA (AUG 13 - AUG 15)");
  console.log("=========================================================================================");

  for (const rr of ratios) {
    let allTrades = [];
    for (const [sym, data] of Object.entries(symbolsData)) {
      const trades = evaluateTrades(data.ltf, data.htf, data.meta.mode, rr, augustStartTime);
      trades.forEach(t => t.symbol = sym);
      allTrades = allTrades.concat(trades);
    }

    const wins = allTrades.filter(t => t.outcome === 'WIN').length;
    const losses = allTrades.filter(t => t.outcome === 'LOSS').length;

    // Fixed 3% Risk ($3.00/trade)
    const simFixed = simulateAccount(allTrades, 100.0, 0.03, false);
    // Compounding 3% Risk
    const simCompound = simulateAccount(allTrades, 100.0, 0.03, true);

    console.log(`\n🔹 [1:${rr} R:R] (Trades: ${allTrades.length} | ${wins}W / ${losses}L | Win Rate: ${(wins/allTrades.length*100).toFixed(1)}%)`);
    console.log(`  -----------------------------------------------------------------------------------`);
    console.log(`  Model A (Fixed $3.00 Risk / 3%):`);
    console.log(`    • Starting Balance:    $100.00`);
    console.log(`    • Net Profit:          +$${simFixed.netProfit.toFixed(2)} (${simFixed.returnPct >= 0 ? '+' : ''}${simFixed.returnPct.toFixed(1)}%)`);
    console.log(`    • Final Balance:       $${simFixed.finalBalance.toFixed(2)}`);
    console.log(`    • Max Drawdown:        -$${simFixed.maxDrawdownUSD.toFixed(2)} (${simFixed.maxDrawdownPct.toFixed(1)}%)`);
    console.log(`  Model B (Compounding 3% Risk per trade):`);
    console.log(`    • Starting Balance:    $100.00`);
    console.log(`    • Net Profit:          +$${simCompound.netProfit.toFixed(2)} (${simCompound.returnPct >= 0 ? '+' : ''}${simCompound.returnPct.toFixed(1)}%)`);
    console.log(`    • Final Balance:       $${simCompound.finalBalance.toFixed(2)}`);
    console.log(`    • Max Drawdown:        -$${simCompound.maxDrawdownUSD.toFixed(2)} (${simCompound.maxDrawdownPct.toFixed(1)}%)`);

    // Day by day
    const days = ['2026-08-13', '2026-08-14', '2026-08-15'];
    console.log(`  📅 Daily Balance Progression (Fixed $3 Risk):`);
    let cumBal = 100.0;
    days.forEach(d => {
      const dTrades = simFixed.tradeLogs.filter(t => t.closedTime && t.closedTime.startsWith(d));
      const dWins = dTrades.filter(t => t.outcome === 'WIN').length;
      const dLoss = dTrades.filter(t => t.outcome === 'LOSS').length;
      const dPnL = dTrades.reduce((sum, t) => sum + t.pnlUSD, 0);
      cumBal += dPnL;
      console.log(`     • ${d}: ${dTrades.length} trades (${dWins}W/${dLoss}L) | Day PnL: ${dPnL >= 0 ? '+' : ''}$${dPnL.toFixed(2)} ➔ End of Day Balance: $${cumBal.toFixed(2)}`);
    });
  }

  console.log("\n=========================================================================================");
  console.log("💵 $100 STARTING ACCOUNT BACKTEST: EXTENDED ~10.5 DAYS (~500 TRADES)");
  console.log("=========================================================================================");

  for (const rr of ratios) {
    let allTrades = [];
    for (const [sym, data] of Object.entries(symbolsData)) {
      const trades = evaluateTrades(data.ltf, data.htf, data.meta.mode, rr, 0);
      trades.forEach(t => t.symbol = sym);
      allTrades = allTrades.concat(trades);
    }

    const wins = allTrades.filter(t => t.outcome === 'WIN').length;
    const losses = allTrades.filter(t => t.outcome === 'LOSS').length;

    const simFixed = simulateAccount(allTrades, 100.0, 0.03, false);
    const simCompound = simulateAccount(allTrades, 100.0, 0.03, true);

    console.log(`\n🔹 [1:${rr} R:R] (Total Trades: ${allTrades.length} | ${wins}W / ${losses}L | Win Rate: ${(wins/allTrades.length*100).toFixed(1)}%)`);
    console.log(`  -----------------------------------------------------------------------------------`);
    console.log(`  Model A (Fixed $3.00 Risk):`);
    console.log(`    • Net Profit:    +$${simFixed.netProfit.toFixed(2)} (+${simFixed.returnPct.toFixed(1)}%)`);
    console.log(`    • Final Balance: $${simFixed.finalBalance.toFixed(2)}`);
    console.log(`    • Max Drawdown:  -$${simFixed.maxDrawdownUSD.toFixed(2)} (${simFixed.maxDrawdownPct.toFixed(1)}%)`);
    console.log(`  Model B (Compounding 3% Risk per trade):`);
    console.log(`    • Net Profit:    +$${simCompound.netProfit.toFixed(2)} (+${simCompound.returnPct.toFixed(1)}%)`);
    console.log(`    • Final Balance: $${simCompound.finalBalance.toFixed(2)}`);
    console.log(`    • Max Drawdown:  -$${simCompound.maxDrawdownUSD.toFixed(2)} (${simCompound.maxDrawdownPct.toFixed(1)}%)`);
  }
}

main();
