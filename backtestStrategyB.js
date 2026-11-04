// backtestStrategyB.js
/**
 * 👑 MYTRADA QUANTITATIVE RESEARCH — COMPREHENSIVE STRATEGY B PATTERN SUITE
 * 
 * Testing 3 Structural / Non-Spike Models across 1 Full Month (103,680 M5 bars across 12 pairs):
 *  1. Model 1: 15M Institutional BOS + 15M FVG Retest (Macro SMC)
 *  2. Model 2: 5M Structural BOS + 5M FVG Retest (Micro SMC - Faster Execution)
 *  3. Model 3: 15M Liquidity Sweep + 5M Structural Rejection (Turtle Soup Liquidity Raid)
 */

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, 'cache');

const SYMBOLS = [
  'BOOM500', 'BOOM300N', 'BOOM900', 'BOOM600', 'BOOM1000', 'BOOM150N',
  'CRASH300N', 'CRASH500', 'CRASH600', 'CRASH900', 'CRASH1000', 'CRASH150N'
];

function calculateEMA(closes, period) {
  if (!closes || closes.length < period) return [];
  const k = 2 / (period + 1);
  const ema = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    ema.push(closes[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function aggregateTo15M(m5Candles) {
  const m15 = [];
  for (let i = 0; i < m5Candles.length; i += 3) {
    const chunk = m5Candles.slice(i, i + 3);
    if (chunk.length < 3) break;
    m15.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk[2].close
    });
  }
  return m15;
}

function precalculateATR(candles, period = 14) {
  const atrs = new Array(candles.length).fill(1.0);
  for (let i = period; i < candles.length; i++) {
    let trSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const high = candles[j].high;
      const low = candles[j].low;
      const prevClose = candles[j - 1].close;
      trSum += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    }
    atrs[i] = trSum / period;
  }
  return atrs;
}

function findFractals(candles, currentIndex, lookback = 20) {
  const swingHighs = [];
  const swingLows = [];
  const start = Math.max(2, currentIndex - lookback);

  for (let i = start; i <= currentIndex - 2; i++) {
    const prev2 = candles[i - 2], prev1 = candles[i - 1];
    const curr = candles[i];
    const next1 = candles[i + 1], next2 = candles[i + 2];

    if (curr.high > prev1.high && curr.high > prev2.high && curr.high > next1.high && curr.high > next2.high) {
      swingHighs.push({ index: i, time: curr.time, price: curr.high });
    }
    if (curr.low < prev1.low && curr.low < prev2.low && curr.low < next1.low && curr.low < next2.low) {
      swingLows.push({ index: i, time: curr.time, price: curr.low });
    }
  }
  return { swingHighs, swingLows };
}

