// runner.js
/**
 * SMC Live Fronttesting & Telegram Alert Bot.
 * Senior Institutional Quantitative Engine.
 * Streams real-time market structure sweeps, breaks of structure (BOS),
 * Fair Value Gaps (FVG), and order block taps across optimized Volatility Index pairs,
 * calculating dynamic MT5 lot sizes and 1.1 R:R Break-Even alerts.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getCandles } = require('./dataFetcher');
const { analyzeStructure } = require('./marketStructure');
const { placeTrade, monitorPositions } = require('./tradeExecutor');
const {
  recordSignal,
  recordTrigger,
  recordClose,
  generateDailyReport,
  generateWeeklyReport,
  generateMonthlyReport,
  formatReportTelegramHTML
} = require('./reportManager');


const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}
const ACTIVE_TRADES_FILE = path.join(CACHE_DIR, 'active_trades.json');

// Premium ASCII Color Codes
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";

// In-Memory Anti-Spam Duplicate Alert Prevention Caches
const alertedSetups = new Set();
const alertedEntries = new Set();
const alertedBreakEvens = new Set();

/**
 * Calculates recommended MT5 Lot Size based on $100 Risk Baseline
 * @param {string} symbol Asset symbol
 * @param {number} entryPrice Entry price
 * @param {number} stopLossPrice Stop loss price
 * @returns {string} Formatted MT5 Lot Size string
 */
function calculateLotSize(symbol, entryPrice, stopLossPrice) {
  const priceDistance = Math.abs(entryPrice - stopLossPrice);
  if (priceDistance === 0) return "0.01";
  
  const riskUSD = config.RISK_AMOUNT_USD || 100.0;
  const rawLotSize = riskUSD / priceDistance;
  
  // Format lot size based on symbol magnitude
  if (symbol.includes('1HZ50V') || symbol.includes('1HZ25V')) {
    return rawLotSize.toFixed(4);
  } else if (symbol.includes('R_75') || symbol.includes('R_100') || symbol.includes('1HZ75V') || symbol.includes('1HZ100V')) {
    return rawLotSize.toFixed(3);
  } else {
    return rawLotSize.toFixed(2);
  }
}

/**
 * Calculates simple moving average (EMA) for trend filtering
 */
