// config.js
/**
 * Configuration settings for the Algo Market Structure trading bot and backtester.
 * Senior Institutional Quantitative Configuration — Strategy 6 Institutional Supply-Sweep Model.
 */
require('dotenv').config();

module.exports = {
  // Deriv Connection Settings
  DERIV_APP_ID: 1089, // Public sandbox app_id
  DERIV_WS_URL: "wss://ws.derivws.com/websockets/v3?app_id=1089",

  // Top 10 Elite Portfolio (45-Day Verified Backtest)
  SYMBOLS: {
    // ── BOOM Pairs (SELL ONLY in 4H/1H Bearish Trend at Deep Premium >= 61.8%) ──
    "BOOM1000":  { name: "Boom 1000 Index", mode: "BOOM",  min_spikes: 2 }, // 69.8% WR | +118.5R
    "BOOM500":   { name: "Boom 500 Index",  mode: "BOOM",  min_spikes: 2 }, // 61.2% WR | +120.5R
    "BOOM300N":  { name: "Boom 300 Index",  mode: "BOOM",  min_spikes: 3 }, // 65.8% WR | +93.0R (3-spike)

    // ── CRASH Pairs (BUY ONLY in 4H/1H Bullish Trend at Deep Discount <= 38.2%) ──
    "CRASH500":  { name: "Crash 500 Index", mode: "CRASH", min_spikes: 2 }, // 69.7% WR | +147.0R
    "CRASH50":   { name: "Crash 50 Index",  mode: "CRASH", min_spikes: 2 }, // 67.9% WR | +54.5R
    "CRASH600":  { name: "Crash 600 Index", mode: "CRASH", min_spikes: 2 }, // 67.2% WR | +186.0R
    "CRASH900":  { name: "Crash 900 Index", mode: "CRASH", min_spikes: 2 }, // 63.9% WR | +92.5R
    "CRASH300N": { name: "Crash 300 Index", mode: "CRASH", min_spikes: 2 }, // 62.1% WR | +148.5R

    // ── VOLATILITY Pairs (Bidirectional Smart Money Retracements) ──
    "R_100":     { name: "Volatility 100 Index", mode: "VOLATILITY", min_spikes: 2 }, // 64.7% WR | +84.0R
    "R_50":      { name: "Volatility 50 Index",  mode: "VOLATILITY", min_spikes: 2 }  // 57.7% WR | +95.0R
  },

  // Multi-Timeframe Confluence Engine
  MACRO_HTF: "4h",        // 4-Hour Macro Trend (50 EMA)
  INTERMEDIATE_HTF: "1h", // 1-Hour Intermediate Trend (50 EMA)
  DEFAULT_LTF: "5m",      // 5-Minute Entry Trigger Timeframe

  // Risk & Position Management Settings ($100 Real Account)
  STARTING_BALANCE: 100.0,   // Account size in USD ($100 Account)
  RISK_PERCENT: 3.0,         // Risk exactly 3% of equity per trade ($3.00)
  RISK_AMOUNT_USD: 3.0,      // Risk $3.00 per trade
  
  // Dual Target Setup (Strategy 6)
  TP1_RR: 1.3,               // 1:1.3 R:R Scalp Target (Move SL to Breakeven)
  TP2_RR: 1.5,               // 1:1.5 R:R Optimal Sniper Full Target
  REWARD_RATIO: 1.5,         // Primary target baseline
  PREMIUM_FIB_MIN: 0.618,    // Minimum 61.8% retracement into 24H dealing range

  // Institutional Filters & Rules (Strategy 6)
  USE_HTF_CHOP_FILTER: true,    // Filter out flat 1H 50 EMA chop (>0.08% clearance required)
  MIN_SPIKES: 2,                // Default minimum spikes/pullbacks

  // Single-Pair 30-Minute Cooldown
  CIRCUIT_BREAKER: {
    ENABLED: true,
    TIER_1_PAUSE_MINS: 30,       // 30-minute pause on that symbol after a loss
    TIER_2_PAUSE_MINS: 90,       // 90-minute pause after 2 losses
    MAX_DAILY_LOSSES_PER_SYMBOL: 3 // 3 Daily Losses = Halted for remainder of day
  },

  // Bot Settings & Modes
  AUTO_TRADE: false, // Signal-only monitoring mode

  // Telegram Notifications Settings
  TELEGRAM: {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
    CHAT_ID: process.env.TELEGRAM_CHAT_ID || ""
  },

  // Gemini AI Gatekeeper Settings
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  GEMINI_MODEL: "gemini-2.5-flash"
};
