// generateCache.js
/**
5:  * Helper script to rapidly compile the backtest results using existing 
6:  * cached historical candle JSON files and generate the persistent backtest database.
7:  */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getCandles } = require('./dataFetcher');
const { runBacktest } = require('./backtester');

const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'backtest_results.json');

async function generate() {
  console.log("⚡ Rapidly compiling backtest persistent cache database...");
  
  const symbols = Object.keys(config.SYMBOLS);
  const reports = [];
  
  try {
    for (const symbol of symbols) {
      console.log(`- Processing ${symbol} (${config.SYMBOLS[symbol]})`);
      
      // Load candles (rely on existing cached files to execute in milliseconds)
      const ltfCandles = await getCandles(symbol, config.DEFAULT_LTF, 2000, false);
      const htfCandles = await getCandles(symbol, config.DEFAULT_HTF, 500, false);
      
      // Run backtest
      const report = runBacktest(symbol, ltfCandles, htfCandles);
      report.name = config.SYMBOLS[symbol];
      reports.push(report);
    }
    
    // Compile global consolidated statistics
    const totalTrades = reports.reduce((sum, r) => sum + r.totalTrades, 0);
    const totalWins = reports.reduce((sum, r) => sum + r.wins, 0);
    const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
    const netProfit = reports.reduce((sum, r) => sum + r.netProfit, 0);
    const totalROI = (netProfit / (config.STARTING_BALANCE * reports.length)) * 100;
    const maxDrawdown = Math.max(...reports.map(r => r.maxDrawdown));
    
    const profitFactors = reports.filter(r => isFinite(r.profitFactor) && r.profitFactor > 0).map(r => r.profitFactor);
    const avgProfitFactor = profitFactors.length > 0 ? profitFactors.reduce((sum, val) => sum + val, 0) / profitFactors.length : 1;
    
    reports.sort((a, b) => b.roi - a.roi);
    
    const results = {
      global: {
        totalTrades,
        wins: totalWins,
        losses: totalTrades - totalWins,
        winRate: parseFloat(winRate.toFixed(2)),
        netProfit: parseFloat(netProfit.toFixed(2)),
        roi: parseFloat(totalROI.toFixed(2)),
        maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
        avgProfitFactor: parseFloat(avgProfitFactor.toFixed(2)),
        startingBalance: config.STARTING_BALANCE * reports.length,
        pairsCount: reports.length
      },
      pairs: reports
    };
    
    fs.writeFileSync(CACHE_FILE, JSON.stringify(results, null, 2), 'utf8');
    console.log(`\n🎉 Success! Persistent cache database successfully created at:\n${CACHE_FILE}`);
    console.log(`Consolidated ROI: ${totalROI.toFixed(2)}% | Win Rate: ${winRate.toFixed(2)}% | Total Trades: ${totalTrades}`);
  } catch (err) {
    console.error("❌ Failed to compile persistent cache database:", err);
  }
}

generate();