// Universal Pattern Simulator
function runPatternSimulation(symbol, m5Candles, h1Candles, modelType = '15M_BOS_FVG', targetRR = 1.3) {
  const isBoom = symbol.startsWith('BOOM');
  const mode = isBoom ? 'BOOM' : 'CRASH';

  const trades = [];
  let inTrade = false;
  let currentTrade = null;
  let dailyLossCount = {};
  let lastExitBar = -1;

  const h1Closes = h1Candles.map(c => c.close);
  const h1Ema50 = calculateEMA(h1Closes, 50);

  const m15Candles = aggregateTo15M(m5Candles);
  const m5ATRs = precalculateATR(m5Candles, 14);

  let currentH1Idx = 0;

  for (let i = 180; i < m5Candles.length; i++) {
    const currentM5 = m5Candles[i];
    const dayKey = new Date(currentM5.time).toISOString().slice(0, 10);
    if (!dailyLossCount[dayKey]) dailyLossCount[dayKey] = 0;

    // Evaluate open position
    if (inTrade) {
      const high = currentM5.high;
      const low = currentM5.low;

      if (currentTrade.direction === 'BUY') {
        if (low <= currentTrade.stopLoss) {
          trades.push({
            ...currentTrade,
            exitTime: currentM5.time,
            exitPrice: currentTrade.stopLoss,
            outcome: 'LOSS',
            pnlR: -1.0,
            pnlUSD: -229.20
          });
          dailyLossCount[dayKey]++;
          inTrade = false;
          currentTrade = null;
          lastExitBar = i;
          continue;
        } else if (high >= currentTrade.takeProfit) {
          trades.push({
            ...currentTrade,
            exitTime: currentM5.time,
            exitPrice: currentTrade.takeProfit,
            outcome: 'WIN',
            pnlR: targetRR,
            pnlUSD: 229.20 * targetRR
          });
          inTrade = false;
          currentTrade = null;
          lastExitBar = i;
          continue;
        }
      } else { // SELL
        if (high >= currentTrade.stopLoss) {
          trades.push({
            ...currentTrade,
            exitTime: currentM5.time,
            exitPrice: currentTrade.stopLoss,
            outcome: 'LOSS',
            pnlR: -1.0,
            pnlUSD: -229.20
          });
          dailyLossCount[dayKey]++;
          inTrade = false;
          currentTrade = null;
          lastExitBar = i;
          continue;
        } else if (low <= currentTrade.takeProfit) {
          trades.push({
            ...currentTrade,
            exitTime: currentM5.time,
            exitPrice: currentTrade.takeProfit,
            outcome: 'WIN',
            pnlR: targetRR,
            pnlUSD: 229.20 * targetRR
          });
          inTrade = false;
          currentTrade = null;
          lastExitBar = i;
          continue;
        }
      }

      // Max holding duration: 4 hours (48 bars)
      if (i - currentTrade.entryBar >= 48) {
        const exitPrice = currentM5.close;
        const isWin = currentTrade.direction === 'BUY' ? exitPrice > currentTrade.entryPrice : exitPrice < currentTrade.entryPrice;
        const pnlR = currentTrade.direction === 'BUY'
          ? (exitPrice - currentTrade.entryPrice) / (currentTrade.entryPrice - currentTrade.stopLoss)
          : (currentTrade.entryPrice - exitPrice) / (currentTrade.stopLoss - currentTrade.entryPrice);
        trades.push({
          ...currentTrade,
          exitTime: currentM5.time,
          exitPrice,
          outcome: isWin ? 'WIN' : 'LOSS',
          pnlR: Math.max(-1.0, Math.min(targetRR, pnlR)),
          pnlUSD: Math.max(-1.0, Math.min(targetRR, pnlR)) * 229.20
        });
        if (!isWin) dailyLossCount[dayKey]++;
        inTrade = false;
        currentTrade = null;
        lastExitBar = i;
        continue;
      }
      continue;
    }

    if (i - lastExitBar < 12) continue;
    if (dailyLossCount[dayKey] >= 2) continue;

    while (currentH1Idx < h1Candles.length - 1 && h1Candles[currentH1Idx + 1].time <= currentM5.time) {
      currentH1Idx++;
    }
    if (currentH1Idx < 50) continue;

    const h1Close = h1Candles[currentH1Idx].close;
    const h1Ema = h1Ema50[currentH1Idx];
    if (!h1Ema) continue;

    const h1Start = Math.max(0, currentH1Idx - 24);
    let dayHigh = -Infinity, dayLow = Infinity;
    for (let k = h1Start; k <= currentH1Idx; k++) {
      if (h1Candles[k].high > dayHigh) dayHigh = h1Candles[k].high;
      if (h1Candles[k].low < dayLow) dayLow = h1Candles[k].low;
    }
    const dayRange = dayHigh - dayLow;
    if (dayRange <= 0) continue;
    const rangePct = ((currentM5.close - dayLow) / dayRange) * 100;

    if (mode === 'CRASH') {
      if (h1Close < h1Ema) continue;
      if (rangePct > 80.0) continue;
    } else {
      if (h1Close > h1Ema) continue;
      if (rangePct < 20.0) continue;
    }

    const atr = m5ATRs[i];

    // ==========================================================
    // MODEL 1: 15M BOS + FVG Retest
    // ==========================================================
    if (modelType === '15M_BOS_FVG') {
      const m15Idx = Math.floor(i / 3);
      if (m15Idx < 25 || m15Idx >= m15Candles.length) continue;

      const { swingHighs, swingLows } = findFractals(m15Candles, m15Idx - 1, 25);
      const prev15M = m15Candles[m15Idx - 1];
      const prev2_15M = m15Candles[m15Idx - 2];
      const prev3_15M = m15Candles[m15Idx - 3];
      if (!prev15M || !prev2_15M || !prev3_15M) continue;

      if (mode === 'CRASH' && swingHighs.length > 0) {
        const recentSwingHigh = swingHighs[swingHighs.length - 1].price;
        const hasBOS = prev15M.close > recentSwingHigh && prev2_15M.close <= recentSwingHigh;
        const fvgGap = prev15M.low - prev3_15M.high;
        if (hasBOS && fvgGap > atr * 0.15) {
          const fvgTop = prev15M.low, fvgBottom = prev3_15M.high;
          if (currentM5.low <= fvgTop && currentM5.close >= fvgBottom) {
            const entryPrice = currentM5.close;
            const stopLoss = Math.min(fvgBottom - (atr * 0.5), entryPrice - (atr * 2.0));
            const slDist = entryPrice - stopLoss;
            if (slDist > 0 && slDist <= atr * 6.0) {
              inTrade = true;
              currentTrade = { symbol, direction: 'BUY', entryTime: currentM5.time, entryBar: i, entryPrice, stopLoss, takeProfit: entryPrice + (slDist * targetRR), dayKey };
            }
          }
        }
      } else if (mode === 'BOOM' && swingLows.length > 0) {
        const recentSwingLow = swingLows[swingLows.length - 1].price;
        const hasBOS = prev15M.close < recentSwingLow && prev2_15M.close >= recentSwingLow;
        const fvgGap = prev3_15M.low - prev15M.high;
        if (hasBOS && fvgGap > atr * 0.15) {
          const fvgTop = prev3_15M.low, fvgBottom = prev15M.high;
          if (currentM5.high >= fvgBottom && currentM5.close <= fvgTop) {
            const entryPrice = currentM5.close;
            const stopLoss = Math.max(fvgTop + (atr * 0.5), entryPrice + (atr * 2.0));
            const slDist = stopLoss - entryPrice;
            if (slDist > 0 && slDist <= atr * 6.0) {
              inTrade = true;
              currentTrade = { symbol, direction: 'SELL', entryTime: currentM5.time, entryBar: i, entryPrice, stopLoss, takeProfit: entryPrice - (slDist * targetRR), dayKey };
            }
          }
        }
      }
    }

    // ==========================================================
    // MODEL 2: 5M Structural BOS + 5M FVG Retest (Micro SMC)
    // ==========================================================
    if (modelType === '5M_BOS_FVG') {
      const { swingHighs, swingLows } = findFractals(m5Candles, i - 1, 20);
      const prevM5 = m5Candles[i - 1];
      const prev2M5 = m5Candles[i - 2];
      const prev3M5 = m5Candles[i - 3];

      if (mode === 'CRASH' && swingHighs.length > 0) {
        const recentSwingHigh = swingHighs[swingHighs.length - 1].price;
        const hasBOS = prevM5.close > recentSwingHigh && prev2M5.close <= recentSwingHigh;
        const fvgGap = prevM5.low - prev3M5.high;
        if (hasBOS && fvgGap > atr * 0.10) {
          const fvgTop = prevM5.low, fvgBottom = prev3M5.high;
          if (currentM5.low <= fvgTop && currentM5.close >= fvgBottom) {
            const entryPrice = currentM5.close;
            const stopLoss = Math.min(fvgBottom - (atr * 0.5), entryPrice - (atr * 1.8));
            const slDist = entryPrice - stopLoss;
            if (slDist > 0 && slDist <= atr * 5.0) {
              inTrade = true;
              currentTrade = { symbol, direction: 'BUY', entryTime: currentM5.time, entryBar: i, entryPrice, stopLoss, takeProfit: entryPrice + (slDist * targetRR), dayKey };
            }
          }
        }
      } else if (mode === 'BOOM' && swingLows.length > 0) {
        const recentSwingLow = swingLows[swingLows.length - 1].price;
        const hasBOS = prevM5.close < recentSwingLow && prev2M5.close >= recentSwingLow;
        const fvgGap = prev3M5.low - prevM5.high;
        if (hasBOS && fvgGap > atr * 0.10) {
          const fvgTop = prev3M5.low, fvgBottom = prevM5.high;
          if (currentM5.high >= fvgBottom && currentM5.close <= fvgTop) {
            const entryPrice = currentM5.close;
            const stopLoss = Math.max(fvgTop + (atr * 0.5), entryPrice + (atr * 1.8));
            const slDist = stopLoss - entryPrice;
            if (slDist > 0 && slDist <= atr * 5.0) {
              inTrade = true;
              currentTrade = { symbol, direction: 'SELL', entryTime: currentM5.time, entryBar: i, entryPrice, stopLoss, takeProfit: entryPrice - (slDist * targetRR), dayKey };
            }
          }
        }
      }
    }

    // ==========================================================
    // MODEL 3: 15M Liquidity Sweep + Rejection (Turtle Soup)
    // ==========================================================
    if (modelType === '15M_LIQUIDITY_SWEEP') {
      const m15Idx = Math.floor(i / 3);
      if (m15Idx < 25 || m15Idx >= m15Candles.length) continue;

      const { swingHighs, swingLows } = findFractals(m15Candles, m15Idx - 1, 30);
      const prev15M = m15Candles[m15Idx - 1];

      if (mode === 'CRASH' && swingLows.length > 0) {
        // Sweep of recent low: wicked below swing low, but closed back above it!
        const targetLow = swingLows[swingLows.length - 1].price;
        const sweptLow = prev15M.low < targetLow && prev15M.close > targetLow;
        if (sweptLow && currentM5.close > currentM5.open) { // Confirmed bullish M5
          const entryPrice = currentM5.close;
          const stopLoss = prev15M.low - (atr * 0.5);
          const slDist = entryPrice - stopLoss;
          if (slDist > 0 && slDist <= atr * 5.0) {
            inTrade = true;
            currentTrade = { symbol, direction: 'BUY', entryTime: currentM5.time, entryBar: i, entryPrice, stopLoss, takeProfit: entryPrice + (slDist * targetRR), dayKey };
          }
        }
      } else if (mode === 'BOOM' && swingHighs.length > 0) {
        // Sweep of recent high: wicked above swing high, but closed back below it!
        const targetHigh = swingHighs[swingHighs.length - 1].price;
        const sweptHigh = prev15M.high > targetHigh && prev15M.close < targetHigh;
        if (sweptHigh && currentM5.close < currentM5.open) { // Confirmed bearish M5
          const entryPrice = currentM5.close;
          const stopLoss = prev15M.high + (atr * 0.5);
          const slDist = stopLoss - entryPrice;
          if (slDist > 0 && slDist <= atr * 5.0) {
            inTrade = true;
            currentTrade = { symbol, direction: 'SELL', entryTime: currentM5.time, entryBar: i, entryPrice, stopLoss, takeProfit: entryPrice - (slDist * targetRR), dayKey };
          }
        }
      }
    }
  }

  return trades;
}

