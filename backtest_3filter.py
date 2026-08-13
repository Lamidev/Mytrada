"""
backtest_3filter.py
===================
Backtest with SELECTIVE 3 quality filters only:
  1. Spike strength >= 3x ATR  (no weak/fake spikes)
  2. Session time filter        (London + NY: 07:00-17:00 GMT)
  3. 75-minute cooldown         (no back-to-back signals per pair)
Target: 1:1.3 R:R, No time stop, 1 month, Top 8 pairs
H4 EMA200 and strict SMC removed (too restrictive)
"""

import MetaTrader5 as mt5
import pandas as pd
from datetime import datetime, timedelta
import json
import os

# ── Parameters ────────────────────────────────────────────────────────────────
RISK_USD           = 100.0
REWARD_RATIO       = 1.3
EMA_FAST           = 50
ATR_PERIOD         = 14
ATR_SL_MULT        = 1.5
MIN_SPIKE_CANDLES  = 2
BODY_RATIO_MIN     = 0.50
SPIKE_ATR_MIN_MULT = 3.0    # Filter 1: spike must be >= 3x ATR
COOLDOWN_CANDLES   = 15     # Filter 3: 15 x 5M candles = 75 min cooldown
DAYS_BACK          = 30
SESSION_START_H    = 7      # Filter 2: GMT hour start
SESSION_END_H      = 17     # Filter 2: GMT hour end

PAIRS = {
    "Boom 200 Index":   {"mode": "BOOM"},
    "Boom 500 Index":   {"mode": "BOOM"},
    "Boom 300 Index":   {"mode": "BOOM"},
    "Boom 1000 Index":  {"mode": "BOOM"},
    "Crash 500 Index":  {"mode": "CRASH"},
    "Crash 600 Index":  {"mode": "CRASH"},
    "Crash 200 Index":  {"mode": "CRASH"},
    "Crash 1000 Index": {"mode": "CRASH"},
}

# ── Helpers ───────────────────────────────────────────────────────────────────
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

# ── Setup Detection ───────────────────────────────────────────────────────────
def detect_setups(ltf_df, htf_df, mode):
    ltf_df = ltf_df.copy().reset_index(drop=True)
    htf_df = htf_df.copy().reset_index(drop=True)
    ltf_df['atr']   = calc_atr(ltf_df)
    htf_df['ema50'] = calc_ema(htf_df['close'], EMA_FAST)

    setups = []
    last_signal_idx = -COOLDOWN_CANDLES - 1

    for i in range(MIN_SPIKE_CANDLES + 1, len(ltf_df) - 1):
        c0 = ltf_df.iloc[i]
        c1 = ltf_df.iloc[i-1]
        c2 = ltf_df.iloc[i-2]

        atr_val = c0['atr']
        if pd.isna(atr_val) or atr_val == 0:
            continue

        # ── Filter 2: Session time (GMT 07:00-17:00) ─────────────────────────
        if not (SESSION_START_H <= c0['time'].hour < SESSION_END_H):
            continue

        # ── Filter 3: 75-min cooldown per pair ───────────────────────────────
        if i - last_signal_idx < COOLDOWN_CANDLES:
            continue

        # H1 EMA50 trend filter
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
            spike_size = spike_peak - min(c1['low'], c2['low'])
            # ── Filter 1: Spike must be >= 3x ATR ────────────────────────────
            if spike_size < SPIKE_ATR_MIN_MULT * atr_val:
                continue
            entry = c0['close']
            sl    = spike_peak + (atr_val * ATR_SL_MULT)
        else:
            if htf_close <= htf_ema:
                continue
            if not (c1['close'] < c1['open'] and c2['close'] < c2['open']):
                continue
            if not (c0['close'] > c0['open'] and (c0_body / c0_range) >= BODY_RATIO_MIN):
                continue
            crash_trough = min(c0['low'], c1['low'], c2['low'])
            crash_size   = max(c1['high'], c2['high']) - crash_trough
            # ── Filter 1: Crash must be >= 3x ATR ────────────────────────────
            if crash_size < SPIKE_ATR_MIN_MULT * atr_val:
                continue
            entry = c0['close']
            sl    = crash_trough - (atr_val * ATR_SL_MULT)

        sl_dist = abs(entry - sl)
        if sl_dist <= 0:
            continue

        setups.append({'index': i, 'entry': entry, 'sl': sl, 'sl_dist': sl_dist})
        last_signal_idx = i

    return setups, ltf_df

