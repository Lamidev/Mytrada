// marketStructure.js
/**
 * Core mathematical engine to analyze market structure.
 * Senior Institutional Quantitative Engine.
 * Implements strict real-time (non-lookahead) detection of:
 * - Swing Highs / Swing Lows (Pivots)
 * - Obvious V/A Liquidity Sweeps
 * - Breaks of Structure (BOS)
 * - Fibonacci Premium/Discount zones
 * - Order Blocks (OB) & Fair Value Gap (FVG / Imbalance) Displacement
 * - Dynamic Volatility ATR(14) Stop Loss Padding
 * - Institutional 0-10 Confluence Scorecard
 */

const config = require('./config');

/**
 * Calculates 14-period Average True Range (ATR)
 * @param {Array} candles Candle array
 * @param {number} period ATR Period (Default: 14)
 * @returns {number} Current ATR value
 */
function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 0;
  
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
 * Detects 3-candle Fair Value Gap (FVG / Imbalance Displacement) exiting an Order Block
 * @param {Array} candles Candle array
 * @param {number} obIndex Index of the Order Block candle
 * @param {'bullish'|'bearish'} type Setup direction
 * @returns {boolean} True if a valid FVG / Imbalance displacement exists
 */
function detectFVG(candles, obIndex, type) {
  if (!candles || obIndex + 2 >= candles.length) return true; // Default true if candle data short
  
  const c0 = candles[obIndex];
  const c1 = candles[obIndex + 1];
  const c2 = candles[obIndex + 2];
  
  if (type === 'bullish') {
    // Bullish FVG: Low of candle 3 > High of candle 1
    return c2.low > c0.high;
  } else {
    // Bearish FVG: High of candle 3 < Low of candle 1
    return c2.high < c0.low;
  }
}

/**
 * Computes the stop loss price for a setup.
 * Supports institutional ATR mode ('atr'), ratio mode ('ratio'), and price percentage mode ('price_pct').
 *
 * @param {'bullish'|'bearish'} direction
 * @param {number} protectedPrice  The Protected Low (bullish) or High (bearish)
 * @param {object} protectedCandle The candle at the protected swing point
 * @param {number} atrVal Optional ATR value for dynamic volatility padding
 * @returns {number} Computed SL price
 */
function computeStopLoss(direction, protectedPrice, protectedCandle, atrVal = 0) {
  let buffer;

  if (config.STOP_LOSS_BUFFER_MODE === 'atr' && atrVal > 0) {
    // Dynamic Volatility ATR Mode: SL buffer = ATR(14) × ATR_MULTIPLIER
    buffer = atrVal * (config.ATR_MULTIPLIER || 0.75);
  } else if (config.STOP_LOSS_BUFFER_MODE === 'price_pct') {
    // Fixed % of protected price level
    buffer = protectedPrice * (config.STOP_LOSS_PRICE_PCT || 0.001);
  } else {
    // Ratio of swing candle's full range (30% buffer default for wick safety)
    const candleRange = protectedCandle.high - protectedCandle.low;
    buffer = candleRange * (config.STOP_LOSS_BUFFER_RATIO || 0.30);
  }

  return direction === 'bullish'
    ? protectedPrice - buffer   // SL just BELOW the protected low
    : protectedPrice + buffer;  // SL just ABOVE the protected high
}

/**
 * Calculates Institutional Confluence Scorecard (0 to 10 points)
 * @param {object} setup Setup candidate
 * @param {string} htfTrend 'bullish' | 'bearish'
 * @param {boolean} hasFVG True if FVG displacement present
 * @returns {number} Confluence score (0 to 10)
 */
