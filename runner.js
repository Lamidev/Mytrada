// runner.js
/**
 * SMC Live Fronttesting & Telegram Alert Bot.
 * Streams real-time market structure sweeps, breaks of structure (BOS),
 * and order block taps across our top 6 optimized Volatility Index pairs,
 * sending premium alerts directly to your phone 24/7.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getCandles } = require('./dataFetcher');
const { analyzeStructure } = require('./marketStructure');
const { placeTrade, monitorPositions } = require('./tradeExecutor');

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
  
  // Console-Only fallback if Telegram credentials are not yet configured
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

    // Get all candles that have occurred since the trade was triggered
    const postTriggerCandles = candles.filter(c => c.time >= trade.triggeredTime);

    for (const candle of postTriggerCandles) {
      if (trade.type === 'bullish') {
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
      } else { // bearish
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

    if (hitSL || hitTP) {
      const outcomeText = hitTP 
        ? `🏆 <b>TAKE PROFIT (TP) HIT!</b>` 
        : `🛡️ <b>STOP LOSS (SL) HIT!</b>`;
      const outcomeEmoji = hitTP ? '🏆' : '🛡️';
      
      const closedAlertHtml = [
        `${outcomeEmoji} <b>[SMC TRADE OUTCOME]</b>`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] || symbol})`,
        `<b>Direction:</b> ${trade.type === 'bullish' ? '🟢 BUY' : '🔴 SELL'}`,
        `<b>Outcome:</b> ${outcomeText}`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `🔥 <b>Entry Price:</b> <code>${trade.entryPrice.toFixed(2)}</code>`,
        `🛡️ <b>Stop Loss (SL):</b> <code>${trade.stopLoss.toFixed(2)}</code>`,
        `🏆 <b>Take Profit (TP):</b> <code>${trade.takeProfit.toFixed(2)}</code>`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `<i>ℹ️ Check your Metatrader 5 account terminal to verify your manual position!</i>`
      ].join('\n');

      try {
        await sendTelegramMessage(closedAlertHtml);
        console.log(`\n${GREEN}${BOLD}   >>> 📢 SENT TELEGRAM POSITION OUTCOME ALERT FOR ${symbol}: ${hitTP ? 'TP' : 'SL'}${RESET}\n`);
      } catch (telegramErr) {
        console.error("[runner] Failed sending Telegram outcome position notification:", telegramErr.message);
      }

      // Remove from active list
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
  console.log(`\n${CYAN}[${now.toLocaleTimeString()}] Scanning Live Market Structure across top 6 assets...${RESET}`);
  console.log(`-------------------------------------------------------------------------------------------------`);
  
  const symbols = Object.keys(config.SYMBOLS);
  
  for (const symbol of symbols) {
    try {
      // 1. Fetch 200 candles on HTF (4h) to compute 50-EMA trend bias
      const htfCandles = await getCandles(symbol, config.DEFAULT_HTF, 200, true);
      const htfCloses = htfCandles.map(c => c.close);
      const htfEMAs = calculateEMA(htfCloses, 50);
      const latestHtfEma = htfEMAs[htfEMAs.length - 1];
      const latestHtfClose = htfCandles[htfCandles.length - 1].close;
      
      const trendBias = latestHtfClose > latestHtfEma ? 'bullish' : 'bearish';
      
      // 2. Fetch 700 candles on LTF (15m) to analyze SMC structure
      const ltfCandles = await getCandles(symbol, config.DEFAULT_LTF, 700, true);
      const latestLtfCandle = ltfCandles[ltfCandles.length - 1];
      
      // Monitor active virtual trades for this symbol
      await checkActiveTradesForSymbol(symbol, ltfCandles);
      
      // 3. Analyze structural states
      const analysis = analyzeStructure(ltfCandles, ltfCandles.length - 1);
      const setup = analysis.setup;
      
      // Output premium terminal monitoring logs
      const trendSymbol = trendBias === 'bullish' ? `${GREEN}📈 BULLISH${RESET}` : `${RED}📉 BEARISH${RESET}`;
      const stateSymbol = setup ? `${YELLOW}⚡ SETUP ACTIVE${RESET}` : `💤 Idle`;
      console.log(`| Symbol: ${CYAN}${symbol.padEnd(8)}${RESET} | HTF Bias: ${trendSymbol} | Status: ${stateSymbol.padEnd(20)} | Price: ${latestLtfCandle.close.toFixed(2)}`);
      
      if (setup) {
        const setupId = `${symbol}_${setup.type}_${setup.protectedPoint.time}`;
        
        // A. Verify HTF Trend Alignment
        const isTrendAligned = (setup.type === 'bullish' && trendBias === 'bullish') || 
                               (setup.type === 'bearish' && trendBias === 'bearish');
        
        if (isTrendAligned) {
          // Calculate strict 1:2 RR Stop-Loss and Take Profit limit coordinates (equivalent to backtester)
          const riskAmount = setup.entryPrice - setup.stopLoss;
          const stopLossVal = setup.stopLoss;
          let takeProfitVal;
          
          if (setup.type === 'bullish') {
            takeProfitVal = setup.entryPrice + Math.abs(riskAmount) * config.REWARD_RATIO;
          } else {
            takeProfitVal = setup.entryPrice - Math.abs(riskAmount) * config.REWARD_RATIO;
          }
          
          // B. Evaluate Stage 2: Trade Entry Triggered Alert
          // Triggers when price sweeps B and taps the Order Block zone in the current candle
          let hitEntry = false;
          if (setup.type === 'bullish') {
            hitEntry = latestLtfCandle.low <= setup.orderBlock.high && latestLtfCandle.low >= setup.protectedPoint.price;
          } else {
            hitEntry = latestLtfCandle.high >= setup.orderBlock.low && latestLtfCandle.high <= setup.protectedPoint.price;
          }
          
          if (hitEntry) {
            if (!alertedEntries.has(setupId)) {
              alertedEntries.add(setupId);
              
              // Generate premium HTML Alert
              const entryAlertHtml = [
                `🎯 <b>[SMC LIVE TRADE TRIGGERED]</b>`,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol]})`,
                `<b>Type:</b> ${setup.type === 'bullish' ? '🟢 <b>BULLISH BUY LIMIT</b>' : '🔴 <b>BEARISH SELL LIMIT</b>'}`,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                `🔥 <b>ENTRY PRICE:</b> <code>${setup.entryPrice.toFixed(2)}</code> (OB Tapped)`,
                `🛡️ <b>STOP LOSS (SL):</b> <code>${stopLossVal.toFixed(2)}</code>`,
                `🏆 <b>TAKE PROFIT (TP):</b> <code>${takeProfitVal.toFixed(2)}</code> (Strict 1:${config.REWARD_RATIO} RR)`,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                `⚡ <b>SMC Coordinates:</b>`,
                `• Protected A (SL): <code>${setup.protectedPoint.price.toFixed(2)}</code>`,
                `• Liquidity B (Swept): <code>${setup.structuralLiquidity.price.toFixed(2)}</code>`,
                `• Peak C (Breakout): <code>${setup.peak.price.toFixed(2)}</code>`,
                `• HTF Bias (4H): <code>${trendBias.toUpperCase()}</code>`,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                `<i>⚠️ Note: SMC entry tapped. Please enter the trade manually on Metatrader 5.</i>`
              ].join('\n');
              
              await sendTelegramMessage(entryAlertHtml);
              console.log(`${GREEN}${BOLD}   >>> 📢 SENT TELEGRAM ENTRY ALERT FOR ${symbol}${RESET}`);

              // Add virtual trade to active monitoring list
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
                console.log(`[runner] Added ${symbol} trade to virtual active monitoring list.`);
              }

              // Place trade automatically on Deriv if AUTO_TRADE is true
              if (config.AUTO_TRADE) {
                try {
                  console.log(`[runner] AUTO_TRADE is active. Triggering placeTrade on Deriv for ${symbol}...`);
                  const contractId = await placeTrade(symbol, setup.type, setup.entryPrice, stopLossVal, takeProfitVal);
                  
                  const tradePlacedHtml = [
                    `✅ <b>[DERIV TRADE EXECUTED]</b>`,
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                    `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol]})`,
                    `<b>Contract ID:</b> <code>${contractId}</code>`,
                    `<b>Direction:</b> ${setup.type === 'bullish' ? '🟢 BUY (MULTUP)' : '🔴 SELL (MULTDOWN)'}`,
                    `<b>Stake Amount:</b> <code>$${process.env.TRADE_STAKE || 1} USD</code>`,
                    `<b>Multiplier:</b> <code>x${process.env.TRADE_MULTIPLIER || 20}</code>`,
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                    `<i>🚀 Order successfully executed and filled. Positions monitor is tracking...</i>`
                  ].join('\n');
                  
                  await sendTelegramMessage(tradePlacedHtml);
                  console.log(`${GREEN}${BOLD}   >>> 📢 SENT TELEGRAM TRADE PLACED CONFIRMATION FOR ${symbol}${RESET}`);
                } catch (tradeErr) {
                  console.error(`[runner] Failed to place trade on Deriv for ${symbol}:`, tradeErr.message);
                  
                  const tradeFailedHtml = [
                    `⚠️ <b>[DERIV TRADE EXECUTION FAILED]</b>`,
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                    `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol]})`,
                    `<b>Direction:</b> ${setup.type === 'bullish' ? '🟢 BUY' : '🔴 SELL'}`,
                    `<b>Error:</b> <code>${tradeErr.message}</code>`,
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                    `<i>❌ Automated execution failed. Please verify API token permissions and connection logs on your VPS.</i>`
                  ].join('\n');
                  
                  await sendTelegramMessage(tradeFailedHtml);
                }
              }
            }
          } 
          // C. Evaluate Stage 1: Setup Detected Alert
          // Triggers when structure is fully set up, but price has not tapped the OB yet
          else {
            if (!alertedSetups.has(setupId)) {
              alertedSetups.add(setupId);
              
              const setupAlertHtml = [
                `🔔 <b>[SMC HIGH-PROBABILITY SETUP]</b>`,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol]})`,
                `<b>Type:</b> ${setup.type === 'bullish' ? '🟢 <b>BULLISH PENDING OB TAP</b>' : '🔴 <b>BEARISH PENDING OB TAP</b>'}`,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                `🔹 <b>ENTRY ZONE:</b> <code>${setup.entryPrice.toFixed(2)}</code> (Order Block limit)`,
                `🔹 <b>STOP LOSS:</b> <code>${stopLossVal.toFixed(2)}</code>`,
                `🔹 <b>STRICT 1:2 TP:</b> <code>${takeProfitVal.toFixed(2)}</code>`,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                `📊 <b>Market Structure State:</b>`,
                `• Protected Extremity A: <code>${setup.protectedPoint.price.toFixed(2)}</code>`,
                `• Liquidity Sweep B: <code>${setup.structuralLiquidity.price.toFixed(2)}</code>`,
                `• Structural Peak C: <code>${setup.peak.price.toFixed(2)}</code>`,
                `• HTF Trend Bias (4H): <code>${trendBias.toUpperCase()}</code>`,
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
      `🚀 <b>Optimized Pairs:</b> 6 active Volatility Indices`,
      `📊 <b>Target System:</b> Strict 1:2 Risk-to-Reward (RR) Limit`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `<i>This is a mock alert confirming that your environment credentials are correct. Real-time fronttesting signals will stream below!</i>`
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
  
  // Real-time live looping mode
  console.log(`\n${BOLD}${CYAN}=================================================================================================`);
  console.log(`🤖 ALGO MARKET STRUCTURE (SMC) LIVE TELEGRAM ALERT ENGINE`);
  console.log(`=================================================================================================${RESET}`);
  console.log(`Timeframe Settings: LTF = ${config.DEFAULT_LTF} | HTF Filter = ${config.DEFAULT_HTF} (50 EMA)`);
  console.log(`Risk Settings: Risk per Trade = ${config.RISK_PERCENT}% | Target Reward-to-Risk = ${config.REWARD_RATIO}:1`);
  console.log(`Bot Mode: Live Polling & Active Fronttesting Alert System`);
  console.log(`Status: Active and Listening 24/7 for optimized setups...`);
  console.log(`-------------------------------------------------------------------------------------------------`);
  
  // Start persistent position monitoring if AUTO_TRADE is enabled
  if (config.AUTO_TRADE) {
    console.log(`[runner] AUTO_TRADE is active. Initializing persistent Deriv contract monitoring...`);
    monitorPositions(async ({ symbol, contractId, profit, result, contractDetails }) => {
      console.log(`[runner] Position closed event received for contract ${contractId} (${symbol}). Result: ${result}, Profit: $${profit}`);

      const isProfit = profit > 0;
      const resultEmoji = isProfit ? '🏆' : '🛡️';
      const outcomeText = isProfit 
        ? `🟢 <b>TAKE PROFIT (TP) HIT!</b>` 
        : `🔴 <b>STOP LOSS (SL) HIT!</b>`;

      const closedAlertHtml = [
        `${resultEmoji} <b>[DERIV POSITION CLOSED]</b>`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `<b>Asset:</b> <code>${symbol}</code> (${config.SYMBOLS[symbol] || symbol})`,
        `<b>Contract ID:</b> <code>${contractId}</code>`,
        `<b>Outcome:</b> ${outcomeText}`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `💰 <b>REALIZED PROFIT:</b> <code>${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} USD</code>`,
        `📈 <b>Entry Spot:</b> <code>${contractDetails.entry_spot}</code>`,
        `📉 <b>Exit Spot:</b> <code>${contractDetails.exit_spot || 'N/A'}</code>`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `<i>ℹ️ Open the Deriv GO app on your phone to check your updated balance sheet!</i>`
      ].join('\n');

      try {
        await sendTelegramMessage(closedAlertHtml);
        console.log(`${GREEN}${BOLD}   >>> 📢 SENT TELEGRAM POSITION CLOSED NOTIFICATION FOR ${symbol}${RESET}`);
      } catch (telegramErr) {
        console.error("[runner] Failed sending Telegram closed position notification:", telegramErr.message);
      }
    });
  }

  // Initial Scan
  await monitorMarket();
  
  // Run loop every 30 seconds
  setInterval(async () => {
    await monitorMarket();
  }, 30000);
}

main();
