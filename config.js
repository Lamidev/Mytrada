// config.js
/**
 * Configuration settings for the Algo Market Structure trading bot and backtester.
 * Senior Institutional Quantitative Configuration.
 */
require('dotenv').config();

module.exports = {
  // Deriv Connection Settings
  DERIV_APP_ID: 1089, // Public sandbox app_id
  DERIV_WS_URL: "wss://ws.derivws.com/websockets/v3?app_id=1089",

  // Supported Synthetic Indices (Top 6 Elite Most Profitable Portfolio - 2.33 Profit Factor)
  SYMBOLS: {
    "BOOM1000": "Boom 1000 Index",
    "CRASH600":  "Crash 600 Index",
    "BOOM900":   "Boom 900 Index",
    "BOOM500":   "Boom 500 Index",
    "CRASH1000": "Crash 1000 Index",
    "1HZ100V":   "Volatility 100 (1s) Index"
  },




  // Timeframe Configuration
  DEFAULT_HTF: "4h",   // Higher Timeframe for Trend Bias (Daily, 4h, 8h)
  DEFAULT_LTF: "30m",  // Lower Timeframe for Entry Setup (30m, 15m, 5m)
  
  // Risk & Position Management Settings
  STARTING_BALANCE: 10000.0, // Account size in USD
  RISK_PERCENT: 1.0,         // Risk exactly 1% of equity per trade
  RISK_AMOUNT_USD: 100.0,    // Base dollar risk for MT5 lot size calculation
  REWARD_RATIO: 2.0,         // Target 1:2 Risk-to-Reward ratio

  // Institutional Risk & Position Controls
  ENABLE_BREAK_EVEN: true,      // Automatically send Break-Even alerts on Telegram
  BREAK_EVEN_RR_TRIGGER: 1.1,   // Trigger BE alert when price reaches 1.1 R:R (Full Position Run)
  ENABLE_PARTIAL_TP: false,     // false = Full position flows to 1:2 TP without partial trimming
  PENDING_ORDER_MAX_HOURS: 48,  // Order Block Time-To-Live (Cancel pending signals older than 48 hours)



  // Algorithmic Structure Detection Parameters (2-Bar Fast Institutional Pivot Confirmation)
  PIVOT_LEFT_BARS: 2,        // Required bars to the left to confirm a Swing point (1-hour confirmation)
  PIVOT_RIGHT_BARS: 2,       // Required bars to the right to confirm a Swing point (1-hour confirmation)


  // Sweep Verification (Wick Rejection)
  SWEEP_MAX_BODY_RATIO: 0.35, // Body size must be <= 35% of total candle length (high wick ratio)

  // Institutional Fair Value Gap (FVG / Imbalance) Filter
  REQUIRE_FVG: true,          // Require a 3-candle Fair Value Gap exiting the Order Block

  // Institutional Confluence Scorecard Threshold (0 to 10 points)
  MIN_CONFLUENCE_SCORE: 7,    // Only broadcast setups scoring 7/10 or higher

  // Stop Loss Configuration
  // ── Mode 1: 'atr'       → Dynamic Volatility SL = ATR(14) × ATR_MULTIPLIER (Preferred Institutional)
  // ── Mode 2: 'ratio'     → SL buffer = swing candle range × STOP_LOSS_BUFFER_RATIO
  // ── Mode 3: 'price_pct' → SL buffer = protected price level × STOP_LOSS_PRICE_PCT
  STOP_LOSS_BUFFER_MODE: 'atr',  // 'atr' | 'ratio' | 'price_pct'
  ATR_PERIOD: 14,                // ATR period for volatility scaling
  ATR_MULTIPLIER: 0.75,          // ATR multiplier (0.75 × ATR)
  STOP_LOSS_BUFFER_RATIO: 0.30,  // used when mode = 'ratio' (30% buffer for wick safety)
  STOP_LOSS_PRICE_PCT: 0.0010,   // used when mode = 'price_pct' (0.1% of price)

  // Premium/Discount entry verification
  ENTRY_DISCOUNT_ONLY: true,

  // Fibonacci Level
  FIB_RETRACEMENT_LIMIT: 0.5, // Pullback must be at least at or below 50% Fib retracement (discount zone)

  // Bot Settings & Modes
  AUTO_TRADE: false, // false = Telegram Alerts Only, true = Automated trading on Deriv

  // Telegram Notifications Settings
  TELEGRAM: {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
    CHAT_ID: process.env.TELEGRAM_CHAT_ID || ""
  }
};

