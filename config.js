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
  DERIV_WS_URL: "wss://api.derivws.com/trading/v1/options/ws/public?app_id=1089",

  // Top Optimized Elite Boom & Crash Portfolio (Strategy 5C Institutional Momentum Guard)
  SYMBOLS: {
    // ── BOOM Pairs (SELL ONLY in Daily/4H/1H Bearish Trend + Price Action Displacement) ──
    "BOOM500":   { name: "Boom 500 Index",  mode: "BOOM",  min_spikes: 2, confirm_candles: 2 }, // 👑 Standard 2-Spike Sniper (2x 5M confirm)
    "BOOM300N":  { name: "Boom 300 Index",  mode: "BOOM",  min_spikes: 2, confirm_candles: 1 }, // 👑 Fast 300 cycle: 1 confirmation candle
    "BOOM200":   { name: "Boom 200 Index",  mode: "BOOM",  min_spikes: 3, confirm_candles: 1 }, // 👑 Restored MVP (+8.9R): 3 spikes, 1 confirmation candle
    "BOOM900":   { name: "Boom 900 Index",  mode: "BOOM",  min_spikes: 2, confirm_candles: 2 }, // 👑 Standard 2-Spike Sniper (2x 5M confirm)
    "BOOM600":   { name: "Boom 600 Index",  mode: "BOOM",  min_spikes: 2, confirm_candles: 2 }, // 👑 Standard 2-Spike Sniper (2x 5M confirm)
    "BOOM1000":  { name: "Boom 1000 Index", mode: "BOOM",  min_spikes: 2, confirm_candles: 2 }, // 👑 Standard 2-Spike Sniper (2x 5M confirm)

    // ── CRASH Pairs (BUY ONLY in Daily/4H/1H Bullish Trend + Price Action Displacement) ──
    "CRASH300N": { name: "Crash 300 Index", mode: "CRASH", min_spikes: 2, confirm_candles: 1 }, // 👑 Fast 300 cycle: 1 confirmation candle
    "CRASH500":  { name: "Crash 500 Index", mode: "CRASH", min_spikes: 2, confirm_candles: 2 }, // 👑 Standard 2-Spike Sniper (2x 5M confirm)
    "CRASH600":  { name: "Crash 600 Index", mode: "CRASH", min_spikes: 2, confirm_candles: 2 }, // 👑 Standard 2-Spike Sniper (2x 5M confirm)
    "CRASH900":  { name: "Crash 900 Index", mode: "CRASH", min_spikes: 2, confirm_candles: 2 }, // 👑 Standard 2-Spike Sniper (2x 5M confirm)
    "CRASH1000": { name: "Crash 1000 Index",mode: "CRASH", min_spikes: 2, confirm_candles: 2 }, // 👑 Standard 2-Spike Sniper (2x 5M confirm)
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
  REQUIRE_DAILY_CONFLUENCE: false,      // 👑 Relaxed to 4H + 1H confluence: captures high-probability 4H/1H intraday swings
  CONFIRMATION_CANDLES: 2,              // 👑 2-Candle Confirmation (10 mins): eliminates 1-candle false-bounce traps
  MIN_SPIKES: 2,                        // Universal 2-Spike Model (Strategy 5C)
  MIN_SPIKE_CLUSTER_ATR_RATIO: 1.20,    // 👑 Substantial Spike Filter: spike cluster range must be >= 1.2x ATR(14) (rejects micro-duds)
  VALUE_ZONE_MAX_ATR_DIST: 2.5,         // 👑 Value Zone Guard: rejects overbought ceiling buys or oversold floor sells
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
