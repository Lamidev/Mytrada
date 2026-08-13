"""
backtest_1month.py
==================
1-Month Backtest of Spike Exhaustion Strategy WITH SMC Order Block & FVG Confluence Filter.
All 20 Boom & Crash pairs | Exact MT5 Historical Data | Past 30 Days
"""

import MetaTrader5 as mt5
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import sys
import json
import os

RISK_USD          = 100.0
REWARD_RATIO      = 2.0
EMA_PERIOD        = 50
ATR_PERIOD        = 14
ATR_SL_MULT       = 1.5
MIN_SPIKE_CANDLES = 2
BODY_RATIO_MIN    = 0.50
MAX_HOLD_CANDLES  = 5
DAYS_BACK         = 30
STRICT_SMC_FILTER = True  # True = require OB or FVG zone tap

PAIRS = {
    "Boom 50 Index":    {"mode": "BOOM"},
    "Boom 99 Index":    {"mode": "BOOM"},
    "Boom 100 Index":   {"mode": "BOOM"},
    "Boom 150 Index":   {"mode": "BOOM"},
    "Boom 200 Index":   {"mode": "BOOM"},
    "Boom 300 Index":   {"mode": "BOOM"},
    "Boom 500 Index":   {"mode": "BOOM"},
    "Boom 600 Index":   {"mode": "BOOM"},
    "Boom 900 Index":   {"mode": "BOOM"},
    "Boom 1000 Index":  {"mode": "BOOM"},
    "Crash 50 Index":   {"mode": "CRASH"},
    "Crash 99 Index":   {"mode": "CRASH"},
    "Crash 100 Index":  {"mode": "CRASH"},
    "Crash 150 Index":  {"mode": "CRASH"},
    "Crash 200 Index":  {"mode": "CRASH"},
    "Crash 300 Index":  {"mode": "CRASH"},
    "Crash 500 Index":  {"mode": "CRASH"},
    "Crash 600 Index":  {"mode": "CRASH"},
    "Crash 900 Index":  {"mode": "CRASH"},
    "Crash 1000 Index": {"mode": "CRASH"},
}

def calc_ema(series, period):
    return series.ewm(span=period, adjust=False).mean()

def calc_atr(df, period=ATR_PERIOD):
    high  = df['high']
    low   = df['low']
    close = df['close']
    tr = pd.concat([
        high - low,
        (high - close.shift()).abs(),
        (low  - close.shift()).abs()
    ], axis=1).max(axis=1)
    return tr.rolling(period).mean()

def check_smc_confluence(df, curr_idx, spike_ref, mode, atr_val):
    if curr_idx < 35:
        return True, "STRUCTURE"
    
    start_look = max(0, curr_idx - 35)
    lookback = df.iloc[start_look:curr_idx - 3]
    has_smc = False
    zone = "NONE"

    if mode == "BOOM":
        for idx in range(len(lookback) - 1, 0, -1):
            c_curr = lookback.iloc[idx]
            c_prev = lookback.iloc[idx - 1]
            if c_prev['close'] > c_prev['open'] and c_curr['close'] < c_curr['open']:
                ob_bottom = min(c_prev['open'], c_prev['low'])
                ob_top = c_prev['high']
                if spike_ref >= (ob_bottom - 0.3 * atr_val) and spike_ref <= (ob_top + 1.0 * atr_val):
                    return True, "ORDER_BLOCK"
        
        if not has_smc:
            for idx in range(len(lookback) - 3, 0, -1):
                c1 = lookback.iloc[idx]
                c3 = lookback.iloc[idx + 2]
                if c3['high'] < c1['low']:
                    fvg_bottom = c3['high']
                    fvg_top = c1['low']
                    if spike_ref >= (fvg_bottom - 0.2 * atr_val) and spike_ref <= (fvg_top + 0.5 * atr_val):
                        return True, "FVG"
    else:
        for idx in range(len(lookback) - 1, 0, -1):
            c_curr = lookback.iloc[idx]
            c_prev = lookback.iloc[idx - 1]
            if c_prev['close'] < c_prev['open'] and c_curr['close'] > c_curr['open']:
                ob_bottom = c_prev['low']
                ob_top = max(c_prev['open'], c_prev['high'])
                if spike_ref <= (ob_top + 0.3 * atr_val) and spike_ref >= (ob_bottom - 1.0 * atr_val):
                    return True, "ORDER_BLOCK"
        
        if not has_smc:
            for idx in range(len(lookback) - 3, 0, -1):
                c1 = lookback.iloc[idx]
                c3 = lookback.iloc[idx + 2]
                if c3['low'] > c1['high']:
                    fvg_bottom = c1['high']
                    fvg_top = c3['low']
                    if spike_ref <= (fvg_top + 0.2 * atr_val) and spike_ref >= (fvg_bottom - 0.5 * atr_val):
                        return True, "FVG"

    return False, "NONE"

