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

const WS_OPTIONS = {
  headers: {
    'Origin': 'https://app.deriv.com',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
};

const DERIV_ENDPOINTS = [
  config.DERIV_WS_URL || 'wss://red.derivws.com/websockets/v3?app_id=1089',
  'wss://red.derivws.com/websockets/v3?app_id=1089',
  'wss://blue.derivws.com/websockets/v3?app_id=1089',
  'wss://green.derivws.com/websockets/v3?app_id=1089',
  'wss://ws.derivws.com/websockets/v3?app_id=1089'
];

function fetchCandlesFromSingleEndpoint(url, symbol, granularity, count, end = 'latest') {
  return new Promise((resolve, reject) => {
    let isFinished = false;
    const ws = new WebSocket(url, WS_OPTIONS);

    const timeout = setTimeout(() => {
      if (!isFinished) {
        isFinished = true;
        try { ws.terminate(); } catch(e){}
        reject(new Error(`Timeout connecting to ${url}`));
      }
    }, 10000);

    const cleanup = () => {
      if (isFinished) return;
      isFinished = true;
      clearTimeout(timeout);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try { ws.close(); } catch(e){}
      }
    };

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
          return reject(new Error(`Deriv API Error: ${response.error.message}`));
        }
        if (response.msg_type === 'candles') {
          cleanup();
          const rawCandles = response.candles || [];
          const formattedCandles = rawCandles.map(c => ({
            time: c.epoch * 1000,
            open: parseFloat(c.open),
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            close: parseFloat(c.close)
          }));
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
  });
}

async function fetchCandlesWithFallback(symbol, granularity, count, end = 'latest') {
  let lastErr;
  for (const ep of DERIV_ENDPOINTS) {
    try {
      const candles = await fetchCandlesFromSingleEndpoint(ep, symbol, granularity, count, end);
      if (candles && candles.length > 0) {
        return candles;
      }
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw lastErr || new Error(`All Deriv endpoints failed for ${symbol}`);
}

/**
 * Fetches historical candles from Deriv WS API or loads from local cache.
 * @param {string} symbol Asset Symbol (e.g., 'R_75')
 * @param {string} timeframe Timeframe (e.g., '15m', '4h')
 * @param {number} count Number of candles to fetch (Max: 5000)
 * @param {boolean} forceRefresh If true, bypasses the cache and fetches new data
 * @returns {Promise<Array>} List of candles
 */
async function getCandles(symbol, timeframe, count = 5000, forceRefresh = false) {
  const granularity = timeframeToSeconds(timeframe);
  const cachePath = path.join(CACHE_DIR, `${symbol}_${timeframe}_${count}.json`);
  
  // Check cache first
  if (!forceRefresh && fs.existsSync(cachePath)) {
    try {
      const cachedData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (Array.isArray(cachedData) && cachedData.length > 0) {
        return cachedData;
      }
    } catch (err) {
      console.warn(`[Cache Warning] Failed to read cache for ${symbol} (${timeframe}):`, err.message);
    }
  }

  const formattedCandles = await fetchCandlesWithFallback(symbol, granularity, count, 'latest');
  fs.writeFileSync(cachePath, JSON.stringify(formattedCandles, null, 2), 'utf8');
  return formattedCandles;
}

function fetchCandleChunk(symbol, granularity, count, end) {
  return fetchCandlesWithFallback(symbol, granularity, count, end);
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
