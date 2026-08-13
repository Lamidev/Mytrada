"""
backtest_rr_comparison.py
==========================
Spike Exhaustion Strategy Backtest — 1:2 RR vs 1:3 RR Comparison
All 20 Boom & Crash pairs | Real MT5 Historical Data | 3 Months

Strategy Rules:
  BOOM  → SELL after 2+ consecutive bullish spike candles + bearish exhaustion (body >= 50% range)
          1H price BELOW 50 EMA (bearish trend aligned)
  CRASH → BUY  after 2+ consecutive bearish crash candles + bullish exhaustion (body >= 50% range)
          1H price ABOVE 50 EMA (bullish trend aligned)

Entry  : Market close of exhaustion candle
SL     : Spike Peak + 1.5xATR  (BOOM) | Crash Trough - 1.5xATR  (CRASH)
TP     : Entry +/- SL_dist x REWARD_RATIO
Time   : Hard exit after 5 candles if neither TP nor SL hit
"""

import MetaTrader5 as mt5
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import sys

# CONFIG
RISK_USD          = 100.0
RR_TO_TEST        = [2.0, 3.0]
EMA_PERIOD        = 50
ATR_PERIOD        = 14
ATR_SL_MULT       = 1.5
MIN_SPIKE_CANDLES = 2
BODY_RATIO_MIN    = 0.50
MAX_HOLD_CANDLES  = 5
MONTHS_BACK       = 1

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


def detect_spike_exhaustion(ltf_df, htf_df, mode):
    ltf_df = ltf_df.copy().reset_index(drop=True)
    htf_df = htf_df.copy().reset_index(drop=True)
    ltf_df['atr']   = calc_atr(ltf_df)
    htf_df['ema50'] = calc_ema(htf_df['close'], EMA_PERIOD)

    setups = []
    for i in range(MIN_SPIKE_CANDLES, len(ltf_df) - 1):
        c0 = ltf_df.iloc[i]
        c1 = ltf_df.iloc[i-1]
        c2 = ltf_df.iloc[i-2]

        atr_val = c0['atr']
        if pd.isna(atr_val) or atr_val == 0:
            continue

        # HTF trend filter
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


def run_backtest(name, ltf_df, htf_df, mode, reward_ratio):
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
        tp      = entry - (sl_dist * reward_ratio) if mode == "BOOM" else entry + (sl_dist * reward_ratio)

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
            result = 'TIME_EXIT'

        pnl = RISK_USD * reward_ratio if result == 'WIN' else (-RISK_USD if result == 'LOSS' else 0)
        trades.append({'result': result, 'pnl': pnl})
        used_idx.add(i)

    total      = len(trades)
    wins       = sum(1 for t in trades if t['result'] == 'WIN')
    losses     = sum(1 for t in trades if t['result'] == 'LOSS')
    time_exits = sum(1 for t in trades if t['result'] == 'TIME_EXIT')
    net        = sum(t['pnl'] for t in trades)
    wr         = (wins / total * 100) if total > 0 else 0

    return {'name': name, 'mode': mode, 'trades': total, 'wins': wins,
            'losses': losses, 'time_exits': time_exits, 'wr': wr, 'net_pnl': net}


