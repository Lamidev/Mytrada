// backtester.js
/**
 * Backtester Engine for Algo Market Structure.
 * Simulates real-time chronological execution over historical data
 * with strict money management and dynamic performance analysis.
 */

const config = require('./config');
const { analyzeStructure } = require('./marketStructure');

/**
 * Calculates simple moving average (SMA) for trend filtering
 */
function calculateEMA(prices, period) {
  const ema = [];
  if (prices.length === 0) return ema;
  
  // Start with SMA
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

/**
 * Runs the backtester over LTF and HTF candle historical arrays.
 * 
 * @param {string} symbol Symbol name (e.g. 'R_75')
 * @param {Array} ltfCandles Lower Timeframe candle array
 * @param {Array} htfCandles Optional Higher Timeframe candle array for trend filter
 * @returns {object} Full backtest performance report
 */
function runBacktest(symbol, ltfCandles, htfCandles = null) {
  if (ltfCandles.length < 50) {
    throw new Error(`Insufficient historical candles (${ltfCandles.length}) to run a valid backtest.`);
  }

  // Pre-calculate HTF trend bias if HTF candles are provided
  const htfTrends = new Map(); // Map epoch time -> trend ('bullish' or 'bearish')
  
  if (htfCandles && htfCandles.length > 50) {
    const htfCloses = htfCandles.map(c => c.close);
    const htfEMA = calculateEMA(htfCloses, 50); // 50 EMA trend filter
    
    for (let i = 0; i < htfCandles.length; i++) {
      const emaVal = htfEMA[i];
      if (emaVal) {
        const trend = htfCandles[i].close > emaVal ? 'bullish' : 'bearish';
        htfTrends.set(htfCandles[i].time, trend);
      }
    }
  }

  let balance = config.STARTING_BALANCE;
  let peakBalance = balance;
  let maxDrawdown = 0;
  
  const trades = [];
  const equityCurve = [{ time: ltfCandles[0].time, balance: balance }];
  
  let activeTrade = null;
  let activeSetup = null;
  let hasSweptLiq = false;
  
  const cooldownPeriod = 5; // candles to wait after a trade closes before looking for a new setup
  let cooldownCounter = 0;

  // Chronological replay loop
  for (let i = 50; i < ltfCandles.length; i++) {
    const currentCandle = ltfCandles[i];
    
    // Decrement cooldown if active
    if (cooldownCounter > 0) {
      cooldownCounter--;
    }
    
    // 1. If we are in an active trade, evaluate Stop Loss / Take Profit
    if (activeTrade) {
      const trade = activeTrade;
      let hitSL = false;
      let hitTP = false;
      
      if (trade.type === 'buy') {
        if (currentCandle.low <= trade.stopLoss) {
          hitSL = true;
        } else if (currentCandle.high >= trade.takeProfit) {
          hitTP = true;
        }
      } else if (trade.type === 'sell') {
        if (currentCandle.high >= trade.stopLoss) {
          hitSL = true;
        } else if (currentCandle.low <= trade.takeProfit) {
          hitTP = true;
        }
      }
      
      if (hitSL || hitTP) {
        // Trade closed!
        trade.exitTime = currentCandle.time;
        trade.exitIndex = i;
        
        if (hitSL) {
          trade.result = 'loss';
          trade.exitPrice = trade.stopLoss;
          trade.profit = -trade.riskAmount;
        } else {
          trade.result = 'win';
          trade.exitPrice = trade.takeProfit;
          trade.profit = trade.riskAmount * config.REWARD_RATIO;
        }
        
        balance += trade.profit;
        trade.finalBalance = balance;
        trade.holdTime = i - trade.entryIndex;
        
        trades.push(trade);
        equityCurve.push({ time: currentCandle.time, balance: balance });
        
        // Drawdown Tracking
        if (balance > peakBalance) {
          peakBalance = balance;
        }
        const dd = (peakBalance - balance) / peakBalance;
        if (dd > maxDrawdown) {
          maxDrawdown = dd;
        }
        
        // Reset active trade and set cooldown
        activeTrade = null;
        cooldownCounter = cooldownPeriod;
        continue;
      }
    }
    
    // 2. If we are IDLE, scan market structure for setups and trigger entries
    if (!activeTrade && cooldownCounter === 0) {
      const analysis = analyzeStructure(ltfCandles, i);
      const setup = analysis.setup;
      
      if (setup) {
        // Initialize or update setup state
        if (!activeSetup || activeSetup.protectedPoint.index !== setup.protectedPoint.index) {
          activeSetup = setup;
          hasSweptLiq = false;
        } else {
          activeSetup = setup; // Keep sync
        }
        
        // A. Determine HTF Trend Bias if active
        let isTrendAligned = true;
        
        if (htfCandles && htfTrends.size > 0) {
          // Find the last closed HTF candle prior to the current LTF candle's timestamp
          let lastHtfTime = 0;
          for (const t of htfTrends.keys()) {
            if (t <= currentCandle.time && t > lastHtfTime) {
              lastHtfTime = t;
            }
          }
          
          if (lastHtfTime > 0) {
            const htfTrend = htfTrends.get(lastHtfTime);
            isTrendAligned = (activeSetup.type === 'bullish' && htfTrend === 'bullish') || 
                             (activeSetup.type === 'bearish' && htfTrend === 'bearish');
          }
        }
        
        if (isTrendAligned) {
          // B. Verify Invalidation, Sweeping and Mitigating/Tapping conditions
          if (activeSetup.type === 'bullish') {
            // Check Invalidation: Price breaks Protected Extremity A
            if (currentCandle.low < activeSetup.protectedPoint.price) {
              activeSetup = null;
              hasSweptLiq = false;
              continue;
            }
            
            // Check Sweep of B
            if (currentCandle.low < activeSetup.structuralLiquidity.price) {
              hasSweptLiq = true;
            }
            
            // Check OB Entry limit tap
            if (hasSweptLiq && currentCandle.low <= activeSetup.orderBlock.high) {
              const entryPrice = Math.min(activeSetup.orderBlock.high, currentCandle.open);
              const riskAmount = balance * (config.RISK_PERCENT / 100);
              const priceDistance = Math.abs(entryPrice - activeSetup.stopLoss);
              
              if (priceDistance > 0) {
                const positionUnits = riskAmount / priceDistance;
                
                activeTrade = {
                  symbol: symbol,
                  type: 'buy',
                  entryTime: currentCandle.time,
                  entryIndex: i,
                  entryPrice: entryPrice,
                  stopLoss: activeSetup.stopLoss,
                  takeProfit: entryPrice + (entryPrice - activeSetup.stopLoss) * config.REWARD_RATIO,
                  riskAmount: riskAmount,
                  positionUnits: positionUnits,
                  initialBalance: balance,
                  structuralState: {
                    A: activeSetup.protectedPoint.price,
                    B: activeSetup.structuralLiquidity.price,
                    C: activeSetup.peak.price
                  }
                };
                
                console.log(`[Backtester] 🟢 Triggered BUY trade on ${symbol} at price ${entryPrice.toFixed(2)} | SL: ${activeTrade.stopLoss.toFixed(2)} | TP: ${activeTrade.takeProfit.toFixed(2)}`);
                
                // Clear active setup as it has successfully triggered and entered
                activeSetup = null;
                hasSweptLiq = false;
              }
            }
          } else {
            // Bearish setup
            // Check Invalidation: Price breaks Protected Extremity A
            if (currentCandle.high > activeSetup.protectedPoint.price) {
              activeSetup = null;
              hasSweptLiq = false;
              continue;
            }
            
            // Check Sweep of B
            if (currentCandle.high > activeSetup.structuralLiquidity.price) {
              hasSweptLiq = true;
            }
            
            // Check OB Entry limit tap
            if (hasSweptLiq && currentCandle.high >= activeSetup.orderBlock.low) {
              const entryPrice = Math.max(activeSetup.orderBlock.low, currentCandle.open);
              const riskAmount = balance * (config.RISK_PERCENT / 100);
              const priceDistance = Math.abs(entryPrice - activeSetup.stopLoss);
              
              if (priceDistance > 0) {
                const positionUnits = riskAmount / priceDistance;
                
                activeTrade = {
                  symbol: symbol,
                  type: 'sell',
                  entryTime: currentCandle.time,
                  entryIndex: i,
                  entryPrice: entryPrice,
                  stopLoss: activeSetup.stopLoss,
                  takeProfit: entryPrice - (activeSetup.stopLoss - entryPrice) * config.REWARD_RATIO,
                  riskAmount: riskAmount,
                  positionUnits: positionUnits,
                  initialBalance: balance,
                  structuralState: {
                    A: activeSetup.protectedPoint.price,
                    B: activeSetup.structuralLiquidity.price,
                    C: activeSetup.peak.price
                  }
                };
                
                console.log(`[Backtester] 🔴 Triggered SELL trade on ${symbol} at price ${entryPrice.toFixed(2)} | SL: ${activeTrade.stopLoss.toFixed(2)} | TP: ${activeTrade.takeProfit.toFixed(2)}`);
                
                activeSetup = null;
                hasSweptLiq = false;
              }
            }
          }
        }
      } else {
        // No active setup returned
        activeSetup = null;
        hasSweptLiq = false;
      }
    }
  }

  // 3. Compile report
  const totalTrades = trades.length;
  const wins = trades.filter(t => t.result === 'win').length;
  const losses = totalTrades - wins;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  
  const totalGain = trades.filter(t => t.result === 'win').reduce((sum, t) => sum + t.profit, 0);
  const totalLoss = Math.abs(trades.filter(t => t.result === 'loss').reduce((sum, t) => sum + t.profit, 0));
  const profitFactor = totalLoss > 0 ? totalGain / totalLoss : totalGain > 0 ? Infinity : 1;
  
  const netProfit = balance - config.STARTING_BALANCE;
  const returnOnInvestment = (netProfit / config.STARTING_BALANCE) * 100;

  return {
    symbol,
    startingBalance: config.STARTING_BALANCE,
    finalBalance: balance,
    netProfit,
    roi: returnOnInvestment,
    totalTrades,
    wins,
    losses,
    winRate: parseFloat(winRate.toFixed(2)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    maxDrawdown: parseFloat((maxDrawdown * 100).toFixed(2)),
    trades,
    equityCurve
  };
}

module.exports = {
  runBacktest
};