# ── Trade Simulation ──────────────────────────────────────────────────────────
def simulate_trades(setups, ltf_df, mode, rr_target):
    used_idx = set()
    tp_hits  = 0
    sl_hits  = 0
    net_pnl  = 0.0

    for s in setups:
        i = s['index']
        if i in used_idx:
            continue
        entry   = s['entry']
        sl_dist = s['sl_dist']
        sl      = s['sl']
        tp = entry - (sl_dist * rr_target) if mode == "BOOM" else entry + (sl_dist * rr_target)

        result = None
        for j in range(i + 1, len(ltf_df)):
            c = ltf_df.iloc[j]
            if mode == "BOOM":
                if c['high'] >= sl: result = 'LOSS'; break
                if c['low']  <= tp: result = 'WIN';  break
            else:
                if c['low']  <= sl: result = 'LOSS'; break
                if c['high'] >= tp: result = 'WIN';  break

        if result == 'WIN':
            tp_hits += 1
            net_pnl += RISK_USD * rr_target
        elif result == 'LOSS':
            sl_hits += 1
            net_pnl -= RISK_USD

        used_idx.add(i)

    total    = tp_hits + sl_hits
    win_rate = round((tp_hits / total * 100), 2) if total > 0 else 0.0
    return {'total_setups': len(setups), 'tp_hits': tp_hits,
            'sl_hits': sl_hits, 'win_rate': win_rate, 'net_pnl': round(net_pnl, 2)}

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    if not mt5.initialize():
        print(f"MT5 init failed: {mt5.last_error()}")
        return

    end_date   = datetime.now()
    start_date = end_date - timedelta(days=DAYS_BACK)
    totals = {'total_setups': 0, 'tp_hits': 0, 'sl_hits': 0, 'net_pnl': 0.0}
    pair_results = {}

    for display_name, meta in PAIRS.items():
        mode = meta['mode']
        mt5.symbol_select(display_name, True)

        ltf_rates = mt5.copy_rates_range(display_name, mt5.TIMEFRAME_M5, start_date, end_date)
        htf_rates = mt5.copy_rates_range(display_name, mt5.TIMEFRAME_H1, start_date, end_date)

        if ltf_rates is None or len(ltf_rates) < 50:
            print(f"  [SKIP] {display_name} - insufficient data")
            continue

        ltf_df = pd.DataFrame(ltf_rates)
        htf_df = pd.DataFrame(htf_rates) if htf_rates is not None and len(htf_rates) > 0 else pd.DataFrame()

        ltf_df['time'] = pd.to_datetime(ltf_df['time'], unit='s')
        if not htf_df.empty:
            htf_df['time'] = pd.to_datetime(htf_df['time'], unit='s')

        if htf_df.empty:
            print(f"  [SKIP] {display_name} - missing H1 data")
            continue

        setups, ltf_df = detect_setups(ltf_df, htf_df, mode)
        res = simulate_trades(setups, ltf_df, mode, REWARD_RATIO)

        pair_results[display_name] = res
        totals['total_setups'] += res['total_setups']
        totals['tp_hits']      += res['tp_hits']
        totals['sl_hits']      += res['sl_hits']
        totals['net_pnl']      += res['net_pnl']

        print(f"  {display_name}: {res['total_setups']} setups | "
              f"TP={res['tp_hits']} SL={res['sl_hits']} "
              f"WR={res['win_rate']}% PnL=${res['net_pnl']:,.2f}")

    total_closed = totals['tp_hits'] + totals['sl_hits']
    totals['win_rate'] = round((totals['tp_hits'] / total_closed * 100), 2) if total_closed > 0 else 0.0

    output = {'summary': totals, 'by_pair': pair_results}
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache", "3filter_backtest_results.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)

    mt5.shutdown()
    print("\n-- 3-FILTER BACKTEST COMPLETE ----------------------------------")
    print(f"  Total Setups  : {totals['total_setups']}")
    print(f"  TP Wins       : {totals['tp_hits']}")
    print(f"  SL Losses     : {totals['sl_hits']}")
    print(f"  Win Rate      : {totals['win_rate']}%")
    print(f"  Net PnL ($100 risk) : ${totals['net_pnl']:,.2f}")
    print(f"  Net PnL ($3 risk)   : ${totals['net_pnl']*0.03:,.2f}  (on $100 account)")
    print("----------------------------------------------------------------")

if __name__ == "__main__":
    main()