def main():
    SEP = "=" * 110

    if not mt5.initialize():
        print(f"\n  MT5 connection failed: {mt5.last_error()}")
        print("  >> Make sure MetaTrader 5 is OPEN and logged into your Deriv Demo account.")
        sys.exit(1)

    info = mt5.terminal_info()
    print(f"\n{SEP}")
    print("  SPIKE EXHAUSTION STRATEGY — 1:2 RR vs 1:3 RR COMPARISON BACKTEST")
    print(f"  MT5 Terminal: {info.name}")
    print(f"  3-Month | All 20 Boom & Crash Pairs | ${RISK_USD:.0f} Risk/Trade | Max {MAX_HOLD_CANDLES} Candles Hold")
    print(SEP)

    end_date   = datetime.now()
    start_date = end_date - timedelta(days=MONTHS_BACK * 31)
    all_results = {rr: [] for rr in RR_TO_TEST}
    skipped     = []

    for display_name, meta in PAIRS.items():
        mode = meta['mode']
        mt5.symbol_select(display_name, True)
        sym_info = mt5.symbol_info(display_name)
        if sym_info is None:
            print(f"  [SKIP] {display_name:<22} — not found on this account.")
            skipped.append(display_name)
            continue

        ltf_rates = mt5.copy_rates_range(display_name, mt5.TIMEFRAME_M5, start_date, end_date)
        htf_rates = mt5.copy_rates_range(display_name, mt5.TIMEFRAME_H1, start_date, end_date)

        if ltf_rates is None or len(ltf_rates) == 0:
            print(f"  [SKIP] {display_name:<22} — no candle data.")
            skipped.append(display_name)
            continue

        ltf_df = pd.DataFrame(ltf_rates)
        htf_df = pd.DataFrame(htf_rates)
        ltf_df['time'] = pd.to_datetime(ltf_df['time'], unit='s')
        htf_df['time'] = pd.to_datetime(htf_df['time'], unit='s')

        print(f"  [OK]   {display_name:<22} -> {len(ltf_df):>6} x 5m | {len(htf_df):>5} x 1h")

        for rr in RR_TO_TEST:
            r = run_backtest(display_name, ltf_df, htf_df, mode, rr)
            all_results[rr].append(r)

    mt5.shutdown()

    for rr in RR_TO_TEST:
        results  = sorted(all_results[rr], key=lambda x: x['net_pnl'], reverse=True)
        win_usd  = RISK_USD * rr
        print(f"\n{SEP}")
        print(f"  SCORECARD  —  1:{rr:.0f} R:R   Risk ${RISK_USD:.0f}  /  Win ${win_usd:.0f}")
        print(SEP)
        print(f"{'#':<4} {'Pair':<22} {'Mode':<7} {'Trades':>7} {'Wins':>5} {'Loss':>5} {'TimeX':>6} {'WR%':>7} {'Net PnL':>14}")
        print("-" * 110)
        gtrades = gwins = glosses = gtime = 0
        gpnl    = 0.0
        for idx, r in enumerate(results):
            crown = " <- BEST" if idx == 0 else ""
            pstr  = f"+${r['net_pnl']:,.2f}" if r['net_pnl'] >= 0 else f"-${abs(r['net_pnl']):,.2f}"
            print(f"{idx+1:<4} {r['name']:<22} {r['mode']:<7} {r['trades']:>7} "
                  f"{r['wins']:>5} {r['losses']:>5} {r['time_exits']:>6} {r['wr']:>6.1f}% {pstr:>14}{crown}")
            gtrades += r['trades'];  gwins  += r['wins']
            glosses += r['losses'];  gtime  += r['time_exits']
            gpnl    += r['net_pnl']
        gwr = (gwins / gtrades * 100) if gtrades > 0 else 0
        print(SEP)
        print(f"\n  TOTALS — 1:{rr:.0f} R:R | {len(results)} pairs | {MONTHS_BACK} months")
        print(f"    Trades: {gtrades}  |  Wins: {gwins}  |  Losses: {glosses}  |  Time Exits: {gtime}")
        print(f"    Win Rate  : {gwr:.2f}%")
        print(f"    Net PnL   : ${gpnl:+,.2f}  (${RISK_USD:.0f} risk/trade)")
        print(f"    Monthly   : ${gpnl/MONTHS_BACK:+,.2f}/month")

    # Side-by-side summary
    print(f"\n{SEP}")
    print("  HEAD-TO-HEAD  —  1:2 RR  vs  1:3 RR")
    print(SEP)
    r2 = all_results.get(2.0, [])
    r3 = all_results.get(3.0, [])
    if r2 and r3:
        t2 = sum(r['trades'] for r in r2);  w2 = sum(r['wins'] for r in r2);  p2 = sum(r['net_pnl'] for r in r2)
        t3 = sum(r['trades'] for r in r3);  w3 = sum(r['wins'] for r in r3);  p3 = sum(r['net_pnl'] for r in r3)
        wr2 = (w2/t2*100) if t2 else 0;     wr3 = (w3/t3*100) if t3 else 0
        print(f"  {'Metric':<35} {'1:2 R:R':>20} {'1:3 R:R':>20}")
        print("-" * 80)
        print(f"  {'Total Trades':<35} {t2:>20} {t3:>20}")
        print(f"  {'Win Rate':<35} {wr2:>19.2f}% {wr3:>19.2f}%")
        print(f"  {'Net PnL':<35} {'${:,.2f}'.format(p2):>20} {'${:,.2f}'.format(p3):>20}")
        print(f"  {'Monthly Avg PnL':<35} {'${:,.2f}'.format(p2/3):>20} {'${:,.2f}'.format(p3/3):>20}")
        winner = "1:2 R:R" if p2 > p3 else "1:3 R:R"
        diff   = abs(p2 - p3)
        print(f"\n  WINNER: {winner}  (by ${diff:,.2f} over 3 months)")

    if skipped:
        print(f"\n  Skipped: {', '.join(skipped)}")
    print(f"\n{SEP}\n")


if __name__ == "__main__":
    main()
