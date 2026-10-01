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
    "BOOM500":   { name: "Boom 500 Index",  mode: "BOOM",  min_spikes: 2 }, // 👑 Standard 2-Spike Sniper
    "BOOM300N":  { name: "Boom 300 Index",  mode: "BOOM",  min_spikes: 3 }, // 👑 3-Spike Fast Index Exhaustion
    "BOOM900":   { name: "Boom 900 Index",  mode: "BOOM",  min_spikes: 2 }, // 👑 Standard 2-Spike Sniper
    "BOOM600":   { name: "Boom 600 Index",  mode: "BOOM",  min_spikes: 2 }, // 👑 Standard 2-Spike Sniper
    "BOOM1000":  { name: "Boom 1000 Index", mode: "BOOM",  min_spikes: 2 }, // 👑 Standard 2-Spike Sniper
    "BOOM150N":  { name: "Boom 150 Index",  mode: "BOOM",  min_spikes: 2, monitorOnly: true }, // 🔬 Incubation Paper Monitor ($0 Risk)

    // ── CRASH Pairs (BUY ONLY in Daily/4H/1H Bullish Trend + Price Action Displacement) ──
    "CRASH300N": { name: "Crash 300 Index", mode: "CRASH", min_spikes: 2 }, // 👑 Standard 2-Spike Sniper
    "CRASH500":  { name: "Crash 500 Index", mode: "CRASH", min_spikes: 2 }, // 👑 Standard 2-Spike Sniper
    "CRASH600":  { name: "Crash 600 Index", mode: "CRASH", min_spikes: 2 }, // 👑 Standard 2-Spike Sniper
    "CRASH900":  { name: "Crash 900 Index", mode: "CRASH", min_spikes: 2 }, // 👑 Standard 2-Spike Sniper
    "CRASH1000": { name: "Crash 1000 Index",mode: "CRASH", min_spikes: 2 }, // 👑 Standard 2-Spike Sniper
    "CRASH150N": { name: "Crash 150 Index", mode: "CRASH", min_spikes: 2, monitorOnly: true }, // 🔬 Incubation Paper Monitor ($0 Risk)
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
  
  // Timezone Settings (WAT / West Africa Time / GMT+1)
  TIMEZONE_OFFSET_HOURS: 1,             // 12:00 AM midnight daily report & date rollover triggers in trader local time

  // Strategy 5B/5C Execution Parameters
  REWARD_RATIO: 1.3,                    // 1:1.3 R:R Fixed Sniper Target
  USE_HTF_CHOP_FILTER: true,            // Filter out flat 1H 50 EMA chop (>0.08% clearance required)
  REQUIRE_DAILY_CONFLUENCE: true,       // 👑 Triple Confluence (Daily + 4H + 1H 50 EMA): guarantees institutional macro backing
  CONFIRMATION_CANDLES: 1,              // 👑 1-Candle Exhaustion Entry (5 mins): captures lowest entry price & fastest TP
  MIN_SPIKES: 2,                        // Universal 2-Spike Model Baseline
  MIN_SPIKE_CLUSTER_ATR_RATIO: 1.20,    // 👑 Substantial Spike Filter: spike cluster range must be >= 1.2x ATR(14)
  VALUE_ZONE_MAX_ATR_DIST: 2.5,         // 👑 Value Zone Guard: rejects overbought ceiling buys or oversold floor sells
  MIN_CANDLE0_DISPLACEMENT_RATIO: 0.20, // 👑 Price action confirmation: C0 recovery body must be >= 20% of preceding spike

  // Anti-Climax & Momentum Guards (Strategy 5B Enhanced)
  USE_ACTIVE_1H_CANDLE_GUARD: true,     // 👑 Reject BUY on Crash if active 1H candle is red; reject SELL on Boom if green

  // Institutional Responsive Tiered Circuit Breakers & Daily Targets
  CIRCUIT_BREAKER: {
    ENABLED: true,
    POST_WIN_PAUSE_MINS: 35,             // 👑 35m pause post-TP to prevent climax traps
    TIER_1_PAUSE_MINS: 45,               // 45-minute pause on symbol after 1 loss (9x M5 candles)
    TIER_2_PAUSE_MINS: 60,               // 60-minute pause on symbol after 2 consecutive losses
    MAX_DAILY_LOSSES_PER_SYMBOL: 2,      // 👑 2 Daily Losses = Halted on symbol for remainder of day
    PORTFOLIO_CONSECUTIVE_LOSS_LIMIT: 3, // 👑 3 Consecutive Losses across ANY pairs = 60m Portfolio-wide Cooldown
    PORTFOLIO_LOSS_PAUSE_MINS: 60,       // 60-minute portfolio pause duration
    DEFAULT_DAILY_PROFIT_TARGET_USD: 0   // 👑 Default daily profit target disabled (0) — set dynamically via Telegram /target <amt>
  },

  // Bot Settings & Modes
  AUTO_TRADE: false, // Signal-only monitoring mode

  // Telegram Notifications & Remote Control Settings
  TELEGRAM: {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
    CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
    POLL_INTERVAL_MS: 3000 // Inbound polling interval for Telegram commands
  },

  // Gemini AI Gatekeeper Settings
  ENABLE_AI_VISION: false, // Set to true to re-enable Gemini AI Vision shadow audits
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  GEMINI_MODEL: "gemini-2.5-flash"
};