function simulatePortfolioDaily(allTrades) {
  const dayMap = {};
  for (const t of allTrades) {
    if (!dayMap[t.dayKey]) dayMap[t.dayKey] = [];
    dayMap[t.dayKey].push(t);
  }

  const dailyTargetUSD = 893.88;
  const dailyMaxLossUSD = -687.60;

  let targetHitDays = 0, maxLossDays = 0, normalDays = 0;
  let totalRealizedUSD = 0, totalWins = 0, totalLosses = 0;

  for (const [day, dayTrades] of Object.entries(dayMap).sort()) {
    dayTrades.sort((a, b) => a.entryTime - b.entryTime);
    let dayPnL = 0, dayWins = 0, dayLosses = 0, locked = false;

    for (const trade of dayTrades) {
      if (locked) break;
      dayPnL += trade.pnlUSD;
      if (trade.outcome === 'WIN') { dayWins++; totalWins++; }
      else { dayLosses++; totalLosses++; }

      if (dayPnL >= dailyTargetUSD) { targetHitDays++; locked = true; break; }
      if (dayPnL <= dailyMaxLossUSD) { maxLossDays++; locked = true; break; }
    }
    if (!locked) normalDays++;
    totalRealizedUSD += dayPnL;
  }

  const totalDays = Object.keys(dayMap).length || 30;
  return {
    totalDays,
    targetHitDays,
    maxLossDays,
    normalDays,
    totalRealizedUSD,
    totalWins,
    totalLosses,
    totalTrades: totalWins + totalLosses
  };
}

