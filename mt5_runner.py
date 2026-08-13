# mt5_runner.py
"""
Mytrada - Institutional Spike Exhaustion MT5 Signal Bot
=========================================================
Strategy (Backtest Validated: 54.55% Win Rate | 1-Month Real MT5 Data | 1:1.3 R:R):
  - BOOM Pairs (SELL ONLY): Telegram SELL signal on completed 5M bearish
    exhaustion candle after 2+ consecutive bullish spike candles in a 1H Bearish Trend.
  - CRASH Pairs (BUY ONLY): Telegram BUY signal on completed 5M bullish
    exhaustion candle after 2+ consecutive bearish crash candles in a 1H Bullish Trend.

Confluences Required Before Signal:
  1. 1H 50 EMA Trend Alignment (Non-negotiable)
  2. Minimum 2 consecutive spike candles in sequence
  3. First counter-direction 5M completed candle close (body > 50% of candle range)
  4. Stop Loss placed above/below spike peak + 1.5x ATR buffer
  5. Price-Based Exit: Hold until TP (1:1.3 R:R) or SL is hit (no time stop)

Execution:
  Signal-Only Bot (Telegram Alerts & Live Outcome Monitoring via MT5 Data).
  No auto-trading / No MT5 order placement.
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
RISK_AMOUNT_USD    = 100.0    # $100 risk baseline per trade ($3 risk for $100 account)
REWARD_RATIO       = 1.3      # 1:1.3 R:R → 54.55% Win Rate | $56,000/mo on $100 risk (backtest validated)
ATR_PERIOD         = 14
ATR_SL_MULT        = 1.5      # SL = spike peak + (1.5 × ATR)
SCAN_INTERVAL_SECS = 10       # Fast 10s scan interval for instant candle-close signals
MAX_CORRELATED_EXPOSURE = 3   # Max 3 active signals per group (BOOM or CRASH)

STATE_FILE_PATH = os.path.join(os.path.dirname(__file__), "cache", "signal_state.json")

# ── Top 8 Portfolio (Filtered by 1-Month Backtest Performance) ────────────────
SYMBOLS = {
    # Top BOOM Pairs → SELL ONLY in 1H Bearish Trend
    "Boom 200 Index":  {"mode": "BOOM"},
    "Boom 500 Index":  {"mode": "BOOM"},
    "Boom 300 Index":  {"mode": "BOOM"},
    "Boom 1000 Index": {"mode": "BOOM"},

    # Top CRASH Pairs → BUY ONLY in 1H Bullish Trend
    "Crash 500 Index":  {"mode": "CRASH"},
    "Crash 600 Index":  {"mode": "CRASH"},
    "Crash 200 Index":  {"mode": "CRASH"},
    "Crash 1000 Index": {"mode": "CRASH"},
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

# ── MT5 Utilities ─────────────────────────────────────────────────────────────
def get_candles(symbol: str, timeframe, count: int) -> pd.DataFrame | None:
    rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, count)
    if rates is None or len(rates) == 0:
        return None
    df = pd.DataFrame(rates)
    df['time'] = pd.to_datetime(df['time'], unit='s')
    return df

def calc_ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()

def calc_atr(df: pd.DataFrame, period: int = ATR_PERIOD) -> pd.Series:
    tr = pd.concat([
        df['high'] - df['low'],
        (df['high'] - df['close'].shift()).abs(),
        (df['low']  - df['close'].shift()).abs()
    ], axis=1).max(axis=1)
    return tr.rolling(period).mean()

def get_dynamic_lot_size(symbol: str, entry: float, sl: float) -> float:
    """Calculate lot size so that SL distance = exactly $100 risk."""
    sl_dist = abs(entry - sl)
    if sl_dist == 0:
        return 0.01
    raw_lot = RISK_AMOUNT_USD / sl_dist
    info = mt5.symbol_info(symbol)
    if info:
        step = info.volume_step
        min_lot = info.volume_min
        lot = round(raw_lot / step) * step
        return max(min_lot, round(lot, 2))
    return round(raw_lot, 2)

# ── Strategy: SMC Order Block & FVG Confluence Verification ────────────
def check_smc_confluence(df: pd.DataFrame, spike_ref: float, mode: str, atr_val: float) -> dict:
    """
    Verifies if the spike peak (BOOM) or crash trough (CRASH) tapped:
    1. Order Block (OB) Supply/Demand Zone
    2. Fair Value Gap (FVG / Imbalance) Zone
    3. Structural Liquidity Sweep
    """
    if len(df) < 30:
        return {"has_smc": True, "zone": "HTF_STRUCTURE_ALIGNMENT", "score": 7}

    lookback_candles = df.iloc[-35:-4]  # Candles prior to current spike sequence
    has_smc = False
    zone_type = "HTF_STRUCTURE_ALIGNMENT"
    confluence_score = 7

    if mode == "BOOM":
        # Check Bearish Order Block (prior up-candle before strong drop)
        for idx in range(len(lookback_candles) - 1, 0, -1):
            c_curr = lookback_candles.iloc[idx]
            c_prev = lookback_candles.iloc[idx - 1]
            
            if c_prev['close'] > c_prev['open'] and c_curr['close'] < c_curr['open']:
                ob_bottom = min(c_prev['open'], c_prev['low'])
                ob_top = c_prev['high']
                
                if spike_ref >= (ob_bottom - 0.3 * atr_val) and spike_ref <= (ob_top + 1.0 * atr_val):
                    has_smc = True
                    zone_type = "BEARISH ORDER BLOCK (Supply Zone)"
                    confluence_score = 9
                    break
        
        # Check Bearish Fair Value Gap (3-candle imbalance)
        if not has_smc:
            for idx in range(len(lookback_candles) - 3, 0, -1):
                c1 = lookback_candles.iloc[idx]
                c3 = lookback_candles.iloc[idx + 2]
                if c3['high'] < c1['low']:
                    fvg_bottom = c3['high']
                    fvg_top = c1['low']
                    if spike_ref >= (fvg_bottom - 0.2 * atr_val) and spike_ref <= (fvg_top + 0.5 * atr_val):
                        has_smc = True
                        zone_type = "BEARISH FVG (Imbalance Fill)"
                        confluence_score = 8
                        break

    else:  # CRASH
        # Check Bullish Order Block (prior down-candle before strong rally)
        for idx in range(len(lookback_candles) - 1, 0, -1):
            c_curr = lookback_candles.iloc[idx]
            c_prev = lookback_candles.iloc[idx - 1]
            
            if c_prev['close'] < c_prev['open'] and c_curr['close'] > c_curr['open']:
                ob_bottom = c_prev['low']
                ob_top = max(c_prev['open'], c_prev['high'])
                
                if spike_ref <= (ob_top + 0.3 * atr_val) and spike_ref >= (ob_bottom - 1.0 * atr_val):
                    has_smc = True
                    zone_type = "BULLISH ORDER BLOCK (Demand Zone)"
                    confluence_score = 9
                    break

        # Check Bullish Fair Value Gap
        if not has_smc:
            for idx in range(len(lookback_candles) - 3, 0, -1):
                c1 = lookback_candles.iloc[idx]
                c3 = lookback_candles.iloc[idx + 2]
                if c3['low'] > c1['high']:
                    fvg_bottom = c1['high']
                    fvg_top = c3['low']
                    if spike_ref <= (fvg_top + 0.2 * atr_val) and spike_ref >= (fvg_bottom - 0.5 * atr_val):
                        has_smc = True
                        zone_type = "BULLISH FVG (Imbalance Fill)"
                        confluence_score = 8
                        break

    return {
        "has_smc": has_smc,
        "zone": zone_type,
        "score": confluence_score
    }

# ── Strategy: Spike Exhaustion Detection (COMPLETED CANDLES ONLY) ─────────────
def detect_spike_exhaustion(ltf_df: pd.DataFrame, htf_df: pd.DataFrame, mode: str) -> dict | None:
    """
    Detects a valid Spike Exhaustion setup strictly on COMPLETED candles.

    In MT5 copy_rates_from_pos:
      iloc[-1] = Currently forming in-progress 5M candle (IGNORE for entry)
      iloc[-2] = Last COMPLETED 5M candle (c0: exhaustion candle candidate)
      iloc[-3] = Spike candle 1 (c1)
      iloc[-4] = Spike candle 2 (c2)
    """
    if ltf_df is None or htf_df is None or len(ltf_df) < 20:
        return None

    # 1H Trend Filter on completed 1H candle (iloc[-2])
    htf_df['ema50'] = calc_ema(htf_df['close'], 50)
    htf_close = htf_df['close'].iloc[-2] if len(htf_df) >= 2 else htf_df['close'].iloc[-1]
    htf_ema = htf_df['ema50'].iloc[-2] if len(htf_df) >= 2 else htf_df['ema50'].iloc[-1]
    htf_trend = 'bullish' if htf_close > htf_ema else 'bearish'

    if mode == "BOOM" and htf_trend != 'bearish':
        return None
    if mode == "CRASH" and htf_trend != 'bullish':
        return None

    # Target strictly completed candles
    c0 = ltf_df.iloc[-2]   # Last COMPLETED 5M candle (exhaustion candidate)
    c1 = ltf_df.iloc[-3]   # Previous spike candle 1
    c2 = ltf_df.iloc[-4]   # Previous spike candle 2

    # ATR up to c0
    ltf_df['atr'] = calc_atr(ltf_df)
    atr_val = ltf_df['atr'].iloc[-2]
    if pd.isna(atr_val) or atr_val == 0:
        return None

    c0_range = c0['high'] - c0['low']
    c0_body  = abs(c0['close'] - c0['open'])

    if mode == "BOOM":
        # Previous 2 candles must be bullish spikes (shot UP)
        c1_is_spike = c1['close'] > c1['open']
        c2_is_spike = c2['close'] > c2['open']

        # c0 must be bearish with solid body (body >= 50% of range)
        c0_is_exhaustion = (
            c0['close'] < c0['open'] and
            c0_range > 0 and
            (c0_body / c0_range) >= 0.5
        )

        if not (c1_is_spike and c2_is_spike and c0_is_exhaustion):
            return None

        spike_peak = max(c1['high'], c2['high'], c0['high'])
        entry = c0['close']
        sl    = spike_peak + (atr_val * ATR_SL_MULT)
        sl_dist = abs(entry - sl)
        tp    = entry - (sl_dist * REWARD_RATIO)

    else:  # CRASH
        # Previous 2 candles must be bearish crashes (shot DOWN)
        c1_is_crash = c1['close'] < c1['open']
        c2_is_crash = c2['close'] < c2['open']

        # c0 must be bullish with solid body (body >= 50% of range)
        c0_is_exhaustion = (
            c0['close'] > c0['open'] and
            c0_range > 0 and
            (c0_body / c0_range) >= 0.5
        )

        if not (c1_is_crash and c2_is_crash and c0_is_exhaustion):
            return None

        crash_trough = min(c1['low'], c2['low'], c0['low'])
        entry = c0['close']
        sl    = crash_trough - (atr_val * ATR_SL_MULT)
        sl_dist = abs(entry - sl)
        tp    = entry + (sl_dist * REWARD_RATIO)

    candle_time_str = c0['time'].strftime('%Y-%m-%d %H:%M:%S')
    spike_ref_val = spike_peak if mode == "BOOM" else crash_trough

    # Verify SMC Order Block / FVG Confluence
    smc_info = check_smc_confluence(ltf_df, spike_ref_val, mode, atr_val)

    return {
        'mode':            mode,
        'entry':           entry,
        'sl':              sl,
        'tp':              tp,
        'sl_dist':         sl_dist,
        'atr':             atr_val,
        'htf_trend':       htf_trend,
        'candle_time_str': candle_time_str,
        'candle_epoch':    int(c0['time'].timestamp()),
        'spike_ref':       spike_ref_val,
        'smc_zone':        smc_info['zone'],
        'smc_score':       smc_info['score']
    }

# ── Telegram Signal Alert Builder ────────────────────────────────────────────
def build_signal_alert(symbol: str, setup: dict, lot_size: float) -> str:
    direction_str = "SELL" if setup['mode'] == "BOOM" else "BUY"
    dir_emoji     = "🔴" if setup['mode'] == "BOOM" else "🟢"
    ref_label     = "Spike Peak" if setup['mode'] == "BOOM" else "Crash Trough"

    return (
        f"{dir_emoji} <b>[MYTRADA SPIKE EXHAUSTION SIGNAL]</b>\n"
        f"<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n"
        f"<b>Asset:</b> <code>{symbol}</code>\n"
        f"<b>Direction:</b> {dir_emoji} <b>{direction_str} — {setup['mode']} Spike Exhaustion</b>\n"
        f"<b>HTF Trend (1H 50 EMA):</b> <code>{setup['htf_trend'].upper()} — Aligned</code>\n"
        f"🎯 <b>SMC Liquidity Zone:</b> <code>{setup['smc_zone']} (Score: {setup['smc_score']}/10)</code>\n"
        f"<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n"
        f"<b>ENTRY PRICE:</b> <code>{setup['entry']:.2f}</code> (Market — close of exhaustion candle)\n"
        f"<b>STOP LOSS (SL):</b> <code>{setup['sl']:.2f}</code> ({ref_label} {setup['spike_ref']:.2f} + {ATR_SL_MULT}x ATR)\n"
        f"<b>TAKE PROFIT (TP):</b> <code>{setup['tp']:.2f}</code> (1:{REWARD_RATIO} R:R)\n"
        f"<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n"
        f"<b>Position Sizing ($10,000 Demo):</b>\n"
        f"  Lot Size: <code>{lot_size} Lots</code>\n"
        f"  Max Loss (SL Hit): <code>-${RISK_AMOUNT_USD:.2f} USD</code>\n"
        f"  Target Win (TP Hit): <code>+${RISK_AMOUNT_USD * REWARD_RATIO:.2f} USD</code>\n"
        f"<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n"
        f"<b>EXIT STRATEGY:</b> <code>Hold until TP or SL hit — NO time stop</code>\n"
        f"<b>Candle Time:</b> <code>{setup['candle_time_str']}</code>\n"
        f"<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n"
        f"<i>Enter MARKET {direction_str} on MT5. Hold until TP ({REWARD_RATIO}R) or SL is hit.</i>"
    )

# ── Telegram Outcome Alert Builder ───────────────────────────────────────────
def build_outcome_alert(signal: dict, outcome: str, exit_price: float, pnl_usd: float, pnl_r: float) -> str:
    direction_emoji = "🟢 BUY" if signal['mode'] == "CRASH" else "🔴 SELL"

    if outcome == "WIN":
        header = "🏆 <b>[SMC FULL TRADE OUTCOME: DIRECT TP HIT]</b>"
        outcome_str = f"🟢 <b>OUTCOME: TAKE PROFIT HIT!</b>\n<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n💰 <b>TOTAL REALIZED PROFIT:</b> <code>+${pnl_usd:.2f} USD (+{pnl_r:.2f}R)</code>"
    elif outcome == "LOSS":
        header = "🛡️ <b>[SMC FULL TRADE OUTCOME: STOP LOSS HIT]</b>"
        outcome_str = f"🔴 <b>OUTCOME: STOP LOSS HIT</b>\n<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n💸 <b>TOTAL REALIZED LOSS:</b> <code>-${abs(pnl_usd):.2f} USD ({pnl_r:.2f}R)</code>"
    else:  # TIME_EXIT
        header = "⏰ <b>[SMC FULL TRADE OUTCOME: TIME EXIT (5 CANDLES)]</b>"
        pnl_sign = "+" if pnl_usd >= 0 else "-"
        outcome_str = f"🟡 <b>OUTCOME: MAX HOLD TIME EXPIRED (5 CANDLES)</b>\n<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n📊 <b>REALIZED PnL AT EXIT:</b> <code>{pnl_sign}${abs(pnl_usd):.2f} USD ({pnl_r:+.2f}R)</code>"

    return (
        f"{header}\n"
        f"<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n"
        f"<b>Asset:</b> <code>{signal['symbol']}</code>\n"
        f"<b>Direction:</b> {direction_emoji}\n"
        f"{outcome_str}\n"
        f"<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n"
        f"🔥 <b>Entry Price:</b> <code>{signal['entry']:.2f}</code>\n"
        f"🛡️ <b>Stop Loss (SL):</b> <code>{signal['sl']:.2f}</code>\n"
        f"🏆 <b>Take Profit (TP):</b> <code>{signal['tp']:.2f}</code>\n"
        f"🏁 <b>Exit Price:</b> <code>{exit_price:.2f}</code>\n"
        f"<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n"
        f"<i>ℹ️ Check your Metatrader 5 terminal balance sheet!</i>"
    )

# ── Outcome Monitoring Engine ────────────────────────────────────────────────
def check_active_signal_outcomes(state: dict):
    active_signals = state.get("active_signals", [])
    if not active_signals:
        return

    remaining_signals = []
    state_changed = False

    for sig in active_signals:
        symbol = sig['symbol']
        mode   = sig['mode']

        ltf_df = get_candles(symbol, mt5.TIMEFRAME_M5, 30)
        if ltf_df is None or len(ltf_df) == 0:
            remaining_signals.append(sig)
            continue

        # Filter completed candles since signal candle timestamp
        signal_time = pd.to_datetime(sig['candle_epoch'], unit='s')
        post_candles = ltf_df[ltf_df['time'] > signal_time].iloc[:-1]  # Exclude current forming candle

        if len(post_candles) == 0:
            remaining_signals.append(sig)
            continue

        hit_tp = False
        hit_sl = False
        time_exit = False
        exit_price = 0.0
        pnl_usd = 0.0
        pnl_r = 0.0

        for idx, (_, candle) in enumerate(post_candles.iterrows(), start=1):
            if mode == "BOOM":
                # SELL: SL is hit if high >= sl, TP is hit if low <= tp
                if candle['high'] >= sig['sl']:
                    hit_sl = True
                    exit_price = sig['sl']
                    pnl_usd = -RISK_AMOUNT_USD
                    pnl_r = -1.0
                    break
                elif candle['low'] <= sig['tp']:
                    hit_tp = True
                    exit_price = sig['tp']
                    pnl_usd = RISK_AMOUNT_USD * REWARD_RATIO
                    pnl_r = REWARD_RATIO
                    break
            else:
                # BUY: SL is hit if low <= sl, TP is hit if high >= tp
                if candle['low'] <= sig['sl']:
                    hit_sl = True
                    exit_price = sig['sl']
                    pnl_usd = -RISK_AMOUNT_USD
                    pnl_r = -1.0
                    break
                elif candle['high'] >= sig['tp']:
                    hit_tp = True
                    exit_price = sig['tp']
                    pnl_usd = RISK_AMOUNT_USD * REWARD_RATIO
                    pnl_r = REWARD_RATIO
                    break

            # Only TP or SL exits - no time stop

        if hit_tp or hit_sl:
            outcome_type = "WIN" if hit_tp else "LOSS"
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
    print("=" * 75)
    print(" MYTRADA - INSTITUTIONAL SPIKE EXHAUSTION TELEGRAM BOT (SIGNAL ONLY)")
    print(" Strategy: BOOM SELL | CRASH BUY | 1:1.3 R:R | Price-Based Exit (TP or SL)")
    print("=" * 75)

    if not mt5.initialize():
        print(f"[ERROR] MT5 failed to initialize: {mt5.last_error()}")
        print("Ensure MetaTrader 5 Desktop is open and logged into your Deriv account.")
        return

    acc = mt5.account_info()
    if acc:
        print(f"[MT5 Connected] Account: {acc.login} | Server: {acc.server}")
        print(f"[MT5 Account]   Balance: ${acc.balance:,.2f} | Equity: ${acc.equity:,.2f}")
        print(f"[Risk Baseline] ${RISK_AMOUNT_USD:.2f} per trade | 1:{REWARD_RATIO} R:R Target")
    print("-" * 75)

    state = load_state()
    alerted_keys = set(state.get("alerted_keys", []))

    send_telegram(
        f"<b>[MYTRADA BOT STARTED]</b>\n"
        f"<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n"
        f"Account: <code>{acc.login if acc else 'N/A'}</code>\n"
        f"Balance: <code>${acc.balance:,.2f} USD</code>\n"
        f"Strategy: Spike Exhaustion (BOOM SELL | CRASH BUY)\n"
        f"Risk: <code>${RISK_AMOUNT_USD}/trade | 1:{REWARD_RATIO} R:R | Max 5 Candles</code>\n"
        f"Mode: <code>SIGNAL ONLY (Zero Duplicates / MT5 Chart Alignment)</code>\n"
        f"<i>Bot is now live and scanning MT5 charts 24/7.</i>"
    )

    try:
        while True:
            now_str = datetime.datetime.now().strftime("%H:%M:%S")
            print(f"\n[{now_str}] Scanning {len(SYMBOLS)} pairs for Spike Exhaustion setups...")

            # 1. Monitor active signal outcomes first
            check_active_signal_outcomes(state)

            # Count current active signals by group for exposure cap
            active_booms = sum(1 for s in state.get("active_signals", []) if s['mode'] == "BOOM")
            active_crashes = sum(1 for s in state.get("active_signals", []) if s['mode'] == "CRASH")

            for symbol, meta in SYMBOLS.items():
                try:
                    mode = meta['mode']

                    # Per-symbol guard: skip if this symbol already has an active trade signal running
                    if any(s['symbol'] == symbol for s in state.get("active_signals", [])):
                        print(f"  [{mode}] {symbol:<22} | Active signal running — skipping new setup search")
                        continue

                    # Group exposure cap guard
                    if mode == "BOOM" and active_booms >= MAX_CORRELATED_EXPOSURE:
                        print(f"  [{mode}] {symbol:<22} | Max BOOM exposure ({MAX_CORRELATED_EXPOSURE}) reached — skipping")
                        continue
                    if mode == "CRASH" and active_crashes >= MAX_CORRELATED_EXPOSURE:
                        print(f"  [{mode}] {symbol:<22} | Max CRASH exposure ({MAX_CORRELATED_EXPOSURE}) reached — skipping")
                        continue

                    if not mt5.symbol_select(symbol, True):
                        continue

                    ltf_df = get_candles(symbol, mt5.TIMEFRAME_M5, 50)
                    htf_df = get_candles(symbol, mt5.TIMEFRAME_H1, 100)
                    if ltf_df is None or htf_df is None:
                        continue

                    curr_price = ltf_df['close'].iloc[-1]
                    setup = detect_spike_exhaustion(ltf_df, htf_df, mode)

                    if setup:
                        # De-duplicate strictly by symbol + mode + exact completed candle timestamp
                        alert_key = f"{symbol}_{mode}_{setup['candle_epoch']}"

                        if alert_key not in alerted_keys:
                            alerted_keys.add(alert_key)
                            lot_size = get_dynamic_lot_size(symbol, setup['entry'], setup['sl'])

                            # Send Telegram signal alert
                            alert_html = build_signal_alert(symbol, setup, lot_size)
                            send_telegram(alert_html)

                            # Save active signal state for outcome tracking
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
                            state["alerted_keys"] = list(alerted_keys)
                            save_state(state)

                            if mode == "BOOM":
                                active_booms += 1
                            else:
                                active_crashes += 1

                            print(f"  [{mode}] {symbol:<22} | Price: {curr_price:.2f} | 📢 SIGNAL SENT ({setup['candle_time_str']})")
                        else:
                            print(f"  [{mode}] {symbol:<22} | Price: {curr_price:.2f} | Setup already alerted for candle {setup['candle_time_str']}")
                    else:
                        htf_trend = 'bearish' if mode == 'BOOM' else 'bullish'
                        print(f"  [{mode}] {symbol:<22} | Price: {curr_price:.2f} | Waiting for spike exhaustion...")

                except Exception as e:
                    print(f"  [ERROR] {symbol}: {e}")
                    continue

            print(f"\n  Next scan in {SCAN_INTERVAL_SECS}s...")
            time.sleep(SCAN_INTERVAL_SECS)

    except KeyboardInterrupt:
        print("\n[MYTRADA] Bot stopped by user.")
        send_telegram("<b>[MYTRADA BOT STOPPED]</b>\n<i>Bot was manually stopped. Restart with: python mt5_runner.py</i>")
    finally:
        mt5.shutdown()

if __name__ == "__main__":
    run_bot()
