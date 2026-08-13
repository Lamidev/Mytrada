"""
backtest_filtered.py
====================
Backtest with ALL 5 quality filters applied:
  1. Strict SMC OB/FVG tap required
  2. Spike strength >= 3x ATR (no weak spikes)
  3. Session time filter (London + NY only: 07:00-17:00 GMT)
  4. 75-minute cooldown between signals per pair
  5. H4 EMA200 macro trend bias check
Target: 1:1.3 R:R, No time stop, 1-month, Top 8 pairs
"""

import MetaTrader5 as mt5
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import json
import os

# ── Core Parameters ──────────────────────────────────────────────────────────
RISK_USD           = 100.0
REWARD_RATIO       = 1.3
EMA_FAST           = 50        # H1 EMA (existing trend filter)
EMA_SLOW           = 200       # H4 EMA200 (new macro bias filter)
ATR_PERIOD         = 14
ATR_SL_MULT        = 1.5
MIN_SPIKE_CANDLES  = 2
BODY_RATIO_MIN     = 0.50
SPIKE_ATR_MIN_MULT = 3.0       # Filter 2: spike must be >= 3x ATR
COOLDOWN_CANDLES   = 15        # Filter 4: 15 x 5M candles = 75 min cooldown
DAYS_BACK          = 30

# Filter 3: Active session hours in GMT (07:00 to 17:00)
SESSION_START_H = 7
SESSION_END_H   = 17

# ── Top 8 Pairs ───────────────────────────────────────────────────────────────
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

# ── Filter 1: SMC OB / FVG confluence ────────────────────────────────────────
def find_order_blocks(df, mode, lookback=30):
    obs = []
    end = len(df) - 1
    for k in range(max(0, end - lookback), end):
        c = df.iloc[k]
        if mode == "BOOM":
            if c['close'] > c['open']:
                obs.append((c['high'], c['low']))
        else:
            if c['close'] < c['open']:
                obs.append((c['high'], c['low']))
    return obs

def find_fvgs(df, mode, lookback=30):
    fvgs = []
    end = len(df)
    for k in range(max(2, end - lookback), end):
        prev = df.iloc[k-2]
        curr = df.iloc[k]
        if mode == "BOOM":
            if prev['low'] > curr['high']:
                fvgs.append((prev['low'], curr['high']))
        else:
            if curr['low'] > prev['high']:
                fvgs.append((curr['low'], prev['high']))
    return fvgs

def smc_confluence(spike_level, df_slice, mode):
    obs  = find_order_blocks(df_slice, mode)
    fvgs = find_fvgs(df_slice, mode)
    for (ob_h, ob_l) in obs:
        if ob_l <= spike_level <= ob_h:
            return True
    for (fvg_h, fvg_l) in fvgs:
        if fvg_l <= spike_level <= fvg_h:
            return True
    return False

