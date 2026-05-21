// config.js
/**
 * Configuration settings for the Algo Market Structure trading bot and backtester.
 */
require('dotenv').config();

module.exports = {
  // Deriv Connection Settings
  DERIV_APP_ID: 1089, // Public sandbox app_id
  DERIV_WS_URL: "wss://ws.derivws.com/websockets/v3?app_id=1089",

  // Supported Volatility Indices (Asset List)
  SYMBOLS: {
    "R_10": "Volatility 10 Index",
    "R_25": "Volatility 25 Index",
    "R_50": "Volatility 50 Index",
    "R_75": "Volatility 75 Index",
    "1HZ50V": "Volatility 50 (1s) Index",
    "1HZ100V": "Volatility 100 (1s) Index"
  },

  // Timeframe Configuration
  DEFAULT_HTF: "4h",   // Higher Timeframe for Trend Bias (Daily, 4h, 8h)
  DEFAULT_LTF: "15m",  // Lower Timeframe for Entry Setup (15m, 5m, 1m)
  
  // Backtest Portfolio Settings
  STARTING_BALANCE: 10000.0, // Account size in USD
  RISK_PERCENT: 1.0,         // Risk exactly 1% of equity per trade
  REWARD_RATIO: 2.0,         // Target 1:2 Risk-to-Reward ratio

  // Algorithmic Structure Detection Parameters
  PIVOT_LEFT_BARS: 4,        // Required bars to the left to confirm a Swing point
  PIVOT_RIGHT_BARS: 4,       // Required bars to the right to confirm a Swing point

  // Sweep Verification (Wick Rejection)
  // For a sweep candle to be valid, the candle body must be relatively small 
  // compared to the total range, representing a sharp rejection wick (V/A shape).
  SWEEP_MAX_BODY_RATIO: 0.35, // Body size must be <= 35% of total candle length (high wick ratio)

  // Fibonacci Level
  FIB_RETRACEMENT_LIMIT: 0.5, // Pullback must be at least at or below 50% Fib retracement (discount zone)

  // Bot Settings & Modes
  AUTO_TRADE: true, // false = Telegram Alerts Only, true = Automated trading on Deriv

  // Telegram Notifications Settings
  TELEGRAM: {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
    CHAT_ID: process.env.TELEGRAM_CHAT_ID || ""
  }
};
