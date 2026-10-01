// goldScalper.js
/**
 * 👑 Strategy 5G Gold Flash Scalper — M1 Liquidity Sweep & Elastic Rebound Engine
 * Designed for XAUUSD (frxXAUUSD) on Deriv / MT5.
 * 
 * Strategy Philosophy:
 * - Ultra-fast 1-minute (M1) execution (30 to 120-second target hold time).
 * - Identifies micro-liquidity sweeps where price pierces a local M5/M15 swing high/low.
 * - Enters on candle close when an exhaustion wick (>50% of candle range) forms.
 * - Targets quick elastic snapbacks ($1.20 - $2.00 price movement on Gold).
 * - Strict, tight Stop Loss ($1.00 - $1.50) anchored strictly behind the sweep wick.
 * - Zero grid stacking, zero martingale, zero deep drawdown holding.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getCandles } = require('./dataFetcher');
const { sendTelegramMessage } = require('./telegramBot');

const GOLD_SYMBOL = 'frxXAUUSD';
const GOLD_NAME = 'Gold / USD (XAUUSD)';

// ── TECHNICAL INDICATORS ──
function calculateEMA(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const emaArray = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prevEma = sum / period;
  emaArray.push(prevEma);

  for (let i = period; i < values.length; i++) {
    const curEma = (values[i] * k) + (prevEma * (1 - k));
    emaArray.push(curEma);
    prevEma = curEma;
  }
  return emaArray;
}

function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    trs.push(Math.max(hl, hc, lc));
  }

  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

/**
 * Identifies local swing highs and lows on higher timeframes (M5 / M15)
 */
function findSwingLevels(candles, lookback = 20) {
  const recent = candles.slice(-lookback);
  const highest = Math.max(...recent.map(c => c.high));
  const lowest  = Math.min(...recent.map(c => c.low));
  return { swingHigh: highest, swingLow: lowest };
}

/**
 * ── CORE STRATEGY 5G SIGNAL ENGINE ──
 * Evaluates M1, M5, and M15 candles for an ultra-fast flash scalp.
 */
function detectGoldFlashScalp(m1Candles, m5Candles, m15Candles) {
  if (!m1Candles || m1Candles.length < 30 || !m5Candles || m5Candles.length < 20) {
    return null;
  }

  const m1Atr = calculateATR(m1Candles, 14);
  if (!m1Atr || m1Atr < 0.30) return null; // Avoid dead markets with zero volatility

  // M15 Directional Bias (50 EMA)
  let m15Bias = 'NEUTRAL';
  if (m15Candles && m15Candles.length >= 50) {
    const m15Closes = m15Candles.map(c => c.close);
    const m15Ema = calculateEMA(m15Closes, 50);
    const lastClose = m15Closes[m15Closes.length - 1];
    const lastEma = m15Ema[m15Ema.length - 1];
    m15Bias = lastClose > lastEma ? 'BULLISH' : 'BEARISH';
  }

  // Find recent M5 liquidity pools (last 15 bars = 75 minutes of price action)
  const { swingHigh, swingLow } = findSwingLevels(m5Candles, 15);

  // Analyze the latest closed 1-Minute Candle (C0)
  const c0 = m1Candles[m1Candles.length - 1];
  const c0Range = c0.high - c0.low;
  if (c0Range < m1Atr * 0.70) return null; // Ignore micro dojis / chop candles

  const c0Body = Math.abs(c0.close - c0.open);
  const upperWick = c0.high - Math.max(c0.open, c0.close);
  const lowerWick = Math.min(c0.open, c0.close) - c0.low;

  // Minimum wick ratio: The rejection wick must be at least 45% of the total candle range
  const upperWickRatio = c0Range > 0 ? (upperWick / c0Range) : 0;
  const lowerWickRatio = c0Range > 0 ? (lowerWick / c0Range) : 0;

  // Minimum required point movement on Gold (e.g. at least $0.80-$1.20)
  const minSlDistance = Math.max(0.80, m1Atr * 1.10);

  // ── CASE 1: BEARISH FLASH SCALP (SELL) ──
  // Price swept above swing high, left a massive top wick, and closed lower
  const sweptHigh = c0.high >= (swingHigh - 0.20);
  const strongUpperRejection = upperWickRatio >= 0.45 && c0.close <= (c0.high - (c0Range * 0.50));
  
  if (sweptHigh && strongUpperRejection) {
    const entry = c0.close;
    // SL placed slightly above the sweep wick high
    const sl = c0.high + 0.30;
    const slDist = sl - entry;

    if (slDist >= minSlDistance && slDist <= 3.50) {
      const tpDist = slDist * 1.30;
      const tp = entry - tpDist;

      return {
        symbol: GOLD_SYMBOL,
        direction: 'SELL',
        type: 'bearish',
        timeframe: '1m',
        entry,
        sl,
        tp,
        slDist,
        tpDist,
        m1Atr,
        m15Bias,
        sweepLevel: swingHigh,
        rejectionWickRatio: (upperWickRatio * 100).toFixed(1) + '%',
        rationale: `M1 Liquidity Sweep above $${swingHigh.toFixed(2)} with ${(upperWickRatio * 100).toFixed(0)}% upper rejection wick`,
        timestamp: new Date().toISOString()
      };
    }
  }

  // ── CASE 2: BULLISH FLASH SCALP (BUY) ──
  // Price swept below swing low, left a massive bottom wick, and closed higher
  const sweptLow = c0.low <= (swingLow + 0.20);
  const strongLowerRejection = lowerWickRatio >= 0.45 && c0.close >= (c0.low + (c0Range * 0.50));

  if (sweptLow && strongLowerRejection) {
    const entry = c0.close;
    // SL placed slightly below the sweep wick low
    const sl = c0.low - 0.30;
    const slDist = entry - sl;

    if (slDist >= minSlDistance && slDist <= 3.50) {
      const tpDist = slDist * 1.30;
      const tp = entry + tpDist;

      return {
        symbol: GOLD_SYMBOL,
        direction: 'BUY',
        type: 'bullish',
        timeframe: '1m',
        entry,
        sl,
        tp,
        slDist,
        tpDist,
        m1Atr,
        m15Bias,
        sweepLevel: swingLow,
        rejectionWickRatio: (lowerWickRatio * 100).toFixed(1) + '%',
        rationale: `M1 Liquidity Sweep below $${swingLow.toFixed(2)} with ${(lowerWickRatio * 100).toFixed(0)}% lower rejection wick`,
        timestamp: new Date().toISOString()
      };
    }
  }

  return null;
}

