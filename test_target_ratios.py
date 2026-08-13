"""
test_target_ratios.py
======================
Test target R:R ratios (1:1.0, 1:1.2, 1:1.5, 1:2.0) with 5-candle hard exit
on 1-Month MT5 data to compare direct TP win rates and overall PnL.
"""

import MetaTrader5 as mt5
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import json
import os

RISK_USD          = 100.0
EMA_PERIOD        = 50
ATR_PERIOD        = 14
ATR_SL_MULT       = 1.5
MIN_SPIKE_CANDLES = 2
BODY_RATIO_MIN    = 0.50
MAX_HOLD_CANDLES  = 5
DAYS_BACK         = 30

PAIRS = {
    "Boom 200 Index":  {"mode": "BOOM"},
    "Boom 500 Index":  {"mode": "BOOM"},
    "Boom 300 Index":  {"mode": "BOOM"},
    "Boom 1000 Index": {"mode": "BOOM"},
    "Crash 500 Index":  {"mode": "CRASH"},
    "Crash 600 Index":  {"mode": "CRASH"},
    "Crash 200 Index":  {"mode": "CRASH"},
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

def detect_setups(ltf_df, htf_df, mode):
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

        sl_dist = abs(entry - sl)
        if sl_dist <= 0:
            continue

        setups.append({'index': i, 'entry': entry, 'sl': sl, 'sl_dist': sl_dist})

    return setups, ltf_df

def run_rr_test(setups, ltf_df, mode, rr_target):
    used_idx = set()
    direct_tp = 0
    sl_hits = 0
    time_exits = 0
    net_pnl = 0.0

    for s in setups:
        i = s['index']
        if i in used_idx:
            continue
        entry   = s['entry']
        sl_dist = s['sl_dist']
        sl      = s['sl']
        tp      = entry - (sl_dist * rr_target) if mode == "BOOM" else entry + (sl_dist * rr_target)

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

        if result == 'WIN':
            direct_tp += 1
            net_pnl += RISK_USD * rr_target
        elif result == 'LOSS':
            sl_hits += 1
            net_pnl -= RISK_USD
        else:
            time_exits += 1
            c_last = ltf_df.iloc[exit_idx]
            exit_price = c_last['close']
            pnl_r = (entry - exit_price) / sl_dist if mode == "BOOM" else (exit_price - entry) / sl_dist
            net_pnl += pnl_r * RISK_USD

        used_idx.add(i)

    return {
        'total': len(setups),
        'direct_tp': direct_tp,
        'sl_hits': sl_hits,
        'time_exits': time_exits,
        'net_pnl': round(net_pnl, 2)
    }

def main():
    if not mt5.initialize():
        print("MT5 init failed")
        return

    end_date   = datetime.now()
    start_date = end_date - timedelta(days=DAYS_BACK)
    ratios = [1.0, 1.2, 1.5, 2.0]
    comparison = {rr: {'total': 0, 'direct_tp': 0, 'sl_hits': 0, 'time_exits': 0, 'net_pnl': 0.0} for rr in ratios}

    for display_name, meta in PAIRS.items():
        mode = meta['mode']
        mt5.symbol_select(display_name, True)

        ltf_rates = mt5.copy_rates_range(display_name, mt5.TIMEFRAME_M5, start_date, end_date)
        htf_rates = mt5.copy_rates_range(display_name, mt5.TIMEFRAME_H1, start_date, end_date)

        if ltf_rates is None or len(ltf_rates) == 0:
            continue

        ltf_df = pd.DataFrame(ltf_rates)
        htf_df = pd.DataFrame(htf_rates)
        ltf_df['time'] = pd.to_datetime(ltf_df['time'], unit='s')
        htf_df['time'] = pd.to_datetime(htf_df['time'], unit='s')

        setups, ltf_df = detect_setups(ltf_df, htf_df, mode)

        for rr in ratios:
            res = run_rr_test(setups, ltf_df, mode, rr)
            comparison[rr]['total'] += res['total']
            comparison[rr]['direct_tp'] += res['direct_tp']
            comparison[rr]['sl_hits'] += res['sl_hits']
            comparison[rr]['time_exits'] += res['time_exits']
            comparison[rr]['net_pnl'] += res['net_pnl']

    mt5.shutdown()

    out_path = os.path.join(os.path.dirname(__file__), "cache", "ratio_test_results.json")
    with open(out_path, "w") as f:
        json.dump(comparison, f, indent=2)

    print("RATIO_TEST_DONE")

if __name__ == "__main__":
    main()
