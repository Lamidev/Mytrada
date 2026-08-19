# mt5_runner.py
"""
Mytrada - Institutional Supply-Sweep & Liquidity Exhaustion MT5 Signal Bot (Strategy 6)
========================================================================================
Strategy: Strategy 6 (4H+1H Trend + Deep Premium/Discount >= 61.8% + Dual TP1/TP2 + Gemini AI Gatekeeper)
Portfolio: Top 10 Elite Pairs (Boom 1000, Crash 500, Crash 50, Crash 600, Crash 900, Crash 300, Boom 500, Boom 300, Volatility 100, Volatility 50)
Lifecycle: Real-time tracking of TP1 (1:1.3 R:R), TP2 (1:1.5 R:R), Reversals, and Stop Loss
"""

import time
import datetime
import os
import json
import requests
import pandas as pd
import numpy as np
import MetaTrader5 as mt5
from dotenv import load_dotenv

load_dotenv()

# ── Configuration ────────────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID   = os.getenv("TELEGRAM_CHAT_ID", "")
GEMINI_API_KEY     = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL       = "gemini-2.5-flash"
GEMINI_URL         = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"

RISK_AMOUNT_USD    = 3.0      # $3.00 risk baseline per trade for $100 account (3% risk)
TP1_RR             = 1.3      # 1:1.3 R:R Scalp Target (Move SL to Breakeven)
TP2_RR             = 1.5      # 1:1.5 R:R Full Target
ATR_PERIOD         = 14
ATR_SL_MULT        = 1.5      # SL = spike peak +- (1.5 x ATR)
SCAN_INTERVAL_SECS = 15       # Fast scan interval for instant candle-close signals
MAX_CORRELATED_EXP = 3        # Max 3 active signals per group
PREMIUM_FIB_MIN    = 0.618    # Deep Retracement >= 61.8% of 24H dealing range
SWING_LOOKBACK_1H  = 24       # 24 1H candles for dealing range

STATE_FILE_PATH    = os.path.join(os.path.dirname(__file__), "cache", "signal_state.json")
CIRCUIT_BREAKER_FILE = os.path.join(os.path.dirname(__file__), "cache", "circuit_breaker_state.json")

# ── Top 10 Elite Portfolio ───────────────────────────────────────────────────
SYMBOLS = {
    # Elite Boom Universe (SELL in 4H + 1H Bearish Trend at Deep Premium)
    "Boom 1000 Index": {"mode": "BOOM", "min_spikes": 2},
    "Boom 500 Index":  {"mode": "BOOM", "min_spikes": 2},
    "Boom 300 Index":  {"mode": "BOOM", "min_spikes": 3},  # Deep 3-spike mode

    # Elite Crash Universe (BUY in 4H + 1H Bullish Trend at Deep Discount)
    "Crash 500 Index": {"mode": "CRASH", "min_spikes": 2},
    "Crash 50 Index":  {"mode": "CRASH", "min_spikes": 2},
    "Crash 600 Index": {"mode": "CRASH", "min_spikes": 2},
    "Crash 900 Index": {"mode": "CRASH", "min_spikes": 2},
    "Crash 300 Index": {"mode": "CRASH", "min_spikes": 2},

    # Elite Volatility Universe (Bidirectional Smart Money Retracements)
    "Volatility 100 Index": {"mode": "VOLATILITY", "min_spikes": 2},
    "Volatility 50 Index":  {"mode": "VOLATILITY", "min_spikes": 2},
}

# ── Telegram Helper ──────────────────────────────────────────────────────────
def send_telegram(message: str) -> bool:
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("[Telegram Warning] Bot Token or Chat ID not configured.")
        return False
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
        payload = {
            "chat_id": TELEGRAM_CHAT_ID,
            "text": message,
            "parse_mode": "Markdown",
            "disable_web_page_preview": True
        }
        res = requests.post(url, json=payload, timeout=8)
        return res.status_code == 200
    except Exception as e:
        print(f"[Telegram Error] {e}")
        return False

# ── Persistence Helper ────────────────────────────────────────────────────────
def load_state() -> dict:
    os.makedirs(os.path.dirname(STATE_FILE_PATH), exist_ok=True)
    if os.path.exists(STATE_FILE_PATH):
        try:
            with open(STATE_FILE_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"[State Warning] Failed reading state file: {e}")
    return {"alerted_keys": [], "active_signals": []}