async function runFullComparison() {
  console.log('👑 =========================================================================');
  console.log('   MYTRADA QUANTITATIVE RESEARCH: STRATEGY B 3-PATTERN COMPARATIVE STUDY');
  console.log('   Period: 1 Full Month (30 Days) | Universe: 12 Elite Boom/Crash Pairs');
  console.log('=========================================================================\n');

  const models = [
    { id: '15M_BOS_FVG', name: 'Model 1: 15M Macro BOS + FVG Retest' },
    { id: '5M_BOS_FVG', name: 'Model 2: 5M Micro BOS + FVG Retest' },
    { id: '15M_LIQUIDITY_SWEEP', name: 'Model 3: 15M Liquidity Sweep + Rejection (Turtle Soup)' }
  ];

  for (const model of models) {
    const allTrades = [];
    for (const sym of SYMBOLS) {
      const file5m = path.join(CACHE_DIR, `${sym}_5m_hist_1M.json`);
      const file1h = path.join(CACHE_DIR, `${sym}_1h_hist_1M.json`);
      if (!fs.existsSync(file5m) || !fs.existsSync(file1h)) continue;

      const m5 = JSON.parse(fs.readFileSync(file5m, 'utf8'));
      const h1 = JSON.parse(fs.readFileSync(file1h, 'utf8'));
      const trades = runPatternSimulation(sym, m5, h1, model.id, 1.3);
      allTrades.push(...trades);
    }

    const res = simulatePortfolioDaily(allTrades);
    const winRate = res.totalTrades > 0 ? ((res.totalWins / res.totalTrades) * 100).toFixed(1) : '0.0';
    const tradesPerDay = (res.totalTrades / res.totalDays).toFixed(1);
    const tradesPerWeek = ((res.totalTrades / res.totalDays) * 7).toFixed(1);
    const sign = res.totalRealizedUSD >= 0 ? '+' : '';

    console.log(`=========================================================================`);
    console.log(`  🔬 ${model.name.toUpperCase()}`);
    console.log(`=========================================================================`);
    console.log(`  • Monthly Trades:         ${res.totalTrades} Trades`);
    console.log(`  • Weekly Trades:          ~${tradesPerWeek} Trades / Week`);
    console.log(`  • Daily Trades:           ~${tradesPerDay} Trades / Day (Across 12 Pairs)`);
    console.log(`  • Wins / Losses:          ${res.totalWins}W / ${res.totalLosses}L`);
    console.log(`  • Win Rate:               ${winRate}%`);
    console.log(`  • Net Realized PnL:       ${sign}$${res.totalRealizedUSD.toFixed(2)} USD (${sign}${(res.totalRealizedUSD / 229.20).toFixed(1)}R)`);
    console.log(`  • Target Hit Days:        ${res.targetHitDays} Days (${((res.targetHitDays / res.totalDays) * 100).toFixed(1)}%)`);
    console.log(`  • Loss Floor Days:        ${res.maxLossDays} Days (${((res.maxLossDays / res.totalDays) * 100).toFixed(1)}%)`);
    console.log(``);
  }
}

runFullComparison();
