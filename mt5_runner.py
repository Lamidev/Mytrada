# mt5_runner.py
"""
Mytrada - Institutional Spike Exhaustion MT5 Signal Bot
=========================================================
Strategy: Strategy 5 Enhanced (Multi-Timeframe 4H+1H + 3 Spikes + 1:1.3 R:R + Tiered Circuit Breakers)
Portfolio: Top 7 Elite Pairs (Boom 300, Boom 200, Crash 99, Boom 600, Boom 500, Crash 100, Crash 600)
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
RISK_AMOUNT_USD    = 3.0      # $3.00 risk baseline per trade for $100 account (3% risk)
REWARD_RATIO       = 1.3      # 1:1.3 R:R (Optimal Deriv Reversal Velocity)
MIN_SPIKES         = 3        # Deep 3-spike exhaustion burst
ATR_PERIOD         = 14
ATR_SL_MULT        = 1.5      # SL = spike peak + (1.5 × ATR)
SCAN_INTERVAL_SECS = 15       # Fast scan interval for instant candle-close signals
MAX_CORRELATED_EXPOSURE = 3   # Max 3 active signals per group (BOOM or CRASH)
USE_HTF_CHOP_FILTER = True    # Filter out flat 50 EMA chop

STATE_FILE_PATH = os.path.join(os.path.dirname(__file__), "cache", "signal_state.json")
CIRCUIT_BREAKER_FILE = os.path.join(os.path.dirname(__file__), "cache", "circuit_breaker_state.json")

# ── Top 7 Elite Portfolio ───────────────────────────────────────────────────
SYMBOLS = {
    # Top BOOM Pairs → SELL ONLY in 4H + 1H Bearish Trend
    "Boom 300 Index":  {"mode": "BOOM"},
    "Boom 200 Index":  {"mode": "BOOM"},
    "Boom 600 Index":  {"mode": "BOOM"},
    "Boom 500 Index":  {"mode": "BOOM"},

    # Top CRASH Pairs → BUY ONLY in 4H + 1H Bullish Trend
    "Crash 99 Index":  {"mode": "CRASH"},
    "Crash 100 Index": {"mode": "CRASH"},
    "Crash 600 Index": {"mode": "CRASH"},
}

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
    today_str = datetime.datetime.utcnow().strftime("%Y-%m-%d")
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
        return True, f"Tiered cooldown active — {rem_mins}m remaining"
    
    return False, ""

def record_trade_outcome(symbol: str, outcome: str):
    cb = load_circuit_breaker()
    if symbol not in cb["symbols"]:
        cb["symbols"][symbol] = {"consecutive_losses": 0, "daily_losses": 0, "pause_until": 0}
    
    rec = cb["symbols"][symbol]
    now_ms = time.time() * 1000

    if outcome == "WIN":
        rec["consecutive_losses"] = 0
    elif outcome == "LOSS":
        rec["consecutive_losses"] += 1
        rec["daily_losses"] += 1
        if rec["daily_losses"] >= 3:
            rec["pause_until"] = now_ms + (24 * 3600 * 1000)
        elif rec["consecutive_losses"] >= 2:
            rec["pause_until"] = now_ms + (150 * 60 * 1000)
        elif rec["consecutive_losses"] == 1:
            rec["pause_until"] = now_ms + (45 * 60 * 1000)
    
    save_circuit_breaker(cb)

# ── Telegram ─────────────────────────────────────────────────────────────────
def send_telegram(html_message: str):
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print(f"[TELEGRAM MOCK]\n{html_message}\n")
        return
    try:
        requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            json={
                "chat_id": TELEGRAM_CHAT_ID,
                "text": html_message,
                "parse_mode": "HTML",
                "disable_web_page_preview": True
            },
            timeout=10
        )
    except Exception as e:
        print(f"[Telegram Error] {e}")

# ── Technical Indicators ─────────────────────────────────────────────────────
def calc_ema(series: pd.Series, period: int = 50) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()

def calc_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    high = df['high']
    low  = df['low']
    close_prev = df['close'].shift(1)
    tr = pd.concat([
        high - low,
        (high - close_prev).abs(),
        (low - close_prev).abs()
    ], axis=1).max(axis=1)
    return tr.rolling(window=period).mean()

def get_candles(symbol: str, timeframe, count: int = 200) -> pd.DataFrame:
    rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, count)
    if rates is None or len(rates) == 0:
        return None
    df = pd.DataFrame(rates)
    df['time'] = pd.to_datetime(df['time'], unit='s')
    return df

def get_dynamic_lot_size(symbol: str, entry: float, sl: float) -> float:
    info = mt5.symbol_info(symbol)
    if info is None:
        return 0.20
    
    vol_min  = info.volume_min
    vol_step = info.volume_step
    vol_max  = info.volume_max
    
    sl_distance = abs(entry - sl)
    if sl_distance <= 0:
        return vol_min

    tick_size = info.trade_tick_size or 0.01
    tick_val  = info.trade_tick_value or 1.0

    risk_per_lot = (sl_distance / tick_size) * tick_val
    if risk_per_lot <= 0:
        return vol_min

    raw_lot = RISK_AMOUNT_USD / risk_per_lot
    stepped_lot = round(raw_lot / vol_step) * vol_step
    final_lot = max(vol_min, min(vol_max, round(stepped_lot, 2)))
    return final_lot

# ── Strategy 5 Enhanced Detection ────────────────────────────────────────────
def detect_spike_exhaustion(ltf_df: pd.DataFrame, htf1h_df: pd.DataFrame, htf4h_df: pd.DataFrame, mode: str):
    if ltf_df is None or htf1h_df is None or len(ltf_df) < 25 or len(htf1h_df) < 55:
        return None

    # 1. 1H Trend & Chop Filter
    htf1h_df['ema50'] = calc_ema(htf1h_df['close'], 50)
    htf1h_close = htf1h_df['close'].iloc[-2] if len(htf1h_df) >= 2 else htf1h_df['close'].iloc[-1]
    htf1h_ema   = htf1h_df['ema50'].iloc[-2] if len(htf1h_df) >= 2 else htf1h_df['ema50'].iloc[-1]
    htf1h_trend = 'bullish' if htf1h_close > htf1h_ema else 'bearish'

    if mode == "BOOM" and htf1h_trend != 'bearish':
        return None
    if mode == "CRASH" and htf1h_trend != 'bullish':
        return None

    ema_dist_pct = abs(htf1h_close - htf1h_ema) / htf1h_ema
    if USE_HTF_CHOP_FILTER and ema_dist_pct < 0.0008:
        return None

    # 2. 4H Macro Trend Filter
    htf4h_trend = "aligned"
    if htf4h_df is not None and len(htf4h_df) >= 55:
        htf4h_df['ema50'] = calc_ema(htf4h_df['close'], 50)
        htf4h_close = htf4h_df['close'].iloc[-2] if len(htf4h_df) >= 2 else htf4h_df['close'].iloc[-1]
        htf4h_ema   = htf4h_df['ema50'].iloc[-2] if len(htf4h_df) >= 2 else htf4h_df['ema50'].iloc[-1]
        htf4h_trend = 'bullish' if htf4h_close > htf4h_ema else 'bearish'

        if mode == "BOOM" and htf4h_trend != 'bearish':
            return None
        if mode == "CRASH" and htf4h_trend != 'bullish':
            return None

    # 3. 5M Completed Candles
    c0 = ltf_df.iloc[-2]   # Completed exhaustion candle candidate
    c1 = ltf_df.iloc[-3]   # Spike candle 1
    c2 = ltf_df.iloc[-4]   # Spike candle 2
    c3 = ltf_df.iloc[-5]   # Spike candle 3 (3 consecutive spikes required)

    ltf_df['atr'] = calc_atr(ltf_df)
    atr_val = ltf_df['atr'].iloc[-2]
    if pd.isna(atr_val) or atr_val == 0:
        return None

    c0_range = c0['high'] - c0['low']
    c0_body  = abs(c0['close'] - c0['open'])

    if mode == "BOOM":
        # Previous 3 candles must be bullish spikes
        c1_is_spike = c1['close'] > c1['open']
        c2_is_spike = c2['close'] > c2['open']
        c3_is_spike = c3['close'] > c3['open']

        # c0 must be bearish with solid body >= 50%
        c0_is_exhaustion = (
            c0['close'] < c0['open'] and
            c0_range > 0 and
            (c0_body / c0_range) >= 0.5
        )

        if not (c1_is_spike and c2_is_spike and c3_is_spike and c0_is_exhaustion):
            return None

        spike_peak = max(c1['high'], c2['high'], c3['high'], c0['high'])
        entry = c0['close']
        sl    = spike_peak + (atr_val * ATR_SL_MULT)
        sl_dist = abs(entry - sl)
        tp    = entry - (sl_dist * REWARD_RATIO)

    else:  # CRASH
        # Previous 3 candles must be bearish crashes
        c1_is_crash = c1['close'] < c1['open']
        c2_is_crash = c2['close'] < c2['open']
        c3_is_crash = c3['close'] < c3['open']

        # c0 must be bullish with solid body >= 50%
        c0_is_exhaustion = (
            c0['close'] > c0['open'] and
            c0_range > 0 and
            (c0_body / c0_range) >= 0.5
        )

        if not (c1_is_crash and c2_is_crash and c3_is_crash and c0_is_exhaustion):
            return None

        crash_trough = min(c1['low'], c2['low'], c3['low'], c0['low'])
        entry = c0['close']
        sl    = crash_trough - (atr_val * ATR_SL_MULT)
        sl_dist = abs(entry - sl)
        tp    = entry + (sl_dist * REWARD_RATIO)

    candle_time_str = c0['time'].strftime('%Y-%m-%d %H:%M:%S')
    spike_ref_val = spike_peak if mode == "BOOM" else crash_trough

    return {
        'mode':            mode,
        'entry':           entry,
        'sl':              sl,
        'tp':              tp,
        'sl_dist':         sl_dist,
        'atr':             atr_val,
        'htf1h_trend':     htf1h_trend,
        'htf4h_trend':     htf4h_trend,
        'candle_time_str': candle_time_str,
        'candle_epoch':    int(c0['time'].timestamp()),
        'spike_ref':       spike_ref_val
    }

# ── Telegram Signal Alert Builder ────────────────────────────────────────────
def build_signal_alert(symbol: str, setup: dict, lot_size: float) -> str:
    direction_str = "SELL" if setup['mode'] == "BOOM" else "BUY"
    dir_emoji     = "🔴" if setup['mode'] == "BOOM" else "🟢"
    ref_label     = "Spike Peak" if setup['mode'] == "BOOM" else "Crash Trough"

    return (
        f"👑 {dir_emoji} <b>[MYTRADA SPIKE EXHAUSTION SIGNAL]</b>\n"
        f"<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n"
        f"<b>Strategy:</b> <code>Strategy 5 Enhanced (Multi-TF + 3 Spikes)</code>\n"
        f"<b>Asset:</b> <code>{symbol}</code>\n"
        f"<b>Direction:</b> {dir_emoji} <b>{direction_str} ({setup['mode']} 3-Spike Exhaustion)</b>\n"
        f"<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n"
        f"📊 <b>MULTI-TIMEFRAME CONFLUENCE:</b>\n"
        f"  • <b>4H Macro Trend:</b> <code>{setup['htf4h_trend'].upper()} (Aligned)</code>\n"
        f"  • <b>1H Intermediate:</b> <code>{setup['htf1h_trend'].upper()} (Clearance > 0.08%)</code>\n"
        f"  • <b>5M Execution:</b> <code>3 Consecutive Spikes + Reversal Close</code>\n"
        f"<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n"
        f"🎯 <b>ENTRY PRICE:</b> <code>{setup['entry']:.2f}</code> (Market — 5M Close)\n"
        f"🛡️ <b>STOP LOSS (SL):</b> <code>{setup['sl']:.2f}</code> ({ref_label} {setup['spike_ref']:.2f} + {ATR_SL_MULT}x ATR)\n"
        f"🏆 <b>TAKE PROFIT (TP):</b> <code>{setup['tp']:.2f}</code> (1:{REWARD_RATIO} R:R Target)\n"
        f"<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n"
        f"💰 <b>Position Sizing ($100 Account):</b>\n"
        f"  • Recommended Lot: <code>{lot_size} Lots</code>\n"
        f"  • Max Risk (SL Hit): <code>-${RISK_AMOUNT_USD:.2f} USD (-1.0R / 3.0%)</code>\n"
        f"  • Target Profit (TP Hit): <code>+${RISK_AMOUNT_USD * REWARD_RATIO:.2f} USD (+{REWARD_RATIO}R / +3.9%)</code>\n"
        f"  • Circuit Breaker: <code>Active (45m/2.5h Tiered Pause)</code>\n"
        f"<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n"
        f"🚀 <b>EXECUTION:</b> <code>Enter MARKET {direction_str} on MT5. Hold strictly to TP or SL.</code>"
    )

# ── Telegram Outcome Alert Builder ───────────────────────────────────────────
def build_outcome_alert(signal: dict, outcome: str, exit_price: float, pnl_usd: float, pnl_r: float) -> str:
    if outcome == "WIN":
        header = "🏆 <b>[MYTRADA SPIKE EXHAUSTION OUTCOME: DIRECT TP HIT]</b>"
        outcome_str = f"🟢 <b>OUTCOME: TAKE PROFIT HIT! (+{REWARD_RATIO}R)</b>\n<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n💰 <b>TOTAL REALIZED PROFIT:</b> <code>+${pnl_usd:.2f} USD (+{pnl_r:.2f}R)</code>"
    else:
        header = "🛡️ <b>[MYTRADA SPIKE EXHAUSTION OUTCOME: STOP LOSS HIT]</b>"
        outcome_str = f"🔴 <b>OUTCOME: STOP LOSS HIT (-1.0R)</b>\n<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n💸 <b>TOTAL REALIZED LOSS:</b> <code>-${abs(pnl_usd):.2f} USD ({pnl_r:.2f}R)</code>"

    return (
        f"{header}\n"
        f"<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n"
        f"<b>Asset:</b> <code>{signal['symbol']}</code>\n"
        f"<b>Direction:</b> {'🔴 SELL' if signal['mode'] == 'BOOM' else '🟢 BUY'}\n"
        f"{outcome_str}\n"
        f"<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n"
        f"🔥 <b>Entry Price:</b> <code>{signal['entry']:.2f}</code>\n"
        f"🛡️ <b>Stop Loss (SL):</b> <code>{signal['sl']:.2f}</code>\n"
        f"🏆 <b>Take Profit (TP):</b> <code>{signal['tp']:.2f}</code>\n"
        f"<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n"
        f"ℹ️ <i>Check your Metatrader 5 terminal balance sheet!</i>"
    )

# ── Monitor Active Trades ─────────────────────────────────────────────────────
def check_active_signal_outcomes(state: dict):
    active_signals = state.get("active_signals", [])
    if not active_signals:
        return

    remaining_signals = []
    state_changed = False

    for sig in active_signals:
        symbol = sig['symbol']
        mode   = sig['mode']
        entry  = sig['entry']
        sl     = sig['sl']
        tp     = sig['tp']

        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            remaining_signals.append(sig)
            continue

        curr_price = tick.bid if mode == "BOOM" else tick.ask
        hit_tp = False
        hit_sl = False

        if mode == "BOOM":
            if curr_price <= tp:
                hit_tp = True
            elif curr_price >= sl:
                hit_sl = True
        else:
            if curr_price >= tp:
                hit_tp = True
            elif curr_price <= sl:
                hit_sl = True

        if hit_tp or hit_sl:
            outcome_type = "WIN" if hit_tp else "LOSS"
            exit_price = tp if hit_tp else sl
            pnl_usd = (RISK_AMOUNT_USD * REWARD_RATIO) if hit_tp else -RISK_AMOUNT_USD
            pnl_r = REWARD_RATIO if hit_tp else -1.0

            record_trade_outcome(symbol, outcome_type)
            alert_html = build_outcome_alert(sig, outcome_type, exit_price, pnl_usd, pnl_r)
            send_telegram(alert_html)
            print(f"  [OUTCOME ALERT] {symbol} | Result: {outcome_type} | PnL: ${pnl_usd:+.2f} USD")
            state_changed = True
        else:
            remaining_signals.append(sig)

    if state_changed:
        state['active_signals'] = remaining_signals
        save_state(state)

# ── Main Bot Loop ─────────────────────────────────────────────────────────────
def run_bot():
    print("=" * 80)
    print(" MYTRADA - STRATEGY 5 ENHANCED TELEGRAM ALERT BOT")
    print(" Top 7 Elite Pairs | Multi-TF (4H+1H) | 3 Spikes | 1:1.3 R:R | Circuit Breakers")
    print("=" * 80)

    if not mt5.initialize():
        print(f"[ERROR] MT5 failed to initialize: {mt5.last_error()}")
        return

    acc = mt5.account_info()
    if acc:
        print(f"[MT5 Connected] Account: {acc.login} | Server: {acc.server}")
        print(f"[MT5 Balance]   ${acc.balance:,.2f} | Equity: ${acc.equity:,.2f}")

    state = load_state()
    alerted_keys = set(state.get("alerted_keys", []))

    try:
        while True:
            now_str = datetime.datetime.now().strftime("%H:%M:%S")
            print(f"\n[{now_str}] Scanning {len(SYMBOLS)} pairs for Strategy 5 Enhanced setups...")

            check_active_signal_outcomes(state)

            for symbol, meta in SYMBOLS.items():
                try:
                    mode = meta['mode']

                    cb_in_cooldown, cb_reason = is_symbol_in_cooldown(symbol)
                    if cb_in_cooldown:
                        print(f"  [{mode}] {symbol:<20} | 🛡️ COOLDOWN: {cb_reason}")
                        continue

                    if any(s['symbol'] == symbol for s in state.get("active_signals", [])):
                        print(f"  [{mode}] {symbol:<20} | Active trade open — skipping")
                        continue

                    if not mt5.symbol_select(symbol, True):
                        continue

                    ltf_df   = get_candles(symbol, mt5.TIMEFRAME_M5, 50)
                    htf1h_df = get_candles(symbol, mt5.TIMEFRAME_H1, 100)
                    htf4h_df = get_candles(symbol, mt5.TIMEFRAME_H4, 100)
                    if ltf_df is None or htf1h_df is None:
                        continue

                    setup = detect_spike_exhaustion(ltf_df, htf1h_df, htf4h_df, mode)

                    if setup:
                        alert_key = f"{symbol}_{mode}_{setup['candle_epoch']}"

                        if alert_key not in alerted_keys:
                            alerted_keys.add(alert_key)
                            lot_size = get_dynamic_lot_size(symbol, setup['entry'], setup['sl'])

                            alert_html = build_signal_alert(symbol, setup, lot_size)
                            send_telegram(alert_html)

                            new_signal_record = {
                                "setup_id":     alert_key,
                                "symbol":       symbol,
                                "mode":         mode,
                                "entry":        setup['entry'],
                                "sl":           setup['sl'],
                                "tp":           setup['tp'],
                                "sl_dist":      setup['sl_dist'],
                                "lot_size":     lot_size,
                                "candle_time":  setup['candle_time_str'],
                                "candle_epoch": setup['candle_epoch']
                            }
                            state["active_signals"].append(new_signal_record)
                            state["alerted_keys"] = list(alerted_keys)[-500:]
                            save_state(state)

                            print(f"  [{mode}] {symbol:<20} | 📢 SIGNAL SENT ({setup['candle_time_str']})")
                        else:
                            print(f"  [{mode}] {symbol:<20} | Setup already alerted")
                    else:
                        print(f"  [{mode}] {symbol:<20} | Waiting for 3-spike exhaustion...")

                except Exception as e:
                    print(f"  [ERROR] {symbol}: {e}")
                    continue

            time.sleep(SCAN_INTERVAL_SECS)

    except KeyboardInterrupt:
        print("\n[MYTRADA] Bot stopped by user.")
    finally:
        mt5.shutdown()

if __name__ == "__main__":
    run_bot()
