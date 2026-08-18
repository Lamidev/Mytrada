// config.js
/**
 * Configuration settings for the Algo Market Structure trading bot and backtester.
 * Senior Institutional Quantitative Configuration — Strategy 5 Enhanced.
 */
require('dotenv').config();

module.exports = {
  // Deriv Connection Settings
  DERIV_APP_ID: 1089, // Public sandbox app_id
  DERIV_WS_URL: "wss://ws.derivws.com/websockets/v3?app_id=1089",

  // Top 7 Elite Portfolio (Filtered by 7-Day & 1-Month Multi-Timeframe Performance)
  SYMBOLS: {
    // ── BOOM Pairs (SELL ONLY in 4H & 1H Bearish Trend after 3+ Spikes) ──
    "BOOM300N":  { name: "Boom 300 Index",  mode: "BOOM" }, // 69.4% WR | +$64.50 ➔ 👑 Top Performer
    "BOOM200":   { name: "Boom 200 Index",  mode: "BOOM" }, // 66.7% WR | +$38.40 ➔ 🟢 Elite Growth
    "BOOM600":   { name: "Boom 600 Index",  mode: "BOOM" }, // 64.7% WR | +$24.90 ➔ 🟢 High Accuracy
    "BOOM500":   { name: "Boom 500 Index",  mode: "BOOM" }, // 56.3% WR | +$14.10 ➔ 🟢 Steady Volume

    // ── CRASH Pairs (BUY ONLY in 4H & 1H Bullish Trend after 3+ Crashes) ──
    "CRASH99":   { name: "Crash 99 Index",   mode: "CRASH" }, // 63.6% WR | +$30.60 ➔ 🟢 Elite Scalp
    "CRASH100":  { name: "Crash 100 Index",  mode: "CRASH" }, // 80.0% WR | +$12.60 ➔ 🎯 Ultra-Sniper
    "CRASH600":  { name: "Crash 600 Index",  mode: "CRASH" }  // 100% WR  | +$11.70 ➔ 🎯 Perfect Accuracy
  },

  // Multi-Timeframe Confluence Engine
  MACRO_HTF: "4h",        // 4-Hour Macro Trend (50 EMA)
  INTERMEDIATE_HTF: "1h", // 1-Hour Intermediate Trend (50 EMA)
  DEFAULT_LTF: "5m",      // 5-Minute Entry Trigger Timeframe

  // Risk & Position Management Settings ($100 Real Account)
  STARTING_BALANCE: 100.0,   // Account size in USD ($100 Account)
  RISK_PERCENT: 3.0,         // Risk exactly 3% of equity per trade ($3.00)
  RISK_AMOUNT_USD: 3.0,      // Risk $3.00 per trade (1:1.3 RR = +$3.90 Win / -$3.00 Loss)
  REWARD_RATIO: 1.3,         // Target 1:1.3 Risk-to-Reward ratio (Optimal Deriv Reversal Velocity)

  // Institutional Filters & Rules (Strategy 5 Enhanced)
  USE_HTF_CHOP_FILTER: true,    // true = Filter out flat 1H 50 EMA chop (>0.08% clearance required)
  MIN_SPIKES: 3,                // Minimum 3 consecutive spike candles for deep exhaustion
  ENABLE_BREAK_EVEN: false,     // false = Clean 1:1.3 R:R run without premature stopouts

  // Tiered Circuit Breaker Engine
  CIRCUIT_BREAKER: {
    ENABLED: true,
    TIER_1_PAUSE_MINS: 45,       // 1 Loss = 45-minute pause on that symbol
    TIER_2_PAUSE_MINS: 150,      // 2 Consecutive Losses = 2.5-hour hard pause on that symbol
    MAX_DAILY_LOSSES_PER_SYMBOL: 3 // 3 Daily Losses = Halted for remainder of day
  },

  // Bot Settings & Modes
  AUTO_TRADE: false, // false = Signal-only mode (No auto trade placement)

  // Telegram Notifications Settings
  TELEGRAM: {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
    CHAT_ID: process.env.TELEGRAM_CHAT_ID || ""
  }
};
