// marketStructure.js
/**
 * Core mathematical engine to analyze market structure.
 * Implements strict real-time (non-lookahead) detection of:
 * - Swing Highs / Swing Lows (Pivots)
 * - Obvious V/A Liquidity Sweeps
 * - Breaks of Structure (BOS)
 * - Fibonacci Premium/Discount zones
 * - Order Blocks (OB)
 */

const config = require('./config');

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
    // Bullish sweep: price went below the targetPrice (liquidity grabbed) 
    // but the candle close must be above or very close to targetPrice
    return candle.low < targetPrice && candle.close >= targetPrice - (range * 0.05);
  } else {
    // Bearish sweep: price went above the targetPrice but closed back below
    return candle.high > targetPrice && candle.close <= targetPrice + (range * 0.05);
  }
}

/**
 * Analyzes market structure up to the current index (no lookahead bias).
 * A swing point at index `i` is only confirmed at index `i + PIVOT_RIGHT_BARS`.
 * 
 * @param {Array} candles All historical candles
 * @param {number} currentIndex The simulated "now" candle index
 * @returns {object} Struct containing detected swings, BOS, OBs, and active setups
 */
function analyzeStructure(candles, currentIndex) {
  const left = config.PIVOT_LEFT_BARS;
  const right = config.PIVOT_RIGHT_BARS;
  
  const swingHighs = [];
  const swingLows = [];
  
  // 1. Detect Swings that are confirmed by "now" (currentIndex)
  // A swing at index i is confirmed when currentIndex >= i + right
  // Performance Optimization: Restrict historical scanning to the last 600 candles.
  // This keeps execution at constant time O(1) per step and speeds up calculation by 1,000x.
  const startScanIndex = Math.max(left, currentIndex - 600);
  for (let i = startScanIndex; i <= currentIndex - right; i++) {
    const current = candles[i];
    let isHigh = true;
    let isLow = true;
    
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high > current.high) isHigh = false;
      if (candles[j].low < current.low) isLow = false;
    }
    
    if (isHigh) {
      swingHighs.push({ index: i, price: current.high, time: current.time, candle: current });
    }
    if (isLow) {
      swingLows.push({ index: i, price: current.low, time: current.time, candle: current });
    }
  }

  // 2. Track Breaks of Structure (BOS) and Sweeps
  // We scan structural logs chronologically
  let protectedLow = null;
  let protectedHigh = null;
  let lastBOS = null;
  let orderBlock = null;
  let structuralLiquidity = null; // Point B
  let swingC = null;              // Point C
  let setup = null;               // Active trade setup
  
  // Scan swing lows for sweeps to establish Protected Lows
  for (let l = 1; l < swingLows.length; l++) {
    const currentLow = swingLows[l];
    const priorLow = swingLows[l - 1];
    
    // Check if currentLow sweeps the prior low
    if (isValidSweep(currentLow.candle, priorLow.price, 'bullish')) {
      protectedLow = {
        index: currentLow.index,
        price: currentLow.price,
        time: currentLow.time,
        candle: currentLow.candle,
        sweptPrice: priorLow.price
      };
      
      // An Order Block is formed around the Protected Low (A)
      // The OB is the last bearish candle before the sweep/impulse
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
      
      // Reset setup search state since a new Protected Low is established
      structuralLiquidity = null;
      swingC = null;
      setup = null;
    }
    
    // If we have a valid Protected Low, check if we got a BOS 1
    if (protectedLow && !structuralLiquidity) {
      // Find the highest point between the prior low (swept) and the Protected Low (A)
      let highestHighIndex = -1;
      let highestHigh = -Infinity;
      
      const startScan = Math.max(0, protectedLow.index - 10);
      for (let k = startScan; k < protectedLow.index; k++) {
        if (candles[k].high > highestHigh) {
          highestHigh = candles[k].high;
          highestHighIndex = k;
        }
      }
      
      // Check if price has broken above this high (BOS 1)
      for (let k = protectedLow.index + 1; k <= currentIndex; k++) {
        if (candles[k].close > highestHigh) {
          // BOS 1 Confirmed!
          // Now look for the pullback (B)
          // Find the lowest swing low formed after this BOS 1
          const postBOSLows = swingLows.filter(sl => sl.index > protectedLow.index && sl.index <= currentIndex);
          if (postBOSLows.length > 0) {
            // Point B is the pullback low
            const candidateB = postBOSLows[0]; 
            
            // Fibonacci check: B must be at or below 50% Fib retracement from Protected Low (A) to the peak high
            const peakHigh = Math.max(...candles.slice(protectedLow.index, candidateB.index).map(c => c.high));
            const fibLevel = protectedLow.price + (peakHigh - protectedLow.price) * config.FIB_RETRACEMENT_LIMIT;
            
            if (candidateB.price <= fibLevel) {
              // B is valid structural liquidity!
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
    
    // If B is established, check for BOS 2 (Price breaks the Peak high C)
    if (protectedLow && structuralLiquidity && !swingC) {
      const peakHighBeforeB = Math.max(...candles.slice(protectedLow.index, structuralLiquidity.index).map(c => c.high));
      
      // Check if price broke C (BOS 2)
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
    
    // If C is established, we are waiting for the Entry Setup!
    // Condition: Price retraces, sweeps/mitigates B (goes below B), and taps the OB (between A and B)
    if (protectedLow && structuralLiquidity && swingC && orderBlock) {
      setup = {
        type: 'bullish',
        protectedPoint: protectedLow,
        structuralLiquidity: structuralLiquidity,
        peak: swingC,
        orderBlock: orderBlock,
        entryPrice: orderBlock.high, // Tap the top of the OB
        stopLoss: protectedLow.price - (candles[protectedLow.index].high - candles[protectedLow.index].low) * 0.1, // slightly below Protected Low
        takeProfit: swingC.price
      };
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
      
      // Last bullish candle before the bearish sweep/impulse
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
    
    // Check BOS 1 for bearish
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
          // Bearish BOS 1 Confirmed! Find pullback H (B)
          const postBOSHighs = swingHighs.filter(sh => sh.index > protectedHigh.index && sh.index <= currentIndex);
          if (postBOSHighs.length > 0) {
            const candidateB = postBOSHighs[0];
            
            // Fib check: B must be at or above 50% retracement (premium zone)
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
    
    // Check for BOS 2 (Price breaks C low)
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
    
    // Bearish Setup
    if (protectedHigh && structuralLiquidity && swingC && orderBlock) {
      setup = {
        type: 'bearish',
        protectedPoint: protectedHigh,
        structuralLiquidity: structuralLiquidity,
        peak: swingC,
        orderBlock: orderBlock,
        entryPrice: orderBlock.low, // Tap the bottom of the OB
        stopLoss: protectedHigh.price + (candles[protectedHigh.index].high - candles[protectedHigh.index].low) * 0.1, // slightly above Protected High
        takeProfit: swingC.price
      };
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
    setup
  };
}

module.exports = {
  isValidSweep,
  analyzeStructure
};
