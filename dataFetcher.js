// dataFetcher.js
/**
 * Utility to fetch historical candle data from Deriv's public WebSocket API
 * and manage a local cache in the filesystem to prevent redundant requests.
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const CACHE_DIR = path.join(__dirname, 'cache');

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/**
 * Converts timeframe string (e.g. '15m', '4h') to seconds (granularity)
 * @param {string} tf Timeframe
 * @returns {number} Granularity in seconds
 */
function timeframeToSeconds(tf) {
  const match = tf.match(/^(\d+)([mhdw])$/);
  if (!match) {
    throw new Error(`Invalid timeframe format: ${tf}. Examples: '15m', '4h', '1d'`);
  }
  
  const value = parseInt(match[1]);
  const unit = match[2];
  
  switch (unit) {
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    case 'w': return value * 86400 * 7;
    default: throw new Error(`Unknown timeframe unit: ${unit}`);
  }
}

/**
 * Fetches historical candles from Deriv WS API or loads from local cache.
 * @param {string} symbol Asset Symbol (e.g., 'R_75')
 * @param {string} timeframe Timeframe (e.g., '15m', '4h')
 * @param {number} count Number of candles to fetch (Max: 5000)
 * @param {boolean} forceRefresh If true, bypasses the cache and fetches new data
 * @returns {Promise<Array>} List of candles
 */