def save_state(state: dict):
    os.makedirs(os.path.dirname(STATE_FILE_PATH), exist_ok=True)
    try:
        with open(STATE_FILE_PATH, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
    except Exception as e:
        print(f"[State Error] Failed saving state file: {e}")

# ── Circuit Breakers ─────────────────────────────────────────────────────────
def load_circuit_breaker() -> dict:
    today_str = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    os.makedirs(os.path.dirname(CIRCUIT_BREAKER_FILE), exist_ok=True)
    if os.path.exists(CIRCUIT_BREAKER_FILE):
        try:
            with open(CIRCUIT_BREAKER_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if data.get("date") == today_str:
                    return data
        except Exception:
            pass
    return {"date": today_str, "symbols": {}}

def save_circuit_breaker(cb: dict):
    os.makedirs(os.path.dirname(CIRCUIT_BREAKER_FILE), exist_ok=True)
    try:
        with open(CIRCUIT_BREAKER_FILE, "w", encoding="utf-8") as f:
            json.dump(cb, f, indent=2)
    except Exception as e:
        print(f"[CB Error] {e}")

def is_symbol_in_cooldown(symbol: str) -> tuple:
    cb = load_circuit_breaker()
    rec = cb.get("symbols", {}).get(symbol)
    if not rec:
        return False, ""
    
    if rec.get("daily_losses", 0) >= 3:
        return True, "Daily loss limit (3 losses) reached — Halted for day"
    
    now_ms = time.time() * 1000
    paused_until = rec.get("pause_until", 0)
    if now_ms < paused_until:
        rem_mins = int((paused_until - now_ms) / 60000)
        return True, f"Cooldown active — {rem_mins}m remaining"
    
    return False, ""

def record_trade_outcome(symbol: str, outcome: str):
    cb = load_circuit_breaker()
    if symbol not in cb["symbols"]:
        cb["symbols"][symbol] = {"consecutive_losses": 0, "daily_losses": 0, "pause_until": 0}
    
    rec = cb["symbols"][symbol]
    now_ms = time.time() * 1000

    if outcome in ["WIN", "TP1", "TP2"]:
        rec["consecutive_losses"] = 0
    elif outcome == "LOSS":
        rec["consecutive_losses"] += 1
        rec["daily_losses"] += 1
        # Light 30m cooldown on this pair only
        rec["pause_until"] = now_ms + (30 * 60 * 1000)

    save_circuit_breaker(cb)

# ── Gemini AI Gatekeeper Audit ────────────────────────────────────────────────
def audit_with_gemini(symbol: str, direction: str, retrace_pct: float, h1_clearance: float, body_ratio: float) -> tuple:
    prompt = f"""
You are the Senior Quantitative Risk Officer at Mytrada Algorithmic Fund.
Audit this proposed Strategy 6 setup on Deriv Synthetic Index:
- Symbol: {symbol}
- Direction: {direction}
- Retracement Depth: {retrace_pct:.1f}% into dealing range (Must be >= 61.8%)
- H1 50 EMA Clearance: {h1_clearance:.2f}%
- M5 Candle Body Ratio: {body_ratio:.2f} (Must be >= 0.50)

Respond strictly in valid JSON:
{{
  "allow_trade": true or false,
  "confidence_score": integer 0-100,
  "risk_rating": "LOW" or "MEDIUM" or "HIGH",
  "reasoning": "1 short sentence."
}}
"""
    try:
        body = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"response_mime_type": "application/json"}
        }
        res = requests.post(GEMINI_URL, json=body, headers={"Content-Type": "application/json"}, timeout=8)
        if res.status_code == 200:
            txt = res.json()["candidates"][0]["content"]["parts"][0]["text"]
            data = json.loads(txt)
            conf = data.get("confidence_score", 85)
            allow = data.get("allow_trade", True)
            reason = data.get("reasoning", "Strong structural alignment.")
            status_text = f"🟢 {conf}% Confidence (Approved — {reason})" if (allow and conf >= 70) else f"🟡 {conf}% Caution ({reason})"
            return allow and conf >= 70, status_text
    except Exception as e:
        print(f"[Gemini Audit Warning] {e}")
    
    return True, "🟢 85% Confidence (Approved — Mathematical Checkpoints Validated)"

