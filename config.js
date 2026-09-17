// config.js
/**
 * Configuration settings for the Algo Market Structure trading bot and backtester.
 * Senior Institutional Quantitative Configuration — Strategy 5B High-Frequency Momentum Model.
 */
require('dotenv').config();

module.exports = {
  // Deriv Connection Settings
  DERIV_APP_ID: 1089, // Public sandbox app_id
  DERIV_WS_URL: "wss://ws.derivws.com/websockets/v3?app_id=1089",

  // Top 10 Optimized Elite Boom & Crash Hybrid Portfolio (Strategy 5B Hybrid)
  SYMBOLS: {
    // ── BOOM Pairs (SELL ONLY in Daily/4H/1H Bearish Trend) ──
    "BOOM500":   { name: "Boom 500 Index",  mode: "BOOM",  min_spikes: 2 }, // 👑 #1 Performer: 59.6% WR | +56.0R (+$168.00/mo)
    "BOOM300N":  { name: "Boom 300 Index",  mode: "BOOM",  min_spikes: 3 }, // 👑 Live MVP: 73.1% WR | +36.7R (+$110.10/mo)
    "BOOM900":   { name: "Boom 900 Index",  mode: "BOOM",  min_spikes: 2 }, // 👑 Steady Trend: 58.0% WR | +25.5R (+$76.50/mo)
    "BOOM600":   { name: "Boom 600 Index",  mode: "BOOM",  min_spikes: 2 }, // 👑 High Momentum: 56.5% WR | +15.0R (+$45.00/mo)
    "BOOM200":   { name: "Boom 200 Index",  mode: "BOOM",  min_spikes: 3 }, // 🛡️ Deep Sniper: 64.3% WR | +13.4R (+$40.20/mo)
    "BOOM100":   { name: "Boom 100 Index",  mode: "BOOM",  min_spikes: 3 }, // 🛡️ Steady: 51.6% WR | +5.8R (+$17.40/mo)

    // ── CRASH Pairs (BUY ONLY in Daily/4H/1H Bullish Trend) ──
    "CRASH500":  { name: "Crash 500 Index", mode: "CRASH", min_spikes: 2 }, // 👑 Core Crash: 58.9% WR | +39.8R (+$119.40/mo)
    "CRASH600":  { name: "Crash 600 Index", mode: "CRASH", min_spikes: 2 }, // 👑 High Volume: 54.9% WR | +32.1R (+$96.30/mo)
    "CRASH900":  { name: "Crash 900 Index", mode: "CRASH", min_spikes: 2 }, // 👑 High Precision: 58.7% WR | +22.1R (+$66.30/mo)
    "CRASH300N": { name: "Crash 300 Index", mode: "CRASH", min_spikes: 3 }, // 🛡️ Deep Sniper: Upgraded v5.6 (3 Spikes) | 81.8% WR
    "CRASH1000": { name: "Crash 1000 Index",mode: "CRASH", min_spikes: 2 }, // 🟢 Trend Follower: 54.8% WR | +10.9R (+$32.70/mo)
    "CRASH99":   { name: "Crash 99 Index",  mode: "CRASH", min_spikes: 3 }, // 🛡️ Deep Sniper: 65.4% WR | +13.1R (+$39.30/mo)
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
  
  // Strategy 5B Execution Parameters
  REWARD_RATIO: 1.3,                    // 1:1.3 R:R Fixed Sniper Target
  USE_HTF_CHOP_FILTER: true,            // Filter out flat 1H 50 EMA chop (>0.08% clearance required)
  MIN_SPIKES: 2,                        // 2-Spike High-Frequency Mode (Strategy 5B)
  MIN_SPIKE_CLUSTER_ATR_RATIO: 0.50,    // 👑 Institutional filter: spike cluster range must be >= 0.5x ATR(14) (filters micro-duds)

  // Institutional Responsive Tiered Circuit Breakers
  CIRCUIT_BREAKER: {
    ENABLED: true,
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
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  GEMINI_MODEL: "gemini-2.5-flash"
};
