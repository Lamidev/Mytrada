// backtestGoldM1.js
/**
 * Quantitative Backtest Engine for Strategy 5G Gold Flash Scalper (frxXAUUSD)
 * Simulates bar-by-bar M1 execution with dynamic M5 liquidity sweeps and 1:1.3 R:R.
 */

const fs = require('fs');
const path = require('path');
const { getCandles, fetchCandlesInChunks } = require('./dataFetcher');
const { detectGoldFlashScalp, calculateATR } = require('./goldScalper');

const GOLD_SYMBOL = 'frxXAUUSD';

async function runGoldBacktest(targetCount = 6000) {
  console.log(`\n===============================================================`);
  console.log(`👑 QUANTITATIVE BACKTEST: STRATEGY 5G GOLD FLASH SCALPER`);
  console.log(`Symbol: ${GOLD_SYMBOL} (XAUUSD) | Target M1 Sample: ${targetCount} bars (~${(targetCount / 1440).toFixed(1)} Days)`);
  console.log(`===============================================================\n`);

  console.log(`[1/3] Fetching multi-day historical M1 candles from Deriv...`);
  let m1Candles = await fetchCandlesInChunks(GOLD_SYMBOL, 60, targetCount);
  console.log(`  Fetched: ${m1Candles.length} M1 candles (~${(m1Candles.length / 1440).toFixed(1)} Days).`);

  console.log(`[2/3] Fetching historical M5 and M15 context candles...`);
  const m5Candles = await fetchCandlesInChunks(GOLD_SYMBOL, 300, 2000);
  const m15Candles = await fetchCandlesInChunks(GOLD_SYMBOL, 900, 1000);
  console.log(`  Fetched: ${m5Candles.length} M5 candles and ${m15Candles.length} M15 candles.`);

  if (m1Candles.length < 500) {
    console.error(`Insufficient candle data to perform a robust backtest.`);
    return;
  }

  console.log(`\n[3/3] Running Bar-by-Bar Simulation...`);

  const trades = [];
  let inTrade = false;
  let currentTrade = null;

  // Start simulation after sufficient lookback (at least 60 bars for M1, 20 for M5)
  for (let i = 60; i < m1Candles.length - 20; i++) {
    const currentM1 = m1Candles[i];
    const currentEpoch = currentM1.time || currentM1.epoch;

    // Check open trade resolution
    if (inTrade && currentTrade) {
      const isBuy = currentTrade.direction === 'BUY';
      let hitTP = false;
      let hitSL = false;

      if (isBuy) {
        if (currentM1.high >= currentTrade.tp) hitTP = true;
        else if (currentM1.low <= currentTrade.sl) hitSL = true;
      } else {
        if (currentM1.low <= currentTrade.tp) hitTP = true;
        else if (currentM1.high >= currentTrade.sl) hitSL = true;
      }

      if (hitTP || hitSL) {
        const exitTime = currentM1.time || currentM1.epoch;
        const durationBars = i - currentTrade.entryBarIndex;
        const outcome = hitTP ? 'WIN' : 'LOSS';
        const pnlR = hitTP ? 1.30 : -1.00;

        trades.push({
          ...currentTrade,
          exitPrice: hitTP ? currentTrade.tp : currentTrade.sl,
          exitTime,
          outcome,
          pnlR,
          durationMinutes: durationBars
        });

        inTrade = false;
        currentTrade = null;
        continue;
      }

      // Max holding time guard: If trade has been open for > 15 minutes without hitting TP/SL, time-exit at market
      if (i - currentTrade.entryBarIndex >= 15) {
        const isBuy = currentTrade.direction === 'BUY';
        const exitPrice = currentM1.close;
        const pnlPoints = isBuy ? (exitPrice - currentTrade.entry) : (currentTrade.entry - exitPrice);
        const pnlR = pnlPoints >= 0 ? (pnlPoints / currentTrade.slDist) : -(Math.abs(pnlPoints) / currentTrade.slDist);
        const outcome = pnlPoints >= 0 ? 'WIN' : 'LOSS';

        trades.push({
          ...currentTrade,
          exitPrice,
          exitTime: currentM1.time || currentM1.epoch,
          outcome,
          pnlR: Math.max(-1.0, Math.min(1.3, pnlR)),
          durationMinutes: i - currentTrade.entryBarIndex,
          note: 'Time Stop Exit (15m)'
        });

        inTrade = false;
        currentTrade = null;
        continue;
      }
    }

    // If not currently in a trade, scan for a new M1 setup
    if (!inTrade) {
      const slicedM1 = m1Candles.slice(0, i + 1);
      // Synchronize M5 candles up to current timestamp
      const slicedM5 = m5Candles.filter(c => (c.time || c.epoch) <= currentEpoch);
      const slicedM15 = m15Candles.filter(c => (c.time || c.epoch) <= currentEpoch);

      if (slicedM5.length >= 15) {
        const setup = detectGoldFlashScalp(slicedM1, slicedM5, slicedM15);
        if (setup) {
          inTrade = true;
          currentTrade = {
            ...setup,
            entryBarIndex: i,
            entryTime: currentEpoch
          };
        }
      }
    }
  }

  // ── STATISTICAL PERFORMANCE REPORT ──
  const totalTrades = trades.length;
  if (totalTrades === 0) {
    console.log(`\n⚠️ No trades were triggered during the backtest period.`);
    return;
  }

  const wins = trades.filter(t => t.outcome === 'WIN');
  const losses = trades.filter(t => t.outcome === 'LOSS');
  const winRate = ((wins.length / totalTrades) * 100).toFixed(1);
  const totalR = trades.reduce((sum, t) => sum + t.pnlR, 0).toFixed(2);
  const avgHoldMinutes = (trades.reduce((sum, t) => sum + t.durationMinutes, 0) / totalTrades).toFixed(1);

  const grossProfitR = wins.reduce((sum, t) => sum + t.pnlR, 0);
  const grossLossR = Math.abs(losses.reduce((sum, t) => sum + t.pnlR, 0));
  const profitFactor = grossLossR > 0 ? (grossProfitR / grossLossR).toFixed(2) : '∞';

  console.log(`\n===============================================================`);
  console.log(`📊 STRATEGY 5G GOLD FLASH SCALPER BACKTEST RESULTS`);
  console.log(`===============================================================`);
  console.log(`Period Covered:       ~${(m1Candles.length / 1440).toFixed(1)} Days (${m1Candles.length} M1 Bars)`);
  console.log(`Total Scalps Taken:   ${totalTrades}`);
  console.log(`Winning Trades:       ${wins.length}`);
  console.log(`Losing Trades:        ${losses.length}`);
  console.log(`Win Rate:             ${winRate}%`);
  console.log(`Profit Factor:        ${profitFactor}`);
  console.log(`Net R-Multiple:       ${totalR >= 0 ? '+' : ''}${totalR}R`);
  console.log(`Average Hold Time:    ${avgHoldMinutes} Minutes / trade`);
  console.log(`===============================================================\n`);

  console.log(`📋 SAMPLE RECENT TRADES:`);
  trades.slice(-5).forEach(t => {
    const emoji = t.outcome === 'WIN' ? '🟢 WIN' : '🔴 LOSS';
    console.log(`• ${emoji} (${t.direction}) | Entry: $${t.entry.toFixed(2)} ➔ Exit: $${t.exitPrice.toFixed(2)} | Net: ${t.pnlR >= 0 ? '+' : ''}${t.pnlR.toFixed(2)}R | Duration: ${t.durationMinutes}m`);
  });
  console.log(`\n`);
}

if (require.main === module) {
  runGoldBacktest(5000).then(() => process.exit(0));
}