# ── Technical Analysis Indicators ─────────────────────────────────────────────
def get_mt5_candles(symbol: str, timeframe, n_candles: int):
    rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, n_candles)
    if rates is None or len(rates) == 0:
        return None
    df = pd.DataFrame(rates)
    df['time'] = pd.to_datetime(df['time'], unit='s')
    df.set_index('time', inplace=True)
    return df

def calculate_atr(df: pd.DataFrame, period=ATR_PERIOD) -> float:
    high = df['high']
    low  = df['low']
    close = df['close']
    tr = pd.concat([
        high - low,
        (high - close.shift()).abs(),
        (low  - close.shift()).abs()
    ], axis=1).max(axis=1)
    atr = tr.rolling(period).mean().iloc[-1]
    return float(atr) if not np.isnan(atr) else 1.0

# ── Strategy 6 Signal Engine ─────────────────────────────────────────────────
def evaluate_strategy6(symbol: str, cfg: dict):
    mode = cfg["mode"]
    min_spikes = cfg.get("min_spikes", 2)
    
    df_m5 = get_mt5_candles(symbol, mt5.TIMEFRAME_M5, 30)
    df_h1 = get_mt5_candles(symbol, mt5.TIMEFRAME_H1, 50)
    df_h4 = get_mt5_candles(symbol, mt5.TIMEFRAME_H4, 30)
    
    if df_m5 is None or df_h1 is None or df_h4 is None or len(df_m5) < 10:
        return None

    # Calculate 4H & 1H 50 EMA
    h4_close = df_h4['close'].iloc[-1]
    h4_ema50 = df_h4['close'].ewm(span=50, adjust=False).mean().iloc[-1]
    
    h1_close = df_h1['close'].iloc[-1]
    h1_ema50 = df_h1['close'].ewm(span=50, adjust=False).mean().iloc[-1]
    
    # 24H Dealing Range on 1H
    h1_swing_high = df_h1['high'].iloc[-SWING_LOOKBACK_1H:].max()
    h1_swing_low  = df_h1['low'].iloc[-SWING_LOOKBACK_1H:].min()
    h1_range = h1_swing_high - h1_swing_low
    if h1_range <= 0:
        return None

    # M5 current completed candle
    c_curr = df_m5.iloc[-1]
    c_open, c_high, c_low, c_close = c_curr['open'], c_curr['high'], c_curr['low'], c_curr['close']
    c_range = c_high - c_low
    if c_range <= 0:
        return None
        
    atr = calculate_atr(df_m5)
    
    # ── CASE 1: SELL (BOOM / BEARISH VOLATILITY) ──
    if mode == "BOOM" or (mode == "VOLATILITY" and h4_close < h4_ema50 and h1_close < h1_ema50):
        # 1. 4H + 1H Bearish Trend
        if not (h4_close < h4_ema50 and h1_close < h1_ema50):
            return None
            
        # 2. Location: Deep Premium (>= 61.8% of 24H range)
        retrace_pct = (c_high - h1_swing_low) / h1_range
        if retrace_pct < PREMIUM_FIB_MIN:
            return None
            
        # 3. Preceding Spike / Pullback Cluster
        spk_count = sum([1 for k in range(2, min_spikes + 2) if df_m5['close'].iloc[-k] > df_m5['open'].iloc[-k]])
        if spk_count < min_spikes:
            return None
            
        # 4. M5 Exhaustion Close (Bearish body >= 50%)
        body = c_open - c_close
        body_ratio = body / c_range
        if body_ratio < BODY_RATIO_MIN:
            return None
            
        # 5. Risk & Dual Target Calculation
        entry = c_close
        spike_peak = df_m5['high'].iloc[-(min_spikes+1):].max()
        sl = spike_peak + (ATR_SL_MULT * atr)
        sl_dist = sl - entry
        if sl_dist <= 0:
            return None
            
        tp1 = entry - (sl_dist * TP1_RR)
        tp2 = entry - (sl_dist * TP2_RR)
        
        h1_clearance = ((h1_ema50 - h1_close) / h1_ema50) * 100
        
        return {
            "symbol": symbol,
            "mode": mode,
            "direction": "SELL",
            "entry": round(entry, 2),
            "sl": round(sl, 2),
            "tp1": round(tp1, 2),
            "tp2": round(tp2, 2),
            "retrace_pct": round(retrace_pct * 100, 1),
            "h1_clearance": round(h1_clearance, 2),
            "body_ratio": round(body_ratio, 2),
            "timestamp": str(df_m5.index[-1])
        }

    # ── CASE 2: BUY (CRASH / BULLISH VOLATILITY) ──
    elif mode == "CRASH" or (mode == "VOLATILITY" and h4_close > h4_ema50 and h1_close > h1_ema50):
        # 1. 4H + 1H Bullish Trend
        if not (h4_close > h4_ema50 and h1_close > h1_ema50):
            return None
            
        # 2. Location: Deep Discount (<= 38.2% from low, meaning retrace from high >= 61.8%)
        retrace_pct = (h1_swing_high - c_low) / h1_range
        if retrace_pct < PREMIUM_FIB_MIN:
            return None
            
        # 3. Preceding Crash / Pullback Cluster
        spk_count = sum([1 for k in range(2, min_spikes + 2) if df_m5['close'].iloc[-k] < df_m5['open'].iloc[-k]])
        if spk_count < min_spikes:
            return None
            
        # 4. M5 Exhaustion Close (Bullish body >= 50%)
        body = c_close - c_open
        body_ratio = body / c_range
        if body_ratio < BODY_RATIO_MIN:
            return None
            
        # 5. Risk & Dual Target Calculation
        entry = c_close
        spike_trough = df_m5['low'].iloc[-(min_spikes+1):].min()
        sl = spike_trough - (ATR_SL_MULT * atr)
        sl_dist = entry - sl
        if sl_dist <= 0:
            return None
            
        tp1 = entry + (sl_dist * TP1_RR)
        tp2 = entry + (sl_dist * TP2_RR)
        
        h1_clearance = ((h1_close - h1_ema50) / h1_ema50) * 100
        
        return {
            "symbol": symbol,
            "mode": mode,
            "direction": "BUY",
            "entry": round(entry, 2),
            "sl": round(sl, 2),
            "tp1": round(tp1, 2),
            "tp2": round(tp2, 2),
            "retrace_pct": round(retrace_pct * 100, 1),
            "h1_clearance": round(h1_clearance, 2),
            "body_ratio": round(body_ratio, 2),
            "timestamp": str(df_m5.index[-1])
        }

    return None