function calculateConfluenceScore(setup, htfTrend, hasFVG) {
  let score = 0;

  // 1. HTF Trend Alignment (+3 points)
  if (htfTrend && ((setup.type === 'bullish' && htfTrend === 'bullish') || (setup.type === 'bearish' && htfTrend === 'bearish'))) {
    score += 3;
  } else if (!htfTrend) {
    score += 2; // Neutral
  }

  // 2. FVG Displacement Imbalance (+2 points)
  if (hasFVG) {
    score += 2;
  }

  // 3. Liquidity Wick Sweep (+2 points)
  if (setup.structuralLiquidity) {
    score += 2;
  }

  // 4. Premium / Discount Fibonacci Zone (+2 points)
  if (setup.fibZone === 'discount' || setup.fibZone === 'premium') {
    score += 2;
  }

  // 5. Clean Risk-Reward Structure (+1 point)
  const priceDist = Math.abs(setup.entryPrice - setup.stopLoss);
  if (priceDist > 0) {
    score += 1;
  }

  return score;
}

/**
 * Checks if a candle is a valid sweep (wick rejection) of a target price.
 * @param {object} candle Candle to evaluate
 * @param {number} targetPrice Price level being swept
 * @param {string} type 'bullish' (sweeping low) or 'bearish' (sweeping high)
 * @returns {boolean} True if a valid sweep is detected
 */
function isValidSweep(candle, targetPrice, type) {
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  
  if (range === 0) return false;
  
  const bodyRatio = body / range;
  
  // Rule 1: The candle body must represent a sharp rejection (wick is dominant)
  if (bodyRatio > config.SWEEP_MAX_BODY_RATIO) return false;
  
  if (type === 'bullish') {
    return candle.low < targetPrice && candle.close >= targetPrice - (range * 0.05);
  } else {
    return candle.high > targetPrice && candle.close <= targetPrice + (range * 0.05);
  }
}

/**
 * Analyzes market structure up to the current index (no lookahead bias).
 * 
 * @param {Array} candles All historical candles
 * @param {number} currentIndex The simulated "now" candle index
 * @param {string} htfTrend Optional HTF trend direction ('bullish' or 'bearish')
 * @returns {object} Struct containing detected swings, BOS, OBs, and active setups
 */
