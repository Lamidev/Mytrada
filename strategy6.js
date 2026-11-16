// strategy6.js
/**
 * 👑 STRATEGY 6: BREAK & RETEST CONTINUATION (NON-SPIKE SMC ENGINE)
 * 
 * Re-architected for pure institutional Price Action:
 * - Completely decoupled from counter-spike pullback guessing.
 * - Non-correlated partner to Strategy SMC Sweep:
 *     • SMC Sweep captures Liquidity Purges / Reversals at market extremes.
 *     • Strategy 6 captures Break of Structure (BoS) + Pullback Retests in trending regimes.
 * 
 * Execution Rules:
 * 1. 1H Macro Trend: 50 EMA alignment + 24H Dealing Range (Premium for Boom, Discount for Crash).
 * 2. 15M Break of Structure (BoS): Confirmed 15M structural break of support (Boom) or resistance (Crash).
 * 3. 5M Role-Reversal Retest: Price pulls back to retest the broken level (Support -> Resistance on Boom; Resistance -> Support on Crash).
 * 4. Absorption Confirmation: 5M rejection candle confirming the hold of the retested level.
 * 5. Dynamic Risk Buffer: Tight structural SL (0.7x ATR beyond level) anchored to 1:1.3 R:R.
 */

const config = require('./config');