function calculateEMA(prices, period) {
  const ema = [];
  if (prices.length === 0) return ema;
  
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
 * Sends a premium HTML-formatted message to the Telegram Channel/Chat
 */
function sendTelegramMessage(htmlText) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  if (!token || !chatId || token === 'YOUR_TELEGRAM_BOT_TOKEN_HERE' || chatId === 'YOUR_TELEGRAM_CHAT_ID_HERE') {
    const rawText = htmlText
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '') // Strip HTML tags
      .trim();
    console.log(`\n${BOLD}${MAGENTA}📢 [TELEGRAM MOCK ALERT (No Credentials in .env)]:${RESET}\n${rawText}\n`);
    return Promise.resolve();
  }
  
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      chat_id: chatId,
      text: htmlText,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(body));
        } else {
          reject(new Error(`Telegram HTTP ${res.statusCode}: ${body}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const PENDING_TRADES_FILE = path.join(CACHE_DIR, 'pending_trades.json');

function loadPendingTrades() {
  if (fs.existsSync(PENDING_TRADES_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(PENDING_TRADES_FILE, 'utf8'));
    } catch (e) {
      console.error("[runner] Error reading pending trades file:", e.message);
    }
  }
  return [];
}

function savePendingTrades(trades) {
  try {
    fs.writeFileSync(PENDING_TRADES_FILE, JSON.stringify(trades, null, 2), 'utf8');
  } catch (e) {
    console.error("[runner] Error writing pending trades file:", e.message);
  }
}

async function checkPendingTradesForSymbol(symbol, ltfCandles) {
  const pendingTrades = loadPendingTrades();
  const symbolPending = pendingTrades.filter(t => t.symbol === symbol);
  if (symbolPending.length === 0) return;

  const latestCandle = ltfCandles[ltfCandles.length - 1];
  let updatedPending = [...pendingTrades];
  let changed = false;

  for (const pending of symbolPending) {
    // Check if expired
    const maxAgeMs = (config.PENDING_ORDER_MAX_HOURS || 24) * 60 * 60 * 1000;
    if (Date.now() - pending.createdTime > maxAgeMs) {
      console.log(`[runner] Pending order ${pending.setupId} expired (> ${config.PENDING_ORDER_MAX_HOURS}h). Removing.`);
      updatedPending = updatedPending.filter(t => t.setupId !== pending.setupId);
      changed = true;
      continue;
    }

    // Check invalidation
    let isInvalidated = false;
    if (pending.type === 'bullish' && latestCandle.low < pending.protectedPrice) {
      isInvalidated = true;
    } else if (pending.type === 'bearish' && latestCandle.high > pending.protectedPrice) {
      isInvalidated = true;
    }

    if (isInvalidated) {
      console.log(`[runner] Pending order ${pending.setupId} invalidated. Removing.`);
      updatedPending = updatedPending.filter(t => t.setupId !== pending.setupId);
      changed = true;
      continue;
    }

    // Check entry limit tap
    let hitEntry = false;
    if (pending.type === 'bullish') {
      hitEntry = latestCandle.low <= pending.obHigh && latestCandle.low >= pending.protectedPrice;
    } else {
      hitEntry = latestCandle.high >= pending.obLow && latestCandle.high <= pending.protectedPrice;
    }

    if (hitEntry) {
      const recommendedLotSize = calculateLotSize(symbol, pending.entryPrice, pending.stopLoss);
      const entryAlertHtml = [
        `🎯 <b>[SMC LIVE TRADE TRIGGERED]</b>`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] || symbol})`,
        `<b>Type:</b> ${pending.type === 'bullish' ? '🟢 <b>BULLISH BUY LIMIT</b>' : '🔴 <b>BEARISH SELL LIMIT</b>'}`,
        `🔥 <b>Institutional Score:</b> <code>${pending.confluenceScore}/10 Points</code>`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `🔥 <b>ENTRY PRICE:</b> <code>${pending.entryPrice.toFixed(2)}</code> (OB Tapped)`,
        `🛡️ <b>STOP LOSS (SL):</b> <code>${pending.stopLoss.toFixed(2)}</code>`,
        `🏆 <b>TAKE PROFIT (TP):</b> <code>${pending.takeProfit.toFixed(2)}</code> (Strict 1:${config.REWARD_RATIO} RR)`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `💰 <b>MT5 POSITION SIZING ($${config.RISK_AMOUNT_USD} Risk):</b>`,
        `• <b>Recommended Lot Size:</b> <code>${recommendedLotSize} Lots</code>`,
        `• <b>Max Loss on SL:</b> <code>-$${config.RISK_AMOUNT_USD.toFixed(2)}</code>`,
        `• <b>Target Profit on TP:</b> <code>+$${(config.RISK_AMOUNT_USD * config.REWARD_RATIO).toFixed(2)}</code>`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `<i>⚠️ Note: SMC entry tapped. Please enter the trade manually on Metatrader 5.</i>`
      ].join('\n');

      try {
        await sendTelegramMessage(entryAlertHtml);
        console.log(`${GREEN}${BOLD}   >>> 📢 SENT TELEGRAM ENTRY ALERT FOR ${symbol}${RESET}`);
      } catch (e) {
        console.error("[runner] Failed sending entry alert:", e.message);
      }

      recordTrigger(pending.setupId);

      const activeTrades = loadActiveTrades();
      if (!activeTrades.some(t => t.setupId === pending.setupId)) {
        activeTrades.push({
          setupId: pending.setupId,
          symbol: symbol,
          type: pending.type,
          entryPrice: pending.entryPrice,
          stopLoss: pending.stopLoss,
          takeProfit: pending.takeProfit,
          triggeredTime: Date.now()
        });
        saveActiveTrades(activeTrades);
      }

      updatedPending = updatedPending.filter(t => t.setupId !== pending.setupId);
      changed = true;
    }
  }

  if (changed) {
    savePendingTrades(updatedPending);
  }
}