function analyzeStructure(candles, currentIndex, htfTrend = null) {
  const left = config.PIVOT_LEFT_BARS;
  const right = config.PIVOT_RIGHT_BARS;
  
  const swingHighs = [];
  const swingLows = [];

  const sliceForATR = candles.slice(0, currentIndex + 1);
  const atrVal = calculateATR(sliceForATR, config.ATR_PERIOD || 14);
  
  const startScanIndex = Math.max(left, currentIndex - 600);
  for (let i = startScanIndex; i <= currentIndex - right; i++) {
    const current = candles[i];
    let isHigh = true;
    let isLow = true;
    
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= current.high) isHigh = false;
      if (candles[j].low <= current.low) isLow = false;
    }
    
    if (isHigh) {
      swingHighs.push({ index: i, price: current.high, time: current.time, candle: current });
    }
    if (isLow) {
      swingLows.push({ index: i, price: current.low, time: current.time, candle: current });
    }
  }

  let protectedLow = null;
  let protectedHigh = null;
  let structuralLiquidity = null;
  let swingC = null;
  let orderBlock = null;
  let setup = null;

  // Evaluate Bullish Setup
  for (let l = 1; l < swingLows.length; l++) {
    const currentLow = swingLows[l];
    const priorLow = swingLows[l - 1];
    
    if (isValidSweep(currentLow.candle, priorLow.price, 'bullish')) {
      protectedLow = {
        index: currentLow.index,
        price: currentLow.price,
        time: currentLow.time,
        candle: currentLow.candle,
        sweptPrice: priorLow.price
      };
      
      let obCandleIndex = currentLow.index;
      while (obCandleIndex > 0 && candles[obCandleIndex].close >= candles[obCandleIndex].open) {
        obCandleIndex--;
      }
      
      const obCandle = candles[obCandleIndex];
      orderBlock = {
        index: obCandleIndex,
        high: obCandle.high,
        low: obCandle.low,
        open: obCandle.open,
        close: obCandle.close,
        time: obCandle.time,
        type: 'bullish'
      };
      
      structuralLiquidity = null;
      swingC = null;
      setup = null;
    }
    
    if (protectedLow && !structuralLiquidity) {
      let highestHighIndex = -1;
      let highestHigh = -Infinity;
      
      const startScan = Math.max(0, protectedLow.index - 10);
      for (let k = startScan; k < protectedLow.index; k++) {
        if (candles[k].high > highestHigh) {
          highestHigh = candles[k].high;
          highestHighIndex = k;
        }
      }
      
      for (let k = protectedLow.index + 1; k <= currentIndex; k++) {
        if (candles[k].close > highestHigh) {
          const postBOSLows = swingLows.filter(sl => sl.index > protectedLow.index && sl.index <= currentIndex);
          if (postBOSLows.length > 0) {
            const candidateB = postBOSLows[0];
            const peakHigh = Math.max(...candles.slice(protectedLow.index, candidateB.index).map(c => c.high));
            const fibLevel = protectedLow.price + (peakHigh - protectedLow.price) * config.FIB_RETRACEMENT_LIMIT;
            
            if (candidateB.price <= fibLevel) {
              structuralLiquidity = {
                index: candidateB.index,
                price: candidateB.price,
                time: candidateB.time,
                candle: candidateB.candle
              };
            }
          }
          break;
        }
      }
    }
    
    if (protectedLow && structuralLiquidity && !swingC) {
      const peakHighBeforeB = Math.max(...candles.slice(protectedLow.index, structuralLiquidity.index).map(c => c.high));
      for (let k = structuralLiquidity.index + 1; k <= currentIndex; k++) {
        if (candles[k].close > peakHighBeforeB) {
          swingC = {
            index: k,
            price: candles[k].high,
            time: candles[k].time
          };
          break;
        }
      }
    }
    
    if (protectedLow && structuralLiquidity && swingC && orderBlock) {
      const entryPrice = orderBlock.high;
      const rangeHeight = swingC.price - protectedLow.price;
      const discountThreshold = protectedLow.price + rangeHeight * 0.50;
      const isInDiscountZone = !config.ENTRY_DISCOUNT_ONLY || (entryPrice <= discountThreshold);
      const hasFVG = detectFVG(candles, orderBlock.index, 'bullish');

      if (isInDiscountZone && (!config.REQUIRE_FVG || hasFVG)) {
        const candidateSetup = {
          type: 'bullish',
          protectedPoint: protectedLow,
          structuralLiquidity: structuralLiquidity,
          peak: swingC,
          orderBlock: orderBlock,
          entryPrice: entryPrice,
          stopLoss: computeStopLoss('bullish', protectedLow.price, candles[protectedLow.index], atrVal),
          takeProfit: swingC.price,
          fibZone: entryPrice <= discountThreshold ? 'discount' : 'premium',
          hasFVG: hasFVG,
          atrVal: atrVal
        };

        const score = calculateConfluenceScore(candidateSetup, htfTrend, hasFVG);
        candidateSetup.confluenceScore = score;

        if (score >= (config.MIN_CONFLUENCE_SCORE || 7)) {
          setup = candidateSetup;
        }
      }
    }
  }

  // Same logic for Bearish Sweeps and Protected Highs
  for (let h = 1; h < swingHighs.length; h++) {
    const currentHigh = swingHighs[h];
    const priorHigh = swingHighs[h - 1];
    
    if (isValidSweep(currentHigh.candle, priorHigh.price, 'bearish')) {
      protectedHigh = {
        index: currentHigh.index,
        price: currentHigh.price,
        time: currentHigh.time,
        candle: currentHigh.candle,
        sweptPrice: priorHigh.price
      };
      
      let obCandleIndex = currentHigh.index;
      while (obCandleIndex > 0 && candles[obCandleIndex].close <= candles[obCandleIndex].open) {
        obCandleIndex--;
      }
      
      const obCandle = candles[obCandleIndex];
      orderBlock = {
        index: obCandleIndex,
        high: obCandle.high,
        low: obCandle.low,
        open: obCandle.open,
        close: obCandle.close,
        time: obCandle.time,
        type: 'bearish'
      };
      
      structuralLiquidity = null;
      swingC = null;
      setup = null;
    }
    
    if (protectedHigh && !structuralLiquidity) {
      let lowestLowIndex = -1;
      let lowestLow = Infinity;
      
      const startScan = Math.max(0, protectedHigh.index - 10);
      for (let k = startScan; k < protectedHigh.index; k++) {
        if (candles[k].low < lowestLow) {
          lowestLow = candles[k].low;
          lowestLowIndex = k;
        }
      }
      
      for (let k = protectedHigh.index + 1; k <= currentIndex; k++) {
        if (candles[k].close < lowestLow) {
          const postBOSHighs = swingHighs.filter(sh => sh.index > protectedHigh.index && sh.index <= currentIndex);
          if (postBOSHighs.length > 0) {
            const candidateB = postBOSHighs[0];
            const troughLow = Math.min(...candles.slice(protectedHigh.index, candidateB.index).map(c => c.low));
            const fibLevel = protectedHigh.price - (protectedHigh.price - troughLow) * config.FIB_RETRACEMENT_LIMIT;
            
            if (candidateB.price >= fibLevel) {
              structuralLiquidity = {
                index: candidateB.index,
                price: candidateB.price,
                time: candidateB.time,
                candle: candidateB.candle
              };
            }
          }
          break;
        }
      }
    }
    
    if (protectedHigh && structuralLiquidity && !swingC) {
      const troughLowBeforeB = Math.min(...candles.slice(protectedHigh.index, structuralLiquidity.index).map(c => c.low));
      for (let k = structuralLiquidity.index + 1; k <= currentIndex; k++) {
        if (candles[k].close < troughLowBeforeB) {
          swingC = {
            index: k,
            price: candles[k].low,
            time: candles[k].time
          };
          break;
        }
      }
    }
    
    if (protectedHigh && structuralLiquidity && swingC && orderBlock) {
      const entryPrice = orderBlock.low;
      const rangeHeight = protectedHigh.price - swingC.price;
      const premiumThreshold = protectedHigh.price - rangeHeight * 0.50;
      const isInPremiumZone = !config.ENTRY_DISCOUNT_ONLY || (entryPrice >= premiumThreshold);
      const hasFVG = detectFVG(candles, orderBlock.index, 'bearish');

      if (isInPremiumZone && (!config.REQUIRE_FVG || hasFVG)) {
        const candidateSetup = {
          type: 'bearish',
          protectedPoint: protectedHigh,
          structuralLiquidity: structuralLiquidity,
          peak: swingC,
          orderBlock: orderBlock,
          entryPrice: entryPrice,
          stopLoss: computeStopLoss('bearish', protectedHigh.price, candles[protectedHigh.index], atrVal),
          takeProfit: swingC.price,
          fibZone: entryPrice >= premiumThreshold ? 'premium' : 'discount',
          hasFVG: hasFVG,
          atrVal: atrVal
        };

        const score = calculateConfluenceScore(candidateSetup, htfTrend, hasFVG);
        candidateSetup.confluenceScore = score;

        if (score >= (config.MIN_CONFLUENCE_SCORE || 7)) {
          setup = candidateSetup;
        }
      }
    }
  }

  return {
    swingHighs,
    swingLows,
    protectedLow,
    protectedHigh,
    structuralLiquidity,
    swingC,
    orderBlock,
    setup,
    atrVal
  };
}

module.exports = {
  isValidSweep,
  calculateATR,
  detectFVG,
  calculateConfluenceScore,
  analyzeStructure
};
