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

  // Top 8 Portfolio (Filtered by 1-Month MT5 Backtest Performance)
  SYMBOLS: {
    // ── BOOM Pairs (SELL ONLY in 1H Bearish Trend) ──
    "BOOM200":   { name: "Boom 200 Index",  mode: "BOOM" },
    "BOOM500":   { name: "Boom 500 Index",  mode: "BOOM" },
    "BOOM300N":  { name: "Boom 300 Index",  mode: "BOOM" },
    "BOOM1000":  { name: "Boom 1000 Index", mode: "BOOM" },

    // ── CRASH Pairs (BUY ONLY in 1H Bullish Trend) ──
    "CRASH500":  { name: "Crash 500 Index",  mode: "CRASH" },
    "CRASH600":  { name: "Crash 600 Index",  mode: "CRASH" },
    "CRASH200":  { name: "Crash 200 Index",  mode: "CRASH" },
    "CRASH1000": { name: "Crash 1000 Index", mode: "CRASH" }
  },

  // Timeframe Configuration (Scalping Engine)
  DEFAULT_HTF: "1h",   // Higher Timeframe for Trend Bias (1h, 50 EMA)
  DEFAULT_LTF: "5m",   // Lower Timeframe for Entry Setup (5m)

  // Risk & Position Management Settings ($10,000 Demo Account)
  STARTING_BALANCE: 10000.0, // Account size in USD ($10,000)
  RISK_PERCENT: 1.0,         // Risk exactly 1% of equity per trade
  RISK_AMOUNT_USD: 100.0,    // Risk $100 per trade ($3 risk for $100 account)
  REWARD_RATIO: 1.3,         // Target 1:1.3 Risk-to-Reward ratio (Backtest Validated: 54.55% Win Rate)

  // Institutional Risk & Position Controls
  ENABLE_BREAK_EVEN: false,     // false = Clean 1:1.3 R:R run without premature Break-Even stopouts
  MAX_DAILY_LOSS_USD: null,      // null = disabled (run all signals during testing)
  DAILY_PROFIT_TARGET_USD: null, // null = disabled (run all signals during testing)

  // Bot Settings & Modes
  AUTO_TRADE: false, // false = Signal-only mode (No auto trade placement)

  // Telegram Notifications Settings
  TELEGRAM: {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
    CHAT_ID: process.env.TELEGRAM_CHAT_ID || ""
  }
};