def detect_spike_exhaustion(ltf_df, htf_df, mode):
    ltf_df = ltf_df.copy().reset_index(drop=True)
    htf_df = htf_df.copy().reset_index(drop=True)
    ltf_df['atr']   = calc_atr(ltf_df)
    htf_df['ema50'] = calc_ema(htf_df['close'], EMA_PERIOD)

    setups = []
    for i in range(MIN_SPIKE_CANDLES + 1, len(ltf_df) - 1):
        c0 = ltf_df.iloc[i]
        c1 = ltf_df.iloc[i-1]
        c2 = ltf_df.iloc[i-2]

        atr_val = c0['atr']
        if pd.isna(atr_val) or atr_val == 0:
            continue

        ltf_time  = c0['time']
        htf_slice = htf_df[htf_df['time'] <= ltf_time]
        if htf_slice.empty:
            continue
        htf_ema   = htf_slice.iloc[-1]['ema50']
        htf_close = htf_slice.iloc[-1]['close']

        c0_range = c0['high'] - c0['low']
        c0_body  = abs(c0['close'] - c0['open'])
        if c0_range == 0:
            continue

        if mode == "BOOM":
            if htf_close >= htf_ema:
                continue
            if not (c1['close'] > c1['open'] and c2['close'] > c2['open']):
                continue
            if not (c0['close'] < c0['open'] and (c0_body / c0_range) >= BODY_RATIO_MIN):
                continue
            spike_peak = max(c0['high'], c1['high'], c2['high'])
            entry      = c0['close']
            sl         = spike_peak + (atr_val * ATR_SL_MULT)
            spike_ref  = spike_peak
        else:
            if htf_close <= htf_ema:
                continue
            if not (c1['close'] < c1['open'] and c2['close'] < c2['open']):
                continue
            if not (c0['close'] > c0['open'] and (c0_body / c0_range) >= BODY_RATIO_MIN):
                continue
            crash_trough = min(c0['low'], c1['low'], c2['low'])
            entry        = c0['close']
            sl           = crash_trough - (atr_val * ATR_SL_MULT)
            spike_ref    = crash_trough

        # Apply SMC Order Block / FVG Confluence filter
        if STRICT_SMC_FILTER:
            is_valid_smc, zone = check_smc_confluence(ltf_df, i, spike_ref, mode, atr_val)
            if not is_valid_smc:
                continue

        sl_dist = abs(entry - sl)
        if sl_dist <= 0:
            continue

        setups.append({'index': i, 'time': str(ltf_time), 'entry': entry, 'sl': sl, 'sl_dist': sl_dist})

    return setups, ltf_df

def run_backtest(name, ltf_df, htf_df, mode):
    setups, ltf_df = detect_spike_exhaustion(ltf_df, htf_df, mode)
    trades   = []
    used_idx = set()

    for s in setups:
        i = s['index']
        if i in used_idx:
            continue
        entry   = s['entry']
        sl_dist = s['sl_dist']
        sl      = s['sl']
        tp      = entry - (sl_dist * REWARD_RATIO) if mode == "BOOM" else entry + (sl_dist * REWARD_RATIO)

        result   = None
        exit_idx = min(i + MAX_HOLD_CANDLES, len(ltf_df) - 1)

        for j in range(i + 1, exit_idx + 1):
            c = ltf_df.iloc[j]
            if mode == "BOOM":
                if c['high'] >= sl:
                    result = 'LOSS'; break
                if c['low'] <= tp:
                    result = 'WIN';  break
            else:
                if c['low'] <= sl:
                    result = 'LOSS'; break
                if c['high'] >= tp:
                    result = 'WIN';  break

        if result is None:
            c_last = ltf_df.iloc[exit_idx]
            exit_price = c_last['close']
            pnl_r = (entry - exit_price) / sl_dist if mode == "BOOM" else (exit_price - entry) / sl_dist
            pnl = pnl_r * RISK_USD
            result = 'TIME_EXIT'
        else:
            pnl = RISK_USD * REWARD_RATIO if result == 'WIN' else -RISK_USD

        trades.append({'result': result, 'pnl': pnl})
        used_idx.add(i)

    total      = len(trades)
    wins       = sum(1 for t in trades if t['result'] == 'WIN')
    losses     = sum(1 for t in trades if t['result'] == 'LOSS')
    time_exits = sum(1 for t in trades if t['result'] == 'TIME_EXIT')
    net        = sum(t['pnl'] for t in trades)
    wr         = (wins / total * 100) if total > 0 else 0

    return {'name': name, 'mode': mode, 'trades': total, 'wins': wins,
            'losses': losses, 'time_exits': time_exits, 'wr': round(wr, 2), 'net_pnl': round(net, 2)}

def main():
    if not mt5.initialize():
        print(f"[ERROR] MT5 connection failed: {mt5.last_error()}")
        return

    end_date   = datetime.now()
    start_date = end_date - timedelta(days=DAYS_BACK)
    results = []

    for display_name, meta in PAIRS.items():
        mode = meta['mode']
        mt5.symbol_select(display_name, True)
        sym_info = mt5.symbol_info(display_name)
        if sym_info is None:
            continue

        ltf_rates = mt5.copy_rates_range(display_name, mt5.TIMEFRAME_M5, start_date, end_date)
        htf_rates = mt5.copy_rates_range(display_name, mt5.TIMEFRAME_H1, start_date, end_date)

        if ltf_rates is None or len(ltf_rates) == 0:
            continue

        ltf_df = pd.DataFrame(ltf_rates)
        htf_df = pd.DataFrame(htf_rates)
        ltf_df['time'] = pd.to_datetime(ltf_df['time'], unit='s')
        htf_df['time'] = pd.to_datetime(htf_df['time'], unit='s')

        res = run_backtest(display_name, ltf_df, htf_df, mode)
        results.append(res)

    mt5.shutdown()

    results = sorted(results, key=lambda x: x['net_pnl'], reverse=True)

    out_path = os.path.join(os.path.dirname(__file__), "cache", "1month_smc_backtest_results.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(results, f, indent=2)

    print("SMC_BACKTEST_DONE")

if __name__ == "__main__":
    main()
