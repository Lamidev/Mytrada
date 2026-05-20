// server.js
/**
 * Express Web Server to orchestrate multi-pair backtesting 
 * and serve the interactive glassmorphic web dashboard.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { getCandles } = require('./dataFetcher');
const { runBacktest } = require('./backtester');

const app = express();
const PORT = process.env.PORT || 4000;

const CACHE_FILE = path.join(__dirname, 'cache', 'backtest_results.json');

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Cache of backtest results to prevent re-running heavy computations
let cachedResults = null;

app.get('/api/run-all', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';
  
  if (!cachedResults && !forceRefresh && fs.existsSync(CACHE_FILE)) {
    try {
      console.log("[Server] Loading backtest results from file cache...");
      cachedResults = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } catch (err) {
      console.warn("[Server Warning] Failed to load file-based results cache:", err.message);
    }
  }
  
  if (cachedResults && !forceRefresh) {
    console.log("[Server] Serving cached multi-pair backtest results.");
    return res.json(cachedResults);
  }
  
  console.log("[Server] Initiating multi-pair algorithmic backtesting...");
  const symbols = Object.keys(config.SYMBOLS);
  const reports = [];
  
  try {
    // Process all pairs
    for (const symbol of symbols) {
      try {
        // Fetch Lower Timeframe candles (15m, 1000 candles) for rapid execution
        const ltfCandles = await getCandles(symbol, config.DEFAULT_LTF, 2000, forceRefresh);
        
        // Fetch Higher Timeframe candles (4h) for trend filter
        const htfCandles = await getCandles(symbol, config.DEFAULT_HTF, 500, forceRefresh);
        
        // Run backtest
        const report = runBacktest(symbol, ltfCandles, htfCandles);
        
        // Add human-readable name
        report.name = config.SYMBOLS[symbol];
        
        reports.push(report);
      } catch (err) {
        console.error(`[Server Error] Failed backtesting for ${symbol}:`, err.message);
      }
    }
    
    // Compute Global Consolidated Metrics
    const totalTrades = reports.reduce((sum, r) => sum + r.totalTrades, 0);
    const totalWins = reports.reduce((sum, r) => sum + r.wins, 0);
    const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
    
    const netProfit = reports.reduce((sum, r) => sum + r.netProfit, 0);
    const totalROI = (netProfit / (config.STARTING_BALANCE * reports.length)) * 100;
    
    const maxDrawdown = Math.max(...reports.map(r => r.maxDrawdown));
    
    const profitFactors = reports.filter(r => isFinite(r.profitFactor) && r.profitFactor > 0).map(r => r.profitFactor);
    const avgProfitFactor = profitFactors.length > 0 ? profitFactors.reduce((sum, val) => sum + val, 0) / profitFactors.length : 1;
    
    // Sort reports by ROI descending to establish ranking
    reports.sort((a, b) => b.roi - a.roi);
    
    cachedResults = {
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
    
    // Save to persistent file cache to enable instant loading on server start
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cachedResults, null, 2), 'utf8');
      console.log("[Server] Saved consolidated backtest results to persistent cache file.");
    } catch (err) {
      console.warn("[Server Warning] Failed to write backtest results to file:", err.message);
    }
    
    console.log("[Server] Multi-pair backtest run completed successfully.");
    res.json(cachedResults);
  } catch (err) {
    console.error("[Server Error] Main backtest execution failed:", err);
    res.status(500).json({ error: "Backtest run failed: " + err.message });
  }
});

// Expose endpoint to fetch cached candles for charting
app.get('/api/candles', async (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol) {
    return res.status(400).json({ error: "Missing symbol parameter" });
  }
  
  try {
    const candles = await getCandles(symbol, config.DEFAULT_LTF, 2000, false);
    res.json(candles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve the dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🤖 Volatility Trading Bot Dashboard Server Online!`);
  console.log(`🔗 Access Dashboard: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
