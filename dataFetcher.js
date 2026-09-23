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

const DERIV_ENDPOINTS = Array.from(new Set([
  config.DERIV_WS_URL || 'wss://ws.derivws.com/websockets/v3?app_id=16929',
  'wss://ws.derivws.com/websockets/v3?app_id=16929',
  'wss://frontend.derivws.com/websockets/v3?app_id=1089',
  'wss://blue.derivws.com/websockets/v3?app_id=1089',
  'wss://green.derivws.com/websockets/v3?app_id=1089',
  'wss://ws.binaryws.com/websockets/v3?app_id=1089'
]));

class DerivWsClient {
  constructor(endpoints) {
    this.endpoints = endpoints;
    this.endpointIdx = 0;
    this.ws = null;
    this.connected = false;
    this.connecting = false;
    this.connectWaiters = [];
    this.reqId = 1;
    this.pending = new Map();
    this.pingInterval = null;
  }

  async ensureConnected() {
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) {
      return new Promise((resolve, reject) => this.connectWaiters.push({ resolve, reject }));
    }
    return this.connect();
  }

  connect() {
    this.connecting = true;
    const url = this.endpoints[this.endpointIdx];

    return new Promise((resolve, reject) => {
      let isDone = false;
      const timeout = setTimeout(() => {
        if (!isDone) {
          isDone = true;
          this.cleanup();
          this.rotateEndpoint();
          reject(new Error(`Timeout connecting to ${url}`));
        }
      }, 8000);

      try {
        this.ws = new WebSocket(url, { handshakeTimeout: 6000 });
      } catch (err) {
        clearTimeout(timeout);
        this.rotateEndpoint();
        return reject(err);
      }

      this.ws.on('open', () => {
        if (isDone) return;
        isDone = true;
        clearTimeout(timeout);
        this.connected = true;
        this.connecting = false;

        // Keep-alive ping every 25s to keep WebSocket tunnel open
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ ping: 1 }));
          }
        }, 25000);

        resolve();
        const waiters = this.connectWaiters;
        this.connectWaiters = [];
        waiters.forEach(w => w.resolve());
      });

      this.ws.on('message', (data) => {
        try {
          const res = JSON.parse(data.toString());
          if (res.req_id && this.pending.has(res.req_id)) {
            const { resolve: pResolve, reject: pReject, timer } = this.pending.get(res.req_id);
            clearTimeout(timer);
            this.pending.delete(res.req_id);

            if (res.error) {
              return pReject(new Error(`Deriv API Error: ${res.error.message}`));
            }
            return pResolve(res);
          }
        } catch (e) {}
      });

      this.ws.on('error', (err) => {
        if (!isDone) {
          isDone = true;
          clearTimeout(timeout);
          this.cleanup();
          this.rotateEndpoint();
          reject(err);
        } else {
          this.cleanup();
          this.rotateEndpoint();
        }
      });

      this.ws.on('close', () => {
        this.cleanup();
        this.rotateEndpoint();
      });
    });
  }

  rotateEndpoint() {
    this.endpointIdx = (this.endpointIdx + 1) % this.endpoints.length;
  }

  cleanup() {
    this.connected = false;
    this.connecting = false;
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    for (const [id, req] of this.pending.entries()) {
      clearTimeout(req.timer);
      req.reject(new Error('Connection closed before response'));
    }
    this.pending.clear();
    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    waiters.forEach(w => w.reject(new Error('Connection failed')));
    if (this.ws) {
      try { this.ws.terminate(); } catch(e){}
      this.ws = null;
    }
  }

  async request(payload, timeoutMs = 8000) {
    let attempts = 2;
    let lastErr;

    while (attempts > 0) {
      try {
        await this.ensureConnected();

        const id = this.reqId++;
        const fullPayload = { ...payload, req_id: id };

        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (this.pending.has(id)) {
              this.pending.delete(id);
              this.cleanup();
              this.rotateEndpoint();
              reject(new Error(`Deriv API request timeout (${timeoutMs}ms)`));
            }
          }, timeoutMs);

          this.pending.set(id, { resolve, reject, timer });

          try {
            this.ws.send(JSON.stringify(fullPayload));
          } catch (err) {
            clearTimeout(timer);
            this.pending.delete(id);
            this.cleanup();
            this.rotateEndpoint();
            reject(err);
          }
        });
      } catch (err) {
        lastErr = err;
        attempts--;
        if (attempts > 0) {
          await new Promise(r => setTimeout(r, 400));
        }
      }
    }

    throw lastErr;
  }
}

const globalClient = new DerivWsClient(DERIV_ENDPOINTS);

function fetchCandlesFromSingleEndpoint(url, symbol, granularity, count, end = 'latest') {
  return new Promise((resolve, reject) => {
    let isFinished = false;
    const ws = new WebSocket(url, { handshakeTimeout: 5000 });

    const timeout = setTimeout(() => {
      if (!isFinished) {
        isFinished = true;
        try { ws.terminate(); } catch(e){}
        reject(new Error(`Timeout connecting to ${url}`));
      }
    }, 8000);

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
  // 1. Fast path: Use persistent client (zero new TLS handshakes, no rate limits, sub-100ms response)
  try {
    const res = await globalClient.request({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: count,
      end: end,
      style: "candles",
      granularity: granularity
    }, 7000);

    if (res.msg_type === 'candles' && Array.isArray(res.candles) && res.candles.length > 0) {
      return res.candles.map(c => ({
        time: c.epoch * 1000,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close)
      }));
    }
  } catch (err) {
    // If persistent client is rotating, fallback gracefully
  }

  // 2. Direct fallback across available endpoints
  let lastErr;
  for (const ep of DERIV_ENDPOINTS) {
    try {
      const candles = await fetchCandlesFromSingleEndpoint(ep, symbol, granularity, count, end);
      if (candles && candles.length > 0) {
        return candles;
      }
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 200));
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
