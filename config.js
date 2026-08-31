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

  // Top 7 Elite Boom & Crash Portfolio (Strategy 5B — 30-Day Optimised)
  SYMBOLS: {
    // ── BOOM Pairs (SELL ONLY in Daily/4H/1H Bearish Trend on 2-Spike Exhaustion) ──
    "BOOM100":   { name: "Boom 100 Index",  mode: "BOOM", min_spikes: 3 }, // 👑 Upgraded to 3-Spike Exhaustion (High-Quality Sniper)
    "BOOM300N":  { name: "Boom 300 Index",  mode: "BOOM", min_spikes: 3 }, // 🟢 Optimized: 68.4% WR | +$65.40/mo (3-Spike Exhaustion)
    "BOOM600":   { name: "Boom 600 Index",  mode: "BOOM", min_spikes: 3 }, // 🟢 Optimized: Upgraded to 3-Spike Exhaustion
    "BOOM900":   { name: "Boom 900 Index",  mode: "BOOM", min_spikes: 2 }, // 🟢 Strong: 77.8% WR | +$21.30/mo

    // ── CRASH Pairs (BUY ONLY in Daily/4H/1H Bullish Trend on 2-Crash Exhaustion) ──
    "CRASH1000": { name: "Crash 1000 Index", mode: "CRASH", min_spikes: 2 }, // 🟢 Strong: 65.0% WR | +$29.70/mo
    "CRASH200":  { name: "Crash 200 Index",  mode: "CRASH", min_spikes: 2 }, // 🔵 OK: 66.7% WR | +$19.20/mo
    "CRASH500":  { name: "Crash 500 Index",  mode: "CRASH", min_spikes: 2 }, // 🔵 OK: 75.0% WR | +$8.70/mo
  },

  // Removed (30-Day Backtest — Low Signal Volume / Below Threshold):
  // BOOM500   — only 2 trades/mo, +$0.90 (noise-level return)
  // CRASH50   — only 4 trades/mo, +$1.80, Max DD $6.00 (poor risk-adjusted)
  // BOOM1000  — 0 trades / no trend alignment in 30 days
  // CRASH900  — 0 trades / no trend alignment in 30 days
  // CRASH300N — 0 trades / no trend alignment in 30 days
  // CRASH600  — 41.7% WR / below breakeven / -$1.50 loss

  // Multi-Timeframe Confluence Engine
  MACRO_DAILY: "1d",      // Daily Macro Trend (50 EMA)
  MACRO_HTF: "4h",        // 4-Hour Macro Trend (50 EMA)
  INTERMEDIATE_HTF: "1h", // 1-Hour Intermediate Trend (50 EMA)
  DEFAULT_LTF: "5m",      // 5-Minute Entry Trigger Timeframe

  // Risk & Position Management Settings ($249.10 Current Live Balance / Auto-Compounding)
  STARTING_BALANCE: 249.10,             // Active live account balance in USD
  RISK_PERCENT: 3.0,                    // Risk exactly 3.0% of equity per trade
  RISK_AMOUNT_USD: 7.47,                // Compounded trade risk ($7.47 on $249.10)
  MIN_RISK_AMOUNT_USD: 3.0,             // Safety floor: risk never drops below $3.00
  DYNAMIC_RISK_COMPOUNDING: true,       // 👑 Auto-adjust risk and lot sizes weekly based on account equity
  
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