function getCandles(symbol, timeframe, count = 5000, forceRefresh = false) {
  return new Promise((resolve, reject) => {
    const granularity = timeframeToSeconds(timeframe);
    const cachePath = path.join(CACHE_DIR, `${symbol}_${timeframe}_${count}.json`);
    
    // Check cache first
    if (!forceRefresh && fs.existsSync(cachePath)) {
      try {
        const cachedData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        // Verify cache integrity
        if (Array.isArray(cachedData) && cachedData.length > 0) {
          // console.log(`[Cache] Loaded ${cachedData.length} candles for ${symbol} (${timeframe})`);
          return resolve(cachedData);
        }
      } catch (err) {
        console.warn(`[Cache Warning] Failed to read cache for ${symbol} (${timeframe}):`, err.message);
      }
    }
    
    console.log(`[API] Fetching ${count} candles from Deriv WS for ${symbol} (${timeframe})...`);
    
    const ws = new WebSocket(config.DERIV_WS_URL);
    
    let isFinished = false;
    const timeout = setTimeout(() => {
      if (!isFinished) {
        isFinished = true;
        ws.terminate();
        reject(new Error(`Timeout: Deriv WebSocket connection timed out after 15 seconds.`));
      }
    }, 15000);
    
    ws.on('open', () => {
      const request = {
        ticks_history: symbol,
        adjust_start_time: 1,
        count: count,
        end: "latest",
        style: "candles",
        granularity: granularity
      };
      ws.send(JSON.stringify(request));
    });
    
    ws.on('message', (data) => {
      try {
        const response = JSON.parse(data.toString());
        
        if (response.error) {
          cleanup();
          return reject(new Error(`Deriv API Error: ${response.error.message}`));
        }
        
        if (response.msg_type === 'candles') {
          cleanup();
          const rawCandles = response.candles || [];
          
          // Map candles to standard format
          const formattedCandles = rawCandles.map(c => ({
            time: c.epoch * 1000, // Convert to milliseconds for standard JS date manipulation
            open: parseFloat(c.open),
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            close: parseFloat(c.close),
            // Deriv candles include close epoch and open epoch, we calculate mid points
          }));
          
          // Save to cache
          fs.writeFileSync(cachePath, JSON.stringify(formattedCandles, null, 2), 'utf8');
          console.log(`[API] Successfully saved ${formattedCandles.length} candles to cache for ${symbol} (${timeframe})`);
          
          resolve(formattedCandles);
        }
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
    
    ws.on('error', (err) => {
      cleanup();
      reject(err);
    });
    
    ws.on('close', () => {
      cleanup();
      if (!isFinished) {
        reject(new Error("WebSocket closed prematurely."));
      }
    });
    
    function cleanup() {
      if (isFinished) return;
      isFinished = true;
      clearTimeout(timeout);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
  });
}

function fetchCandleChunk(symbol, granularity, count, end) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(config.DERIV_WS_URL);
    let isFinished = false;
    
    const timeout = setTimeout(() => {
      if (!isFinished) {
        isFinished = true;
        ws.terminate();
        reject(new Error(`Timeout: WebSocket timed out fetching chunk for ${symbol}`));
      }
    }, 12000);
    
    ws.on('open', () => {
      const request = {
        ticks_history: symbol,
        adjust_start_time: 1,
        count: count,
        end: end,
        style: "candles",
        granularity: granularity
      };
      ws.send(JSON.stringify(request));
    });
    
    ws.on('message', (data) => {
      try {
        const response = JSON.parse(data.toString());
        if (response.error) {
          cleanup();
          return reject(new Error(response.error.message));
        }
        if (response.msg_type === 'candles') {
          cleanup();
          const raw = response.candles || [];
          const formatted = raw.map(c => ({
            time: c.epoch * 1000,
            open: parseFloat(c.open),
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            close: parseFloat(c.close)
          }));
          resolve(formatted);
        }
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
    
    ws.on('error', (err) => {
      cleanup();
      reject(err);
    });
    
    ws.on('close', () => {
      cleanup();
      if (!isFinished) {
        reject(new Error("WebSocket closed prematurely."));
      }
    });
    
    function cleanup() {
      if (isFinished) return;
      isFinished = true;
      clearTimeout(timeout);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
  });
}

function fetchCandlesInChunks(symbol, granularity, targetCount) {
  return new Promise(async (resolve, reject) => {
    let allCandles = [];
    let currentEnd = "latest";
    const chunkSize = 4500;
    
    while (allCandles.length < targetCount) {
      const remaining = targetCount - allCandles.length;
      const countToFetch = Math.min(chunkSize, remaining);
      
      let chunk;
      let retries = 3;
      let success = false;
      let lastErr;
      
      while (retries > 0 && !success) {
        try {
          chunk = await fetchCandleChunk(symbol, granularity, countToFetch, currentEnd);
          success = true;
        } catch (err) {
          lastErr = err;
          retries--;
          if (retries > 0) {
            console.log(`    ⚠️ Timeout or connection issue for ${symbol}. Retrying in 2s... (${retries} attempts left)`);
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      }
      
      if (!success) {
        return reject(new Error(`Failed to fetch chunk for ${symbol} after multiple retries. Last error: ${lastErr.message}`));
      }
      
      if (chunk.length === 0) {
        break; // No more historical data available
      }
      
      allCandles = chunk.concat(allCandles);
      
      const oldestEpoch = chunk[0].time / 1000;
      currentEnd = oldestEpoch - 1;
      
      console.log(`  - Downloaded historical chunk: ${chunk.length} candles (Total: ${allCandles.length}/${targetCount})`);
      
      await new Promise(r => setTimeout(r, 300)); // Increase throttle delay to be gentle on Deriv rate limits
    }
    
    resolve(allCandles);
  });
}

async function getHistoricalCandles(symbol, timeframe, months = 6, forceRefresh = false) {
  const granularity = timeframeToSeconds(timeframe);
  const candlesPerDay = 86400 / granularity;
  const targetCount = Math.ceil(candlesPerDay * 30 * months);
  
  const cachePath = path.join(CACHE_DIR, `${symbol}_${timeframe}_hist_${months}M.json`);
  
  if (!forceRefresh && fs.existsSync(cachePath)) {
    try {
      const cachedData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (Array.isArray(cachedData) && cachedData.length > 0) {
        return cachedData;
      }
    } catch (err) {
      console.warn(`[Cache Warning] Failed reading historical cache for ${symbol}:`, err.message);
    }
  }
  
  console.log(`[API] Downloading rigorous ${months}-month history (~${targetCount} candles) for ${symbol} (${timeframe})...`);
  
  const allCandles = await fetchCandlesInChunks(symbol, granularity, targetCount);
  
  fs.writeFileSync(cachePath, JSON.stringify(allCandles, null, 2), 'utf8');
  console.log(`[API] Successfully saved ${allCandles.length} historical candles to cache for ${symbol}`);
  
  return allCandles;
}

module.exports = {
  getCandles,
  timeframeToSeconds,
  getHistoricalCandles
};