# ── Setup Detection with All 5 Filters ───────────────────────────────────────
def detect_setups(ltf_df, htf_df, h4_df, mode):
    ltf_df = ltf_df.copy().reset_index(drop=True)
    htf_df = htf_df.copy().reset_index(drop=True)
    h4_df  = h4_df.copy().reset_index(drop=True)

    ltf_df['atr']   = calc_atr(ltf_df)
    htf_df['ema50'] = calc_ema(htf_df['close'], EMA_FAST)
    h4_df['ema200'] = calc_ema(h4_df['close'], EMA_SLOW)

    setups = []
    last_signal_idx = -COOLDOWN_CANDLES - 1

    for i in range(MIN_SPIKE_CANDLES + 1, len(ltf_df) - 1):
        c0 = ltf_df.iloc[i]
        c1 = ltf_df.iloc[i-1]
        c2 = ltf_df.iloc[i-2]

        atr_val = c0['atr']
        if pd.isna(atr_val) or atr_val == 0:
            continue

        # Filter 3: Session time (GMT 07:00-17:00)
        candle_hour = c0['time'].hour
        if not (SESSION_START_H <= candle_hour < SESSION_END_H):
            continue

        # Filter 4: Cooldown
        if i - last_signal_idx < COOLDOWN_CANDLES:
            continue

        # H1 EMA50 trend
        ltf_time  = c0['time']
        htf_slice = htf_df[htf_df['time'] <= ltf_time]
        if htf_slice.empty:
            continue
        htf_ema   = htf_slice.iloc[-1]['ema50']
        htf_close = htf_slice.iloc[-1]['close']

        # Filter 5: H4 EMA200 macro bias
        h4_slice = h4_df[h4_df['time'] <= ltf_time]
        if h4_slice.empty:
            continue
        h4_ema200 = h4_slice.iloc[-1]['ema200']
        h4_close  = h4_slice.iloc[-1]['close']
        if pd.isna(h4_ema200):
            continue

        c0_range = c0['high'] - c0['low']
        c0_body  = abs(c0['close'] - c0['open'])
        if c0_range == 0:
            continue

        if mode == "BOOM":
            if htf_close >= htf_ema:
                continue
            if h4_close >= h4_ema200:
                continue
            if not (c1['close'] > c1['open'] and c2['close'] > c2['open']):
                continue
            if not (c0['close'] < c0['open'] and (c0_body / c0_range) >= BODY_RATIO_MIN):
                continue
            spike_peak = max(c0['high'], c1['high'], c2['high'])
            spike_size = spike_peak - min(c1['low'], c2['low'])
            if spike_size < SPIKE_ATR_MIN_MULT * atr_val:
                continue
            df_slice = ltf_df.iloc[max(0, i-50):i]
            if not smc_confluence(spike_peak, df_slice, mode):
                continue
            entry = c0['close']
            sl    = spike_peak + (atr_val * ATR_SL_MULT)

        else:
            if htf_close <= htf_ema:
                continue
            if h4_close <= h4_ema200:
                continue
            if not (c1['close'] < c1['open'] and c2['close'] < c2['open']):
                continue
            if not (c0['close'] > c0['open'] and (c0_body / c0_range) >= BODY_RATIO_MIN):
                continue
            crash_trough = min(c0['low'], c1['low'], c2['low'])
            crash_size   = max(c1['high'], c2['high']) - crash_trough
            if crash_size < SPIKE_ATR_MIN_MULT * atr_val:
                continue
            df_slice = ltf_df.iloc[max(0, i-50):i]
            if not smc_confluence(crash_trough, df_slice, mode):
                continue
            entry = c0['close']
            sl    = crash_trough - (atr_val * ATR_SL_MULT)

        sl_dist = abs(entry - sl)
        if sl_dist <= 0:
            continue

        setups.append({'index': i, 'entry': entry, 'sl': sl, 'sl_dist': sl_dist})
        last_signal_idx = i

    return setups, ltf_df

# ── Trade Outcome Simulation ──────────────────────────────────────────────────
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
        h4_rates  = mt5.copy_rates_range(display_name, mt5.TIMEFRAME_H4, start_date, end_date)

        if ltf_rates is None or len(ltf_rates) < 50:
            print(f"  [SKIP] {display_name} — insufficient data")
            continue

        ltf_df = pd.DataFrame(ltf_rates)
        htf_df = pd.DataFrame(htf_rates) if htf_rates is not None and len(htf_rates) > 0 else pd.DataFrame()
        h4_df  = pd.DataFrame(h4_rates)  if h4_rates  is not None and len(h4_rates)  > 0 else pd.DataFrame()

        for df in [ltf_df, htf_df, h4_df]:
            if not df.empty:
                df['time'] = pd.to_datetime(df['time'], unit='s')

        if htf_df.empty or h4_df.empty:
            print(f"  [SKIP] {display_name} — missing H1 or H4 data")
            continue

        setups, ltf_df = detect_setups(ltf_df, htf_df, h4_df, mode)
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
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache", "filtered_backtest_results.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)

    mt5.shutdown()
    print("\n-- FILTERED BACKTEST COMPLETE ----------------------------------")
    print(f"  Total Setups  : {totals['total_setups']}")
    print(f"  TP Wins       : {totals['tp_hits']}")
    print(f"  SL Losses     : {totals['sl_hits']}")
    print(f"  Win Rate      : {totals['win_rate']}%")
    print(f"  Net PnL       : ${totals['net_pnl']:,.2f}  (${totals['net_pnl']*0.03:,.2f} on $100 acc at $3 risk)")
    print("----------------------------------------------------------------")

if __name__ == "__main__":
    main()
