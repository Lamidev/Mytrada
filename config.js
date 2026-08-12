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

  // Supported Synthetic Indices (Top 6 Master Hybrid Portfolio - Backtested +15.87% Monthly ROI)
  SYMBOLS: {
    "BOOM500":   "Boom 500 Index",
    "CRASH500":  "Crash 500 Index",
    "1HZ100V":   "Volatility 100 (1s) Index",
    "BOOM1000":  "Boom 1000 Index",
    "CRASH1000": "Crash 1000 Index",
    "CRASH600":  "Crash 600 Index"
  },

  // Timeframe Configuration (Scalping Engine)
  DEFAULT_HTF: "1h",   // Higher Timeframe for Trend Bias (1h, 15m)
  DEFAULT_LTF: "5m",   // Lower Timeframe for Entry Setup (5m, 3m)

  // Master Hybrid Portfolio Strategy Mappings
  ENABLE_HYBRID_PORTFOLIO: true,
  HYBRID_PORTFOLIO_MODES: {
    "BOOM500":   "TICK_SCALPING",  // SELL ONLY (80% Win Rate, +41.31% ROI)
    "CRASH500":  "SPIKE_CATCHING", // SELL ONLY (56% Win Rate, +18.14% ROI)
    "1HZ100V":   "BOTH",           // BUY & SELL (+14.63% ROI)
    "BOOM1000":  "TICK_SCALPING",  // SELL ONLY (+7.10% ROI)
    "CRASH1000": "SPIKE_CATCHING", // SELL ONLY (+7.07% ROI)
    "CRASH600":  "SPIKE_CATCHING"  // SELL ONLY (+7.00% ROI)
  },

  // Daily Circuit-Breaker Controls (Risk & Profit Lock)
  MAX_DAILY_LOSS_USD: 200.0,      // Max 2 losses ($200) per day before pausing to prevent drawdown
  DAILY_PROFIT_TARGET_USD: 400.0, // Lock in daily profits at +$400 (+4R) to preserve wins
  
  // Risk & Position Management Settings
  STARTING_BALANCE: 10000.0, // Account size in USD
  RISK_PERCENT: 1.0,         // Risk exactly 1% of equity per trade
  RISK_AMOUNT_USD: 100.0,    // Base dollar risk for MT5 lot size calculation
  REWARD_RATIO: 2.0,         // Target 1:2 Risk-to-Reward ratio

  // Institutional Risk & Position Controls
  ENABLE_BREAK_EVEN: true,      // Automatically send Break-Even alerts on Telegram
  BREAK_EVEN_RR_TRIGGER: 1.1,   // Trigger BE alert when price reaches 1.1 R:R (Full Position Run)
  ENABLE_PARTIAL_TP: false,     // false = Full position flows to 1:2 TP without partial trimming
  PENDING_ORDER_MAX_HOURS: 24,  // Scalping Order Block Time-To-Live (Cancel pending signals older than 24 hours)

  // Algorithmic Structure Detection Parameters (1-Bar Fast Scalping Pivot Confirmation)
  PIVOT_LEFT_BARS: 1,        // Required bars to the left to confirm a Swing point
  PIVOT_RIGHT_BARS: 1,       // Required bars to the right to confirm a Swing point

  // Sweep Verification (Wick Rejection)
  SWEEP_MAX_BODY_RATIO: 0.45, // Scalping: Allow up to 45% body ratio for 5M wick sweeps

  // Institutional Fair Value Gap (FVG / Imbalance) Filter
  REQUIRE_FVG: false,         // Scalping: Allow OB setups with or without strict 3-candle FVG gap

  // Institutional Confluence Scorecard Threshold (0 to 10 points)
  MIN_CONFLUENCE_SCORE: 5,    // Scalping threshold: broadcast setups scoring 5/10 or higher

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