function loadActiveTrades() {
  if (fs.existsSync(ACTIVE_TRADES_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(ACTIVE_TRADES_FILE, 'utf8'));
    } catch (e) {
      console.error("[runner] Error reading active trades file:", e.message);
    }
  }
  return [];
}

function saveActiveTrades(trades) {
  try {
    fs.writeFileSync(ACTIVE_TRADES_FILE, JSON.stringify(trades, null, 2), 'utf8');
  } catch (e) {
    console.error("[runner] Error writing active trades file:", e.message);
  }
}

async function checkActiveTradesForSymbol(symbol, candles) {
  const activeTrades = loadActiveTrades();
  const symbolTrades = activeTrades.filter(t => t.symbol === symbol);
  if (symbolTrades.length === 0) return;

  let updatedTrades = [...activeTrades];
  let changed = false;

  for (const trade of symbolTrades) {
    let hitSL = false;
    let hitTP = false;
    let exitTime = 0;
    let exitPrice = 0;

    const postTriggerCandles = candles.filter(c => c.time >= trade.triggeredTime);
    const riskDist = Math.abs(trade.entryPrice - trade.stopLoss);
    const trigger1_1 = trade.type === 'bullish' ? trade.entryPrice + 1.1 * riskDist : trade.entryPrice - 1.1 * riskDist;

    let isBEActive = false;

    for (const candle of postTriggerCandles) {
      if (trade.type === 'bullish') {
        // Check 1.1 RR Break-Even alert for full position flow
        if (config.ENABLE_BREAK_EVEN && !alertedBreakEvens.has(trade.setupId) && candle.high >= trigger1_1) {
          alertedBreakEvens.add(trade.setupId);
          isBEActive = true;
          trade.isBEActive = true;
          const beHtml = [
            `🔒 <b>[SMC BREAK-EVEN TRAILING ALERT]</b>`,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] || symbol})`,
            `<b>Direction:</b> 🟢 BUY`,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            `🎯 <b>Price reached 1.1 R:R (+1.1R Profit)!</b>`,
            `👉 <b>Move Stop Loss on MT5 to Entry Price:</b> <code>${trade.entryPrice.toFixed(2)}</code>`,
            `🚀 <b>Full position is now 100% Risk-Free ($0.00 Risk), running for full +$200.00 TP!</b>`,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━`
          ].join('\n');
          try {
            await sendTelegramMessage(beHtml);
            console.log(`${GREEN}${BOLD}   >>> 📢 SENT TELEGRAM 1.1 RR BREAK-EVEN ALERT FOR ${symbol}${RESET}`);
          } catch (e) { console.error("[runner] Failed sending Break-Even alert:", e.message); }
        }

        if (trade.isBEActive || isBEActive) {
          if (candle.high >= trade.takeProfit) {
            hitTP = true;
            exitTime = candle.time;
            exitPrice = trade.takeProfit;
            break;
          } else if (candle.low <= trade.entryPrice) {
            hitSL = true;
            exitTime = candle.time;
            exitPrice = trade.entryPrice;
            break;
          }
        } else {
          if (candle.low <= trade.stopLoss) {
            hitSL = true;
            exitTime = candle.time;
            exitPrice = trade.stopLoss;
            break;
          } else if (candle.high >= trade.takeProfit) {
            hitTP = true;
            exitTime = candle.time;
            exitPrice = trade.takeProfit;
            break;
          }
        }
      } else { // bearish
        // Check 1.1 RR Break-Even alert for full position flow
        if (config.ENABLE_BREAK_EVEN && !alertedBreakEvens.has(trade.setupId) && candle.low <= trigger1_1) {
          alertedBreakEvens.add(trade.setupId);
          isBEActive = true;
          trade.isBEActive = true;
          const beHtml = [
            `🔒 <b>[SMC BREAK-EVEN TRAILING ALERT]</b>`,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] || symbol})`,
            `<b>Direction:</b> 🔴 SELL`,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            `🎯 <b>Price reached 1.1 R:R (+1.1R Profit)!</b>`,
            `👉 <b>Move Stop Loss on MT5 to Entry Price:</b> <code>${trade.entryPrice.toFixed(2)}</code>`,
            `🚀 <b>Full position is now 100% Risk-Free ($0.00 Risk), running for full +$200.00 TP!</b>`,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━`
          ].join('\n');
          try {
            await sendTelegramMessage(beHtml);
            console.log(`${GREEN}${BOLD}   >>> 📢 SENT TELEGRAM 1.1 RR BREAK-EVEN ALERT FOR ${symbol}${RESET}`);
          } catch (e) { console.error("[runner] Failed sending Break-Even alert:", e.message); }
        }

        if (trade.isBEActive || isBEActive) {
          if (candle.low <= trade.takeProfit) {
            hitTP = true;
            exitTime = candle.time;
            exitPrice = trade.takeProfit;
            break;
          } else if (candle.high >= trade.entryPrice) {
            hitSL = true;
            exitTime = candle.time;
            exitPrice = trade.entryPrice;
            break;
          }
        } else {
          if (candle.high >= trade.stopLoss) {
            hitSL = true;
            exitTime = candle.time;
            exitPrice = trade.stopLoss;
            break;
          } else if (candle.low <= trade.takeProfit) {
            hitTP = true;
            exitTime = candle.time;
            exitPrice = trade.takeProfit;
            break;
          }
        }
      }
    }

    if (hitSL || hitTP) {
      let outcomeHeader = "";
      let outcomeDetails = [];

      if (trade.isBEActive || isBEActive) {
        if (hitTP) {
          outcomeHeader = `🏆 <b>[SMC FULL TRADE OUTCOME: FULL WIN]</b>`;
          outcomeDetails = [
            `🟢 <b>OUTCOME: FULL 1:2 TAKE PROFIT HIT!</b>`,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            `💰 <b>TOTAL REALIZED PROFIT:</b> <code>+$200.00 USD (+2.00R)</code> (Full Position Payout!)`
          ];
        } else {
          outcomeHeader = `🔒 <b>[SMC FULL TRADE OUTCOME: BREAK-EVEN EXIT]</b>`;
          outcomeDetails = [
            `🟡 <b>OUTCOME: REVERSED TO ENTRY PRICE (BREAK-EVEN EXIT)</b>`,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            `🔒 <b>Position Closed at Entry:</b> <code>$0.00 USD</code>`,
            `🛡️ <b>TOTAL REALIZED NET LOSS:</b> <code>$0.00 USD (Zero Risk / No Loss!)</code>`
          ];
        }
      } else {
        if (hitTP) {
          outcomeHeader = `🏆 <b>[SMC FULL TRADE OUTCOME: DIRECT TP HIT]</b>`;
          outcomeDetails = [
            `🟢 <b>OUTCOME: TAKE PROFIT HIT!</b>`,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            `💰 <b>TOTAL REALIZED PROFIT:</b> <code>+$200.00 USD (+2.00R)</code>`
          ];
        } else {
          outcomeHeader = `🛡️ <b>[SMC FULL TRADE OUTCOME: STOP LOSS HIT]</b>`;
          outcomeDetails = [
            `🔴 <b>OUTCOME: STOP LOSS HIT</b>`,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            `💸 <b>TOTAL REALIZED LOSS:</b> <code>-$100.00 USD (-1.00R)</code>`
          ];
        }
      }



      const closedAlertHtml = [
        outcomeHeader,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] || symbol})`,
        `<b>Direction:</b> ${trade.type === 'bullish' ? '🟢 BUY' : '🔴 SELL'}`,
        ...outcomeDetails,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `🔥 <b>Entry Price:</b> <code>${trade.entryPrice.toFixed(2)}</code>`,
        `🛡️ <b>Stop Loss (SL):</b> <code>${trade.stopLoss.toFixed(2)}</code>`,
        `🏆 <b>Take Profit (TP):</b> <code>${trade.takeProfit.toFixed(2)}</code>`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `<i>ℹ️ Check your Metatrader 5 terminal balance sheet!</i>`
      ].join('\n');

      try {
        await sendTelegramMessage(closedAlertHtml);
        console.log(`\n${GREEN}${BOLD}   >>> 📢 SENT TELEGRAM FINAL OUTCOME ALERT FOR ${symbol}${RESET}\n`);
      } catch (telegramErr) {
        console.error("[runner] Failed sending Telegram outcome position notification:", telegramErr.message);
      }

      // Record trade outcome in persistent trade history database
      let finalOutcome = 'LOSS';
      let pnlUSD = -100.0;
      let pnlR = -1.0;
      if (trade.isBEActive || isBEActive) {
        if (hitTP) { finalOutcome = 'WIN'; pnlUSD = 200.0; pnlR = 2.0; }
        else { finalOutcome = 'BREAKEVEN'; pnlUSD = 0.0; pnlR = 0.0; }
      } else {
        if (hitTP) { finalOutcome = 'WIN'; pnlUSD = 200.0; pnlR = 2.0; }
        else { finalOutcome = 'LOSS'; pnlUSD = -100.0; pnlR = -1.0; }
      }
      recordClose(trade.setupId, finalOutcome, exitPrice, pnlUSD, pnlR);

      updatedTrades = updatedTrades.filter(t => t.setupId !== trade.setupId);
      changed = true;
    }
  }


  if (changed) {
    saveActiveTrades(updatedTrades);
  }
}


/**
 * Main Fronttesting and Setup Monitor cycle
 */
async function monitorMarket() {
  const now = new Date();
  console.log(`\n${CYAN}[${now.toLocaleTimeString()}] Scanning Live Institutional Market Structure across assets...${RESET}`);
  console.log(`-------------------------------------------------------------------------------------------------`);
  
  const symbols = Object.keys(config.SYMBOLS);
  
  for (const symbol of symbols) {
    try {
      const htfCandles = await getCandles(symbol, config.DEFAULT_HTF, 200, true);
      const htfCloses = htfCandles.map(c => c.close);
      const htfEMAs = calculateEMA(htfCloses, 50);
      const latestHtfEma = htfEMAs[htfEMAs.length - 1];
      const latestHtfClose = htfCandles[htfCandles.length - 1].close;
      
      const trendBias = latestHtfClose > latestHtfEma ? 'bullish' : 'bearish';
      
      const ltfCandles = await getCandles(symbol, config.DEFAULT_LTF, 700, true);
      const latestLtfCandle = ltfCandles[ltfCandles.length - 1];
      
      await checkActiveTradesForSymbol(symbol, ltfCandles);
      await checkPendingTradesForSymbol(symbol, ltfCandles);
      
      const analysis = analyzeStructure(ltfCandles, ltfCandles.length - 1, trendBias, symbol);
      const setup = analysis.setup;
      
      const trendSymbol = trendBias === 'bullish' ? `${GREEN}📈 BULLISH${RESET}` : `${RED}📉 BEARISH${RESET}`;
      const stateSymbol = setup ? `${YELLOW}⚡ SETUP ACTIVE (${setup.confluenceScore}/10)${RESET}` : `💤 Idle`;
      console.log(`| Symbol: ${CYAN}${symbol.padEnd(8)}${RESET} | HTF Bias: ${trendSymbol} | Status: ${stateSymbol.padEnd(25)} | Price: ${latestLtfCandle.close.toFixed(2)}`);
      
      if (setup) {
        const setupId = `${symbol}_${setup.type}_${setup.protectedPoint.time}`;
        
        const isTrendAligned = (setup.type === 'bullish' && trendBias === 'bullish') || 
                               (setup.type === 'bearish' && trendBias === 'bearish');
        
        if (isTrendAligned && setup.confluenceScore >= config.MIN_CONFLUENCE_SCORE) {
          const riskAmount = setup.entryPrice - setup.stopLoss;
          const stopLossVal = setup.stopLoss;
          let takeProfitVal;
          
          if (setup.type === 'bullish') {
            takeProfitVal = setup.entryPrice + Math.abs(riskAmount) * config.REWARD_RATIO;
          } else {
            takeProfitVal = setup.entryPrice - Math.abs(riskAmount) * config.REWARD_RATIO;
          }

          const recommendedLotSize = calculateLotSize(symbol, setup.entryPrice, stopLossVal);
          
          let hitEntry = false;
          if (setup.type === 'bullish') {
            hitEntry = latestLtfCandle.low <= setup.orderBlock.high && latestLtfCandle.low >= setup.protectedPoint.price;
          } else {
            hitEntry = latestLtfCandle.high >= setup.orderBlock.low && latestLtfCandle.high <= setup.protectedPoint.price;
          }
          
          if (hitEntry) {
            if (!alertedEntries.has(setupId)) {
              alertedEntries.add(setupId);
              
              const entryAlertHtml = [
                `🎯 <b>[SMC LIVE TRADE TRIGGERED]</b>`,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol]})`,
                `<b>Type:</b> ${setup.type === 'bullish' ? '🟢 <b>BULLISH BUY LIMIT</b>' : '🔴 <b>BEARISH SELL LIMIT</b>'}`,
                `🔥 <b>Institutional Score:</b> <code>${setup.confluenceScore}/10 Points</code>`,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                `🔥 <b>ENTRY PRICE:</b> <code>${setup.entryPrice.toFixed(2)}</code> (OB Tapped)`,
                `🛡️ <b>STOP LOSS (SL):</b> <code>${stopLossVal.toFixed(2)}</code>`,
                `🏆 <b>TAKE PROFIT (TP):</b> <code>${takeProfitVal.toFixed(2)}</code> (Strict 1:${config.REWARD_RATIO} RR)`,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                `💰 <b>MT5 POSITION SIZING ($${config.RISK_AMOUNT_USD} Risk):</b>`,
                `• <b>Recommended Lot Size:</b> <code>${recommendedLotSize} Lots</code>`,
                `• <b>Max Loss on SL:</b> <code>-$${config.RISK_AMOUNT_USD.toFixed(2)}</code>`,
                `• <b>Target Profit on TP:</b> <code>+$${(config.RISK_AMOUNT_USD * config.REWARD_RATIO).toFixed(2)}</code>`,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                `⚡ <b>SMC Coordinates:</b>`,
                `• Protected A (SL): <code>${setup.protectedPoint.price.toFixed(2)}</code>`,
                `• Liquidity B (Swept): <code>${setup.structuralLiquidity.price.toFixed(2)}</code>`,
                `• Peak C (Breakout): <code>${setup.peak.price.toFixed(2)}</code>`,
                `• HTF Bias (${config.DEFAULT_HTF.toUpperCase()}): <code>${trendBias.toUpperCase()}</code>`,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                `<i>⚠️ Note: SMC entry tapped. Please enter the trade manually on Metatrader 5.</i>`
              ].join('\n');
              
              await sendTelegramMessage(entryAlertHtml);
              console.log(`${GREEN}${BOLD}   >>> 📢 SENT TELEGRAM ENTRY ALERT FOR ${symbol}${RESET}`);

              // Record signal in persistent database
              recordSignal({
                setupId: setupId,
                symbol: symbol,
                type: setup.type,
                entryPrice: setup.entryPrice,
                stopLoss: stopLossVal,
                takeProfit: takeProfitVal,
                confluenceScore: setup.confluenceScore
              });
              recordTrigger(setupId);

              const activeTrades = loadActiveTrades();
              if (!activeTrades.some(t => t.setupId === setupId)) {
                activeTrades.push({
                  setupId: setupId,
                  symbol: symbol,
                  type: setup.type,
                  entryPrice: setup.entryPrice,
                  stopLoss: stopLossVal,
                  takeProfit: takeProfitVal,
                  triggeredTime: Date.now()
                });
                saveActiveTrades(activeTrades);
              }
            }
          } 
          else {
            const pendingTrades = loadPendingTrades();
            if (!pendingTrades.some(p => p.setupId === setupId)) {
              pendingTrades.push({
                setupId: setupId,
                symbol: symbol,
                type: setup.type,
                entryPrice: setup.entryPrice,
                stopLoss: stopLossVal,
                takeProfit: takeProfitVal,
                confluenceScore: setup.confluenceScore,
                protectedPrice: setup.protectedPoint.price,
                obHigh: setup.orderBlock.high,
                obLow: setup.orderBlock.low,
                createdTime: Date.now()
              });
              savePendingTrades(pendingTrades);
            }

            if (!alertedSetups.has(setupId)) {
              alertedSetups.add(setupId);
              
              // Record signal in persistent database
              recordSignal({
                setupId: setupId,
                symbol: symbol,
                type: setup.type,
                entryPrice: setup.entryPrice,
                stopLoss: stopLossVal,
                takeProfit: takeProfitVal,
                confluenceScore: setup.confluenceScore
              });

              
              const setupAlertHtml = [
                `🔔 <b>[SMC HIGH-PROBABILITY SETUP]</b>`,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol]})`,
                `<b>Type:</b> ${setup.type === 'bullish' ? '🟢 <b>BULLISH PENDING OB TAP</b>' : '🔴 <b>BEARISH PENDING OB TAP</b>'}`,
                `🔥 <b>Institutional Score:</b> <code>${setup.confluenceScore}/10 Points</code>`,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                `🔹 <b>ENTRY ZONE:</b> <code>${setup.entryPrice.toFixed(2)}</code> (Order Block limit)`,
                `🔹 <b>STOP LOSS:</b> <code>${stopLossVal.toFixed(2)}</code>`,
                `🔹 <b>STRICT 1:2 TP:</b> <code>${takeProfitVal.toFixed(2)}</code>`,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                `💰 <b>MT5 POSITION SIZING ($${config.RISK_AMOUNT_USD} Risk):</b>`,
                `• <b>Recommended Lot Size:</b> <code>${recommendedLotSize} Lots</code>`,
                `• <b>Max Loss on SL:</b> <code>-$${config.RISK_AMOUNT_USD.toFixed(2)}</code>`,
                `• <b>Target Profit on TP:</b> <code>+$${(config.RISK_AMOUNT_USD * config.REWARD_RATIO).toFixed(2)}</code>`,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                `📊 <b>Market Structure State:</b>`,
                `• Protected Extremity A: <code>${setup.protectedPoint.price.toFixed(2)}</code>`,
                `• Liquidity Sweep B: <code>${setup.structuralLiquidity.price.toFixed(2)}</code>`,
                `• Structural Peak C: <code>${setup.peak.price.toFixed(2)}</code>`,
                `• HTF Trend Bias (${config.DEFAULT_HTF.toUpperCase()}): <code>${trendBias.toUpperCase()}</code>`,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                `<i>🕒 Waiting for price pullback to sweep liquidity point B and tap the entry corridor... Set your limit alerts!</i>`
              ].join('\n');
              
              await sendTelegramMessage(setupAlertHtml);
              console.log(`${YELLOW}${BOLD}   >>> 📢 SENT TELEGRAM SETUP PENDING ALERT FOR ${symbol}${RESET}`);
            }
          }
        }
      }
    } catch (err) {
      console.warn(`⚠️ Warning: Failed scanning symbol ${symbol}:`, err.message);
    }
  }
  
  console.log(`-------------------------------------------------------------------------------------------------`);
  console.log(`💤 Scan completed. Listening to live feeds... Next scan in 30 seconds.`);
}

/**
 * CLI Entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const isTest = args.includes('--test');
  const isDailyReport = args.includes('--daily-report');
  const isWeeklyReport = args.includes('--weekly-report');
  const isMonthlyReport = args.includes('--monthly-report');

  if (isDailyReport) {
    console.log(`\n📊 Generating and dispatching End-of-Day Performance Report to Telegram...`);
    const report = generateDailyReport();
    const html = formatReportTelegramHTML(report);
    await sendTelegramMessage(html);
    console.log(`${GREEN}✅ SUCCESS: End-of-Day Report dispatched to Telegram!${RESET}`);
    process.exit(0);
  }

  if (isWeeklyReport) {
    console.log(`\n📊 Generating and dispatching End-of-Week Performance Report to Telegram...`);
    const report = generateWeeklyReport();
    const html = formatReportTelegramHTML(report);
    await sendTelegramMessage(html);
    console.log(`${GREEN}✅ SUCCESS: End-of-Week Report dispatched to Telegram!${RESET}`);
    process.exit(0);
  }

  if (isMonthlyReport) {
    console.log(`\n📊 Generating and dispatching End-of-Month Performance Report to Telegram...`);
    const report = generateMonthlyReport();
    const html = formatReportTelegramHTML(report);
    await sendTelegramMessage(html);
    console.log(`${GREEN}✅ SUCCESS: End-of-Month Report dispatched to Telegram!${RESET}`);
    process.exit(0);
  }
  
  if (isTest) {

    console.log(`\n${BOLD}${CYAN}======================================================`);
    console.log(`🧪 TESTING TELEGRAM BOT NOTIFICATIONS CONNECTION...`);
    console.log(`======================================================${RESET}\n`);
    console.log(`Injected Bot Token: ${process.env.TELEGRAM_BOT_TOKEN ? '✅ LOADED' : '❌ MISSING'}`);
    console.log(`Injected Chat ID  : ${process.env.TELEGRAM_CHAT_ID ? '✅ LOADED' : '❌ MISSING'}`);
    console.log(`------------------------------------------------------`);
    
    const mockHtml = [
      `🔔 <b>[VIX-BOT TELEGRAM TESTING CHANNEL]</b>`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🎉 <b>Congratulations!</b> Your live Telegram Alert Channel is now <b>100% operational</b>!`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🤖 <b>Bot Status:</b> Active & Running 24/7 on VPS`,
      `🚀 <b>Optimized Pairs:</b> Active Volatility Indices`,
      `📊 <b>Target System:</b> Institutional SMC 1:2 RR + 1.1 RR Break-Even Alerts`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `<i>This is a mock alert confirming that your environment credentials are correct. Real-time signals will stream below!</i>`
    ].join('\n');
    
    try {
      await sendTelegramMessage(mockHtml);
      console.log(`\n${GREEN}${BOLD}✅ SUCCESS: Test Telegram message dispatched successfully! Check your phone!${RESET}\n`);
    } catch (err) {
      console.error(`\n${RED}${BOLD}❌ ERROR: Telegram Bot API connection failed!${RESET}`);
      console.error(err.message);
      console.log(`\n👉 Tip: Ensure process.env.TELEGRAM_BOT_TOKEN and process.env.TELEGRAM_CHAT_ID are correctly configured in your .env file.\n`);
    }
    process.exit(0);
  }
  
  console.log(`\n${BOLD}${CYAN}=================================================================================================`);
  console.log(`🤖 ALGO MARKET STRUCTURE (SMC) LIVE TELEGRAM ALERT ENGINE`);
  console.log(`=================================================================================================${RESET}`);
  console.log(`Timeframe Settings: LTF = ${config.DEFAULT_LTF} | HTF Filter = ${config.DEFAULT_HTF} (50 EMA)`);
  console.log(`Risk Settings: Risk Amount = $${config.RISK_AMOUNT_USD} | Target Reward-to-Risk = ${config.REWARD_RATIO}:1`);
  console.log(`Institutional Filters: ATR(14) SL | FVG Displacement | Min Score: 7/10 | 1.1 RR Break-Even Alerts`);
  console.log(`Bot Mode: Live Polling & Active Fronttesting Alert System`);
  console.log(`Status: Active and Listening 24/7 for optimized setups...`);
  console.log(`-------------------------------------------------------------------------------------------------`);
  
  setInterval(monitorMarket, 30000);
  monitorMarket();
}

main().catch(err => {
  console.error("Fatal Runner Error:", err);
});

