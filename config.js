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

  // Top 9 Elite Portfolio (30-Day Realistic Backtest — Daily+4H+1H+Circuit Breakers | Aug 18, 2026)
  SYMBOLS: {
    // ── BOOM Pairs (SELL ONLY in Daily/4H/1H Bearish Trend after spike exhaustion) ──
    "BOOM300N":  { name: "Boom 300 Index",  mode: "BOOM" }, // 👑 3-spike: 58.4% WR | +42.9R | 5.7R DD
    "BOOM500":   { name: "Boom 500 Index",  mode: "BOOM" }, // 👑 2-spike: 59.4% WR | +58.5R | 6.0R DD
    "BOOM600":   { name: "Boom 600 Index",  mode: "BOOM" }, // 🟢 3-spike: 54.5% WR | +8.4R  | 4.0R DD
    "BOOM900":   { name: "Boom 900 Index",  mode: "BOOM" }, // 🎯 2-spike: 71.0% WR | +19.6R | 2.0R DD

    // ── CRASH Pairs (BUY ONLY in Daily/4H/1H Bullish Trend after crash exhaustion) ──
    "CRASH200":  { name: "Crash 200 Index", mode: "CRASH" }, // 🟢 3-spike: 55.6% WR | +15.0R | 3.0R DD
    "CRASH300N": { name: "Crash 300 Index", mode: "CRASH" }, // 🟢 3-spike: 53.2% WR | +17.3R | 9.1R DD
    "CRASH500":  { name: "Crash 500 Index", mode: "CRASH" }, // 👑 2-spike: 56.8% WR | +33.9R | 5.1R DD
    "CRASH600":  { name: "Crash 600 Index", mode: "CRASH" }, // 🎯 3-spike: 60.0% WR | +17.1R | 3.8R DD
    "CRASH900":  { name: "Crash 900 Index", mode: "CRASH" }  // 🎯 2-spike: 60.4% WR | +18.7R | 4.0R DD
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
  MIN_SPIKES: 3,                // Strategy 5A (3-spike, LIVE). Change to 2 to switch to Strategy 5B (2-spike Upgrade).
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
