"""
mt5_backtest_full.py
====================
3-Month Full Backtest for ALL Boom & Crash pairs available on MT5.
Pulls real historical candle data DIRECTLY from your MT5 Desktop terminal
(not the Deriv WS API), so all 9 Boom + all Crash pairs are included.

Pairs covered:
  BOOM:  Boom 50, 99, 100, 150, 200, 300, 500, 900, 1000
  CRASH: Crash 300, 500, 600, 1000

Strategy: SMC Order Block + 50 EMA Trend Filter | Clean 1:2 R:R | No BE Trailing
Risk per trade: $1.00 on a $100 account (1% risk)
"""

import MetaTrader5 as mt5
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import sys

# CONFIG
RISK_USD      = 1.00
REWARD_RATIO  = 2.0
ENABLE_BE     = False
EMA_PERIOD    = 50
ATR_PERIOD    = 14
ATR_SL_MULT   = 1.5
MONTHS_BACK   = 3

# Exact symbol names as MT5 reports them (confirmed via mt5.symbols_get())
PAIRS = {
    # ── BOOM (Tick Scalping: price spikes UP → sell the OB retrace) ──
    "Boom 50 Index":   {"mode": "BOOM"},
    "Boom 99 Index":   {"mode": "BOOM"},
    "Boom 100 Index":  {"mode": "BOOM"},
    "Boom 150 Index":  {"mode": "BOOM"},
    "Boom 200 Index":  {"mode": "BOOM"},
    "Boom 300 Index":  {"mode": "BOOM"},
    "Boom 500 Index":  {"mode": "BOOM"},
    "Boom 600 Index":  {"mode": "BOOM"},
    "Boom 900 Index":  {"mode": "BOOM"},
    "Boom 1000 Index": {"mode": "BOOM"},
    # ── CRASH (Spike Catching: price spikes DOWN → buy the retrace) ──
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


def detect_order_blocks(df, mode):
    obs = []
    for i in range(2, len(df) - 1):
        cur = df.iloc[i]
        nxt = df.iloc[i + 1]
        body_cur = abs(cur['close'] - cur['open'])
        body_nxt = abs(nxt['close'] - nxt['open'])
        if mode == "BOOM":
            if (cur['close'] > cur['open'] and
                    nxt['close'] < nxt['open'] and
                    body_nxt > body_cur * 1.2):
                obs.append({'index': i, 'ob_high': cur['high'], 'ob_low': cur['open']})
        else:
            if (cur['close'] < cur['open'] and
                    nxt['close'] > nxt['open'] and
                    body_nxt > body_cur * 1.2):
                obs.append({'index': i, 'ob_high': cur['close'], 'ob_low': cur['low']})
    return obs


def run_backtest(name, ltf_df, htf_df, mode, point):
    ltf_df = ltf_df.copy().reset_index(drop=True)
    htf_df = htf_df.copy().reset_index(drop=True)

    ltf_df['ema50'] = calc_ema(ltf_df['close'], EMA_PERIOD)
    ltf_df['atr']   = calc_atr(ltf_df)
    htf_df['ema50'] = calc_ema(htf_df['close'], EMA_PERIOD)

    obs      = detect_order_blocks(ltf_df, mode)
    trades   = []
    used_obs = set()

    for ob in obs:
        ob_i = ob['index']
        if ob_i in used_obs:
            continue

        ob_high = ob['ob_high']
        ob_low  = ob['ob_low']
        ob_mid  = (ob_high + ob_low) / 2
        atr_val = ltf_df.iloc[ob_i]['atr']
        if pd.isna(atr_val) or atr_val == 0:
            continue

        ltf_time  = ltf_df.iloc[ob_i]['time']
        htf_slice = htf_df[htf_df['time'] <= ltf_time]
        if htf_slice.empty:
            continue

        htf_ema   = htf_slice.iloc[-1]['ema50']
        htf_close = htf_slice.iloc[-1]['close']

        if mode == "BOOM":
            if htf_close >= htf_ema:
                continue
            entry = ob_mid
            sl    = ob_high + atr_val * ATR_SL_MULT
            tp    = entry - (sl - entry) * REWARD_RATIO
        else:
            if htf_close <= htf_ema:
                continue
            entry = ob_mid
            sl    = ob_low - atr_val * ATR_SL_MULT
            tp    = entry + (entry - sl) * REWARD_RATIO

        result = None
        for j in range(ob_i + 1, min(ob_i + 25, len(ltf_df))):
            c = ltf_df.iloc[j]
            if mode == "BOOM":
                if c['high'] >= sl:
                    result = 'LOSS'
                    break
                if c['low'] <= tp:
                    result = 'WIN'
                    break
            else:
                if c['low'] <= sl:
                    result = 'LOSS'
                    break
                if c['high'] >= tp:
                    result = 'WIN'
                    break

        if result is None:
            continue

        pnl = RISK_USD * REWARD_RATIO if result == 'WIN' else -RISK_USD
        trades.append({'result': result, 'pnl': pnl})
        used_obs.add(ob_i)

    total  = len(trades)
    wins   = sum(1 for t in trades if t['result'] == 'WIN')
    losses = total - wins
    net    = sum(t['pnl'] for t in trades)
    wr     = (wins / total * 100) if total > 0 else 0

    return {
        'name':    name,
        'mode':    mode,
        'trades':  total,
        'wins':    wins,
        'losses':  losses,
        'wr':      wr,
        'net_pnl': net,
        'roi':     (net / 100) * 100
    }


def main():
    SEP = "=" * 100
    print(f"\n{SEP}")
    print("  3-MONTH FULL BACKTEST: ALL BOOM & CRASH PAIRS  (pulled direct from MT5)")
    print(SEP)
    print(f"  LTF: 5m | HTF Filter: 1h 50 EMA | Period: {MONTHS_BACK} months")
    print(f"  Risk: ${RISK_USD}/trade | RR: 1:{REWARD_RATIO} | Break-Even: OFF | Account: $100")
    print(SEP)

    if not mt5.initialize():
        print(f"\n  MT5 connection failed: {mt5.last_error()}")
        print("  >> Make sure MetaTrader 5 is OPEN and logged into your Deriv demo account.")
        sys.exit(1)

    info = mt5.terminal_info()
    print(f"\n  MT5 connected: {info.name}\n")

    end_date   = datetime.now()
    start_date = end_date - timedelta(days=MONTHS_BACK * 31)

    results = []
    skipped = []

    for display_name, meta in PAIRS.items():
        sym  = display_name   # MT5 uses full display names like "Boom 300 Index"
        mode = meta['mode']

        mt5.symbol_select(sym, True)
        sym_info = mt5.symbol_info(sym)
        if sym_info is None:
            print(f"  [SKIP] {sym:<12} not found on this account.")
            skipped.append(display_name)
            continue

        point = sym_info.point

        ltf_rates = mt5.copy_rates_range(sym, mt5.TIMEFRAME_M5, start_date, end_date)
        htf_rates = mt5.copy_rates_range(sym, mt5.TIMEFRAME_H1, start_date, end_date)

        if ltf_rates is None or len(ltf_rates) == 0:
            print(f"  [SKIP] {sym:<12} – no candle data returned.")
            skipped.append(display_name)
            continue

        ltf_df = pd.DataFrame(ltf_rates)
        htf_df = pd.DataFrame(htf_rates)
        ltf_df['time'] = pd.to_datetime(ltf_df['time'], unit='s')
        htf_df['time'] = pd.to_datetime(htf_df['time'], unit='s')

        print(f"  [OK]   {display_name:<22} -> {len(ltf_df):>6} x 5m candles | {len(htf_df):>5} x 1h candles | backtesting...")

        r = run_backtest(display_name, ltf_df, htf_df, mode, point)
        results.append(r)

    mt5.shutdown()

    if not results:
        print("\n  No results. Ensure MT5 is open and symbols are loaded.")
        sys.exit(1)

    results.sort(key=lambda x: x['net_pnl'], reverse=True)

    # Scorecard
    print(f"\n{SEP}")
    print("  3-MONTH BOOM & CRASH SCORECARD  (1:2 R:R | $1 risk | $100 account)")
    print(SEP)
    header = f"{'#':<4} {'Pair':<22} {'Mode':<7} {'Trades':>7} {'Wins':>5} {'Loss':>5} {'WR%':>7} {'Net PnL':>12} {'ROI%':>8}"
    print(header)
    print("-" * 100)

    gtrades = gwins = glosses = 0
    gpnl = 0.0

    for i, r in enumerate(results):
        crown = " <-- BEST" if i == 0 else ""
        pstr = f"+${r['net_pnl']:.2f}" if r['net_pnl'] >= 0 else f"-${abs(r['net_pnl']):.2f}"
        rstr = f"+{r['roi']:.1f}%"     if r['roi']     >= 0 else f"-{abs(r['roi']):.1f}%"
        print(f"{i+1:<4} {r['name']:<22} {r['mode']:<7} {r['trades']:>7} {r['wins']:>5} {r['losses']:>5} "
              f"{r['wr']:>6.1f}% {pstr:>12} {rstr:>8}{crown}")
        gtrades  += r['trades']
        gwins    += r['wins']
        glosses  += r['losses']
        gpnl     += r['net_pnl']

    gwr  = (gwins / gtrades * 100) if gtrades > 0 else 0
    groi = (gpnl / 100) * 100

    print(SEP)
    print(f"\n  PORTFOLIO TOTALS ({len(results)} pairs, 3 months):")
    print(f"    Trades        : {gtrades}")
    print(f"    Wins          : {gwins}  |  Losses: {glosses}  |  Win Rate: {gwr:.2f}%")
    print(f"    Net PnL       : ${gpnl:+.2f}  (on $100 starting balance)")
    print(f"    ROI           : {groi:+.1f}%")
    print(f"    Monthly Avg   : ${gpnl/3:+.2f} / month")
    if skipped:
        print(f"\n    Skipped (not on this account): {', '.join(skipped)}")
    print(f"\n{SEP}\n")


if __name__ == "__main__":
    main()