function calculateEMA(prices, period) {
  if (!prices || prices.length < period) return [];
  const k = 2 / (period + 1);
  const ema = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    ema.push(prices[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 1.0;
  let trSum = 0;
  const start = Math.max(1, candles.length - period);
  for (let i = start; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trSum += tr;
  }
  return trSum / period;
}

/**
 * 👑 STRATEGY 6 SIGNAL DETECTION ENGINE
 * Signature matches runner's call: (ltfCandles, htf1hCandles, htf4hCandles, dailyCandles, mode, minSpikesRequired, symbol)
 */
function detectStrategy6Setup(ltfCandles, htf1hCandles, htf4hCandles, dailyCandles, mode, minSpikesRequired, symbol) {
  if (!ltfCandles || ltfCandles.length < 35 || !htf1hCandles || htf1hCandles.length < 40) return null;

  // 1. 1H Macro Trend Alignment
  const h1Closes = htf1hCandles.map(c => c.close);
  const h1EMA = calculateEMA(h1Closes, 50);
  const lastH1Close = h1Closes[h1Closes.length - 1];
  const lastH1Ema = h1EMA[h1EMA.length - 1];
  if (!lastH1Ema) return null;

  // 4H Trend Context (Optional confirmation)
  let htf4hTrend = 'neutral';
  if (htf4hCandles && htf4hCandles.length >= 20) {
    const h4Closes = htf4hCandles.map(c => c.close);
    const h4EMA = calculateEMA(h4Closes, Math.min(50, h4Closes.length - 1));
    if (h4EMA.length > 0) {
      htf4hTrend = h4Closes[h4Closes.length - 1] > h4EMA[h4EMA.length - 1] ? 'bullish' : 'bearish';
    }
  }

  // 24H Dealing Range (Macro Premium / Discount)
  const h1Lookback = htf1hCandles.slice(Math.max(0, htf1hCandles.length - 24));
  const dayHigh = Math.max(...h1Lookback.map(c => c.high));
  const dayLow = Math.min(...h1Lookback.map(c => c.low));
  const dayRange = dayHigh - dayLow;
  if (dayRange <= 0) return null;

  const currentPrice = ltfCandles[ltfCandles.length - 1].close;
  const rangePct = ((currentPrice - dayLow) / dayRange) * 100;

  // Trend Gate:
  // On Boom SELL: 1H must be Bearish, price must be in Premium (> 35% of range)
  // On Crash BUY: 1H must be Bullish, price must be in Discount (< 65% of range)
  if (mode === 'BOOM') {
    if (lastH1Close > lastH1Ema) return null;
    if (rangePct < 35.0) return null;
  } else {
    if (lastH1Close < lastH1Ema) return null;
    if (rangePct > 65.0) return null;
  }

  // 2. Aggregate 5M Candles into 15M Structure
  const m15Candles = [];
  for (let i = 0; i < ltfCandles.length; i += 3) {
    const chunk = ltfCandles.slice(i, i + 3);
    if (chunk.length < 3) break;
    m15Candles.push({
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk[2].close
    });
  }
  if (m15Candles.length < 10) return null;

  // Find 15M fractal swing points
  const swingLows = [];
  const swingHighs = [];
  for (let j = 2; j < m15Candles.length - 2; j++) {
    const prev1 = m15Candles[j - 1], prev2 = m15Candles[j - 2];
    const curr = m15Candles[j];
    const next1 = m15Candles[j + 1], next2 = m15Candles[j + 2];
    if (curr.low < prev1.low && curr.low < prev2.low && curr.low < next1.low && curr.low < next2.low) {
      swingLows.push(curr.low);
    }
    if (curr.high > prev1.high && curr.high > prev2.high && curr.high > next1.high && curr.high > next2.high) {
      swingHighs.push(curr.high);
    }
  }

  const atr = calculateATR(ltfCandles, 14);
  if (!atr || atr === 0) return null;

  const c0 = ltfCandles[ltfCandles.length - 1]; // Latest closed 5M bar
  const c1 = ltfCandles[ltfCandles.length - 2];
  const candleEpoch = c0.epoch || c0.time;

  // 3. Execution: Break & Retest Model
  if (mode === 'BOOM' && swingLows.length >= 2) {
    const brokenSupport = swingLows[swingLows.length - 2];
    const recentLow = swingLows[swingLows.length - 1];

    // Must have formed a lower low below broken support (Break of Structure)
    const hasBrokenDown = recentLow < brokenSupport;
    if (!hasBrokenDown) return null;

    // Retest Condition: Price pulled back up into the broken support zone
    const inRetestZone = (c0.high >= (brokenSupport - atr * 0.3)) && (c0.high <= (brokenSupport + atr * 0.65));
    const isBearishRejection = c0.close < c0.open && c0.close < brokenSupport;

    if (inRetestZone && isBearishRejection) {
      const entry = c0.close;
      let slDist = (Math.max(c0.high, brokenSupport) - entry) + (atr * 0.7);
      if (slDist < (atr * 0.8)) slDist = atr * 0.8;
      if (slDist <= 0 || slDist > atr * 4.5) return null;

      const stopLoss = entry + slDist;
      const takeProfit = entry - (slDist * 1.3);

      return {
        strategy: 'Strategy 6',
        direction: 'SELL',
        type: 'bearish',
        entry,
        sl: stopLoss,
        tp: takeProfit,
        slDist,
        atr,
        candleEpoch,
        htf4hTrend,
        htf1hTrend: 'bearish',
        dailyTrend: 'bearish',
        valuationLabel: `Macro Range: ${rangePct.toFixed(1)}% (Premium Retest)`,
        liquidityLabel: `15M Broken Support @ ${brokenSupport.toFixed(2)} (Role Reversal Resistance)`,
        spikeCountLabel: '0 Spikes (Non-Spike Break & Retest)',
        confirmCount: 1,
        isBlocked: false,
        blockedReason: null
      };
    }
  } else if (mode === 'CRASH' && swingHighs.length >= 2) {
    const brokenResistance = swingHighs[swingHighs.length - 2];
    const recentHigh = swingHighs[swingHighs.length - 1];

    // Must have formed a higher high above broken resistance (Break of Structure)
    const hasBrokenUp = recentHigh > brokenResistance;
    if (!hasBrokenUp) return null;

    // Retest Condition: Price pulled back down into broken resistance
    const inRetestZone = (c0.low <= (brokenResistance + atr * 0.3)) && (c0.low >= (brokenResistance - atr * 0.65));
    const isBullishRejection = c0.close > c0.open && c0.close > brokenResistance;

    if (inRetestZone && isBullishRejection) {
      const entry = c0.close;
      let slDist = (entry - Math.min(c0.low, brokenResistance)) + (atr * 0.7);
      if (slDist < (atr * 0.8)) slDist = atr * 0.8;
      if (slDist <= 0 || slDist > atr * 4.5) return null;

      const stopLoss = entry - slDist;
      const takeProfit = entry + (slDist * 1.3);

      return {
        strategy: 'Strategy 6',
        direction: 'BUY',
        type: 'bullish',
        entry,
        sl: stopLoss,
        tp: takeProfit,
        slDist,
        atr,
        candleEpoch,
        htf4hTrend,
        htf1hTrend: 'bullish',
        dailyTrend: 'bullish',
        valuationLabel: `Macro Range: ${rangePct.toFixed(1)}% (Discount Retest)`,
        liquidityLabel: `15M Broken Resistance @ ${brokenResistance.toFixed(2)} (Role Reversal Support)`,
        spikeCountLabel: '0 Spikes (Non-Spike Break & Retest)',
        confirmCount: 1,
        isBlocked: false,
        blockedReason: null
      };
    }
  }

  return null;
}

module.exports = {
  detectStrategy6Setup,
  calculateEMA,
  calculateATR
};