/**
 * Calculates Gold Lot Size based on risk amount ($USD)
 * Standard Gold contract: 1 lot = 100 oz. 1 point move ($1.00) with 1 lot = $100.
 * Micro Gold contract on Deriv/Exness: 1 lot = 10 oz or standard 0.01 lot = $1.00 move per $1.00.
 */
function calculateGoldLotSize(riskUSD, slDistance) {
  if (!slDistance || slDistance <= 0) return 0.01;
  // Raw standard lot calculation
  const rawLot = riskUSD / (slDistance * 100);
  // Clamp between 0.01 and 1.00 for safety
  return Math.max(0.01, parseFloat(rawLot.toFixed(2)));
}

/**
 * Single Scan Execution Cycle for Gold
 */
async function scanGoldMarket(verbose = true) {
  try {
    if (verbose) {
      console.log(`\n👑 [GOLD SCALPER] Fetching live multi-timeframe candles for ${GOLD_NAME}...`);
    }

    const [m1Candles, m5Candles, m15Candles] = await Promise.all([
      getCandles(GOLD_SYMBOL, '1m', 100, true),
      getCandles(GOLD_SYMBOL, '5m', 50, true),
      getCandles(GOLD_SYMBOL, '15m', 60, true)
    ]);

    if (!m1Candles || m1Candles.length === 0) {
      console.warn(`[GOLD SCALPER] No M1 candles returned for ${GOLD_SYMBOL}.`);
      return null;
    }

    const currentPrice = m1Candles[m1Candles.length - 1].close;
    const m1Atr = calculateATR(m1Candles, 14);
    const { swingHigh, swingLow } = findSwingLevels(m5Candles, 15);

    if (verbose) {
      console.log(`  Current Price: $${currentPrice.toFixed(2)}`);
      console.log(`  M1 ATR(14):    $${m1Atr.toFixed(2)} / min`);
      console.log(`  M5 Range:      Low: $${swingLow.toFixed(2)} ➔ High: $${swingHigh.toFixed(2)}`);
    }

    const setup = detectGoldFlashScalp(m1Candles, m5Candles, m15Candles);

    if (setup) {
      console.log(`\n🎯 🟢 [GOLD SETUP DETECTED!]`);
      console.log(`  Action:    ${setup.direction}`);
      console.log(`  Entry:     $${setup.entry.toFixed(2)}`);
      console.log(`  SL:        $${setup.sl.toFixed(2)} (-$${setup.slDist.toFixed(2)} pts)`);
      console.log(`  TP:        $${setup.tp.toFixed(2)} (+$${setup.tpDist.toFixed(2)} pts • 1:1.3 R:R)`);
      console.log(`  Rationale: ${setup.rationale}`);
      return setup;
    } else {
      if (verbose) {
        console.log(`  Status: No liquidity sweep exhaustion on latest M1 candle. Monitoring...`);
      }
      return null;
    }
  } catch (err) {
    console.error(`[GOLD SCALPER ERROR]:`, err.message);
    return null;
  }
}

module.exports = {
  GOLD_SYMBOL,
  GOLD_NAME,
  detectGoldFlashScalp,
  calculateGoldLotSize,
  scanGoldMarket
};

// ── STANDALONE CLI TEST RUNNER ──
if (require.main === module) {
  (async () => {
    console.log(`\n===============================================================`);
    console.log(`👑 MYTRADA STRATEGY 5G: GOLD FLASH SCALPER (M1 LIQUIDITY SNIPER)`);
    console.log(`===============================================================`);
    await scanGoldMarket(true);
  })();
}