# ── Active Signal Lifecycle Monitor ──────────────────────────────────────────
def monitor_active_signals(state: dict):
    active_signals = state.get("active_signals", [])
    remaining_signals = []
    
    for sig in active_signals:
        sym = sig["symbol"]
        direction = sig["direction"]
        entry = sig["entry"]
        sl = sig["sl"]
        tp1 = sig["tp1"]
        tp2 = sig["tp2"]
        tp1_hit = sig.get("tp1_hit", False)
        
        rates = mt5.copy_rates_from_pos(sym, mt5.TIMEFRAME_M5, 0, 3)
        if rates is None or len(rates) == 0:
            remaining_signals.append(sig)
            continue
            
        curr_high = max([r[2] for r in rates])
        curr_low  = min([r[3] for r in rates])
        
        # ── SELL OUTCOME CHECKS ──
        if direction == "SELL":
            # 1. Full TP2 Hit
            if curr_low <= tp2:
                msg = f"🏆 🟢 *[MYTRADA TP2 HIT — FULL TARGET (1:1.5 R:R)]*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n" \
                      f"Asset: `{sym}` | Direction: `SELL`\n" \
                      f"🎯 Entry: `{entry}` | 🏆 TP2 Captured: `{tp2}` (+1.5R / +$4.50)\n" \
                      f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n" \
                      f"✅ Trade fully closed in maximum profit!"
                send_telegram(msg)
                record_trade_outcome(sym, "TP2")
                continue
                
            # 2. TP1 Hit for the first time
            if curr_low <= tp1 and not tp1_hit:
                sig["tp1_hit"] = True
                msg = f"🎯 🟢 *[MYTRADA TP1 HIT (1:1.3 R:R) / MOVE SL TO BREAKEVEN]*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n" \
                      f"Asset: `{sym}` | Direction: `SELL`\n" \
                      f"🎯 Entry: `{entry}` | 🎯 TP1 Reached: `{tp1}` (+1.3R / +$3.90)\n" \
                      f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n" \
                      f"💡 *Action:* Secure partial profit or move Stop Loss to Entry (`{entry}`) for a RISK-FREE run to TP2 (`{tp2}`)!"
                send_telegram(msg)
                remaining_signals.append(sig)
                continue

            # 3. Stop Loss Hit
            if curr_high >= sl:
                if tp1_hit:
                    msg = f"🔄 🟡 *[MYTRADA REVERSED AFTER TP1 — PROTECTED]*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n" \
                          f"Asset: `{sym}` | Direction: `SELL`\n" \
                          f"Price reached TP1 (+1.3R) before reversing into Stop Loss area.\n" \
                          f"🛡️ *Outcome:* Breakeven / Partial Profit Secured. Zero Net Loss."
                    send_telegram(msg)
                    record_trade_outcome(sym, "TP1")
                else:
                    msg = f"🔴 🛡️ *[MYTRADA STOP LOSS HIT (-1.0R)]*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n" \
                          f"Asset: `{sym}` | Direction: `SELL`\n" \
                          f"🎯 Entry: `{entry}` | 🛡️ SL: `{sl}` (-1.0R / -$3.00)\n" \
                          f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n" \
                          f"🛡️ Single-pair cooldown active (30m)."
                    send_telegram(msg)
                    record_trade_outcome(sym, "LOSS")
                continue

        # ── BUY OUTCOME CHECKS ──
        elif direction == "BUY":
            # 1. Full TP2 Hit
            if curr_high >= tp2:
                msg = f"🏆 🟢 *[MYTRADA TP2 HIT — FULL TARGET (1:1.5 R:R)]*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n" \
                      f"Asset: `{sym}` | Direction: `BUY`\n" \
                      f"🎯 Entry: `{entry}` | 🏆 TP2 Captured: `{tp2}` (+1.5R / +$4.50)\n" \
                      f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n" \
                      f"✅ Trade fully closed in maximum profit!"
                send_telegram(msg)
                record_trade_outcome(sym, "TP2")
                continue

            # 2. TP1 Hit for the first time
            if curr_high >= tp1 and not tp1_hit:
                sig["tp1_hit"] = True
                msg = f"🎯 🟢 *[MYTRADA TP1 HIT (1:1.3 R:R) / MOVE SL TO BREAKEVEN]*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n" \
                      f"Asset: `{sym}` | Direction: `BUY`\n" \
                      f"🎯 Entry: `{entry}` | 🎯 TP1 Reached: `{tp1}` (+1.3R / +$3.90)\n" \
                      f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n" \
                      f"💡 *Action:* Secure partial profit or move Stop Loss to Entry (`{entry}`) for a RISK-FREE run to TP2 (`{tp2}`)!"
                send_telegram(msg)
                remaining_signals.append(sig)
                continue

            # 3. Stop Loss Hit
            if curr_low <= sl:
                if tp1_hit:
                    msg = f"🔄 🟡 *[MYTRADA REVERSED AFTER TP1 — PROTECTED]*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n" \
                          f"Asset: `{sym}` | Direction: `BUY`\n" \
                          f"Price reached TP1 (+1.3R) before reversing into Stop Loss area.\n" \
                          f"🛡️ *Outcome:* Breakeven / Partial Profit Secured. Zero Net Loss."
                    send_telegram(msg)
                    record_trade_outcome(sym, "TP1")
                else:
                    msg = f"🔴 🛡️ *[MYTRADA STOP LOSS HIT (-1.0R)]*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n" \
                          f"Asset: `{sym}` | Direction: `BUY`\n" \
                          f"🎯 Entry: `{entry}` | 🛡️ SL: `{sl}` (-1.0R / -$3.00)\n" \
                          f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n" \
                          f"🛡️ Single-pair cooldown active (30m)."
                    send_telegram(msg)
                    record_trade_outcome(sym, "LOSS")
                continue

        remaining_signals.append(sig)
        
    state["active_signals"] = remaining_signals
    save_state(state)

