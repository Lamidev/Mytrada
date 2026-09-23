// config.js
/**
 * Configuration settings for the Mytrada Algo Trading Bot.
 * 👑 Strategy 5C Value-Zone Sniper — Clean Slate (Locked Production Standard)
 * Pure price action: Daily + 4H + 1H 50 EMA confluence + 5M spike cluster + dynamic value-zone retest.
 */
require('dotenv').config();

module.exports = {
  // Deriv Connection Settings
  DERIV_APP_ID: 1089, // Standard Deriv public app_id
  DERIV_WS_URL: "wss://ws.binaryws.com/websockets/v3?app_id=1089",

  // Top 10 Optimized Elite Boom & Crash Portfolio (Strategy 5C Institutional Momentum Guard)
  SYMBOLS: {
    // ── BOOM Pairs (SELL ONLY in Daily/4H/1H Bearish Trend + Price Action Displacement) ──
    "BOOM500":   { name: "Boom 500 Index",  mode: "BOOM",  min_spikes: 2 }, // 👑 Standard 2-Spike Sniper
    "BOOM300N":  { name: "Boom 300 Index",  mode: "BOOM",  min_spikes: 2 }, // 👑 Standard 2-Spike Sniper
    "BOOM900":   { name: "Boom 900 Index",  mode: "BOOM",  min_spikes: 2 }, // 👑 Standard 2-Spike Sniper
    "BOOM600":   { name: "Boom 600 Index",  mode: "BOOM",  min_spikes: 2 }, // 👑 Standard 2-Spike Sniper
    "BOOM100":   { name: "Boom 100 Index",  mode: "BOOM",  min_spikes: 2 }, // 👑 Standard 2-Spike Sniper

    // ── CRASH Pairs (BUY ONLY in Daily/4H/1H Bullish Trend + Price Action Displacement) ──
    "CRASH500":  { name: "Crash 500 Index", mode: "CRASH", min_spikes: 2 }, // 👑 Standard 2-Spike Sniper
    "CRASH600":  { name: "Crash 600 Index", mode: "CRASH", min_spikes: 2 }, // 👑 Standard 2-Spike Sniper
    "CRASH900":  { name: "Crash 900 Index", mode: "CRASH", min_spikes: 2 }, // 👑 Standard 2-Spike Sniper
    "CRASH1000": { name: "Crash 1000 Index",mode: "CRASH", min_spikes: 2 }, // 👑 Standard 2-Spike Sniper
    "CRASH99":   { name: "Crash 99 Index",  mode: "CRASH", min_spikes: 2 }, // 👑 Standard 2-Spike Sniper
  },

  // Multi-Timeframe Confluence Engine
  MACRO_DAILY: "1d",      // Daily Macro Trend (50 EMA)
  MACRO_HTF: "4h",        // 4-Hour Macro Trend (50 EMA)
  INTERMEDIATE_HTF: "1h", // 1-Hour Intermediate Trend (50 EMA)
  DEFAULT_LTF: "5m",      // 5-Minute Entry Trigger Timeframe

  // Risk & Position Management Settings (Weekly Auto-Compounding)
  STARTING_BALANCE: 100.0,              // Original deposit baseline in USD
  RISK_PERCENT: 3.0,                    // Risk exactly 3.0% of equity per trade
  RISK_AMOUNT_USD: 3.0,                 // Fallback baseline trade risk ($3.00)
  MIN_RISK_AMOUNT_USD: 3.0,             // Safety floor: risk never drops below $3.00
  DYNAMIC_RISK_COMPOUNDING: true,       // 👑 Auto-adjust risk and lot sizes weekly based on account equity
  COMPOUNDING_FREQUENCY: "WEEKLY",      // 👑 Weekly End-of-Week (Sunday Midnight) Re-anchoring
  
  // Strategy 5C Execution Parameters
  REWARD_RATIO: 1.3,                    // 1:1.3 R:R Fixed Sniper Target
  USE_HTF_CHOP_FILTER: true,            // Filter out flat 1H 50 EMA chop (>0.08% clearance required)
  MIN_SPIKES: 2,                        // Universal 2-Spike Model (Strategy 5C)
  MIN_SPIKE_CLUSTER_ATR_RATIO: 0.50,    // 👑 Institutional filter: spike cluster range must be >= 0.5x ATR(14) (filters micro-duds)
  MIN_CANDLE0_DISPLACEMENT_RATIO: 0.20, // 👑 Price action confirmation: C0 recovery body must be >= 20% of preceding spike

  // Institutional Responsive Tiered Circuit Breakers
  CIRCUIT_BREAKER: {
    ENABLED: true,
    POST_WIN_PAUSE_MINS: 35,     // 👑 35m pause: gives price 7x 5M candles of breathing room post-TP to prevent climax traps
    TIER_1_PAUSE_MINS: 45,       // 45-minute pause on symbol after 1 loss (9x M5 candles)
    TIER_2_PAUSE_MINS: 60,       // 60-minute pause on symbol after 2 consecutive losses (12x M5 candles)
    MAX_DAILY_LOSSES_PER_SYMBOL: 3 // 3 Daily Losses = Halted on symbol for remainder of day
  },

  // Bot Settings & Modes
  AUTO_TRADE: false, // Signal-only monitoring mode

  // Telegram Notifications Settings
  TELEGRAM: {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
    CHAT_ID: process.env.TELEGRAM_CHAT_ID || ""
  },

  // Gemini AI Gatekeeper Settings
  ENABLE_AI_VISION: false, // Set to true to re-enable Gemini AI Vision shadow audits
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  GEMINI_MODEL: "gemini-2.5-flash"
};