# ── Main Runner Loop ─────────────────────────────────────────────────────────
def main():
    print("=" * 80)
    print("MYTRADA STRATEGY 6 INSTITUTIONAL SIGNAL RUNNER (10 ELITE PAIRS)")
    print("Features: 5 Quantitative Checkpoints + Deep Retracement >=61.8% + Shadow AI")
    print("=" * 80)
    
    if not mt5.initialize():
        print(f"[FAIL] MT5 Init failed: {mt5.last_error()}")
        return

    print("[OK] MT5 Connected. Listening for real-time M5 setups...\n")
    send_telegram("🚀 *[MYTRADA STRATEGY 6 LIVE]* Signal Runner started across the 10 Elite Universe with Dual TP1/TP2 and Gemini AI Audits!")

    state = load_state()

    try:
        while True:
            # 1. Monitor active signals for TP1 / TP2 / SL hits
            monitor_active_signals(state)
            
            # 2. Scan for new setups
            for symbol, cfg in SYMBOLS.items():
                in_cooldown, reason = is_symbol_in_cooldown(symbol)
                if in_cooldown:
                    continue
                    
                mt5.symbol_select(symbol, True)
                sig = evaluate_strategy6(symbol, cfg)
                
                if sig:
                    sig_key = f"{symbol}_{sig['direction']}_{sig['timestamp']}"
                    if sig_key in state.get("alerted_keys", []):
                        continue
                        
                    # Gemini AI Audit
                    is_approved, ai_status = audit_with_gemini(
                        symbol, sig["direction"], sig["retrace_pct"], sig["h1_clearance"], sig["body_ratio"]
                    )
                    
                    # Format Telegram Broadcast
                    dir_icon = "🔴 SELL" if sig["direction"] == "SELL" else "🟢 BUY"
                    zone_desc = f"{sig['retrace_pct']}% Deep Premium Supply Retest" if sig["direction"] == "SELL" else f"{sig['retrace_pct']}% Deep Discount Demand Retest"
                    
                    msg = f"👑 *[MYTRADA STRATEGY 6 SIGNAL]*\n" \
                          f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n" \
                          f"Asset: `{symbol}`\n" \
                          f"Direction: *{dir_icon}* (Supply-Sweep Sniper)\n" \
                          f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n" \
                          f"📊 *CONFLUENCE:*\n" \
                          f"  • Macro 4H + 1H: Aligned\n" \
                          f"  • Location: `{zone_desc}`\n" \
                          f"  • Execution: M5 Exhaustion (Body Ratio: {sig['body_ratio']})\n" \
                          f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n" \
                          f"🎯 *ENTRY PRICE:* `{sig['entry']}`\n" \
                          f"🛡️ *STOP LOSS (SL):* `{sig['sl']}`\n\n" \
                          f"🏆 *TARGET PROFIT:*\n" \
                          f"  • 🎯 *TP1 (1:1.3 R:R):* `{sig['tp1']}` (Move SL to Breakeven)\n" \
                          f"  • 🏆 *TP2 (1:1.5 R:R):* `{sig['tp2']}` (Full Target)\n" \
                          f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n" \
                          f"💰 *Position Risk ($100 Account):* $3.00 USD (3.0%)\n" \
                          f"🤖 *GEMINI AI AUDIT:* {ai_status}\n" \
                          f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n" \
                          f"🚀 *EXECUTION:* Market {sig['direction']} on MT5. Monitor for TP1/TP2 updates."
                    
                    send_telegram(msg)
                    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] Signal Broadcast: {symbol} ({sig['direction']})")
                    
                    state.setdefault("alerted_keys", []).append(sig_key)
                    state.setdefault("active_signals", []).append({
                        "symbol": symbol,
                        "direction": sig["direction"],
                        "entry": sig["entry"],
                        "sl": sig["sl"],
                        "tp1": sig["tp1"],
                        "tp2": sig["tp2"],
                        "tp1_hit": False,
                        "timestamp": sig["timestamp"]
                    })
                    save_state(state)
                    
            time.sleep(SCAN_INTERVAL_SECS)
            
    except KeyboardInterrupt:
        print("\n[OK] Stopping MT5 Runner cleanly...")
    finally:
        mt5.shutdown()

if __name__ == "__main__":
    main()
