#!/usr/bin/env python3
"""
chart_auditor.py
Headless Multimodal Chart Renderer for Mytrada Algo Trading Bot.
Renders candlestick charts via matplotlib (headless 'Agg' backend)
and outputs base64-encoded PNG image to stdout.
"""

import sys
import os
import json
import base64

# Ensure unbuffered UTF-8 output
sys.stdout.reconfigure(encoding='utf-8')

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import pandas as pd

def render_chart_image(trade_data, candles):
    prior_candles = candles[-45:] if len(candles) >= 45 else candles
    if not prior_candles:
        raise ValueError("No candles provided for chart rendering.")

    df = pd.DataFrame(prior_candles)
    fig, ax = plt.subplots(figsize=(10, 5), dpi=100)
    fig.patch.set_facecolor('#0f1117')
    ax.set_facecolor('#0f1117')

    width = 0.6
    width2 = 0.1
    up = df[df['close'] >= df['open']]
    down = df[df['close'] < df['open']]

    col_up = '#00ff88'
    col_down = '#ff3366'

    # Up candles
    ax.bar(up.index, up['close'] - up['open'], width, bottom=up['open'], color=col_up, edgecolor=col_up)
    ax.bar(up.index, up['high'] - up['close'], width2, bottom=up['close'], color=col_up)
    ax.bar(up.index, up['low'] - up['open'], width2, bottom=up['open'], color=col_up)

    # Down candles
    ax.bar(down.index, down['open'] - down['close'], width, bottom=down['close'], color=col_down, edgecolor=col_down)
    ax.bar(down.index, down['high'] - down['open'], width2, bottom=down['open'], color=col_down)
    ax.bar(down.index, down['low'] - down['close'], width2, bottom=down['close'], color=col_down)

    entry = trade_data['entry']
    tp = trade_data['tp']
    sl = trade_data['sl']
    symbol = trade_data.get('symbol', 'UNKNOWN')
    direction = trade_data.get('direction', 'BUY')

    # Draw Entry, SL, TP lines
    ax.axhline(entry, color='#00d4ff', linestyle='--', linewidth=1.5, label=f"Entry: {entry:.2f}")
    ax.axhline(tp, color='#00ff88', linestyle='-', linewidth=2.0, label=f"TP Target: {tp:.2f}")
    ax.axhline(sl, color='#ff3366', linestyle='-', linewidth=2.0, label=f"Stop Loss: {sl:.2f}")

    # Set precise Y limits with 8% margin
    all_prices = [float(c['low']) for c in prior_candles] + [float(c['high']) for c in prior_candles] + [entry, tp, sl]
    min_p = min(all_prices)
    max_p = max(all_prices)
    pad = (max_p - min_p) * 0.08
    ax.set_ylim(min_p - pad, max_p + pad)

    ax.set_title(f"Mytrada Vision Audit | {symbol} {direction} | Entry: {entry:.2f} | TP: {tp:.2f} | SL: {sl:.2f}",
                 fontsize=11, color='white', pad=10)
    ax.legend(loc='upper left', fontsize=9, facecolor='#1a1d26', edgecolor='#2d3139', labelcolor='white')
    ax.grid(True, linestyle=':', alpha=0.25, color='#ffffff')

    ax.tick_params(colors='#8b949e', which='both')
    for spine in ax.spines.values():
        spine.set_color('#2d3139')

    plt.tight_layout()

    from io import BytesIO
    buf = BytesIO()
    plt.savefig(buf, format='png', facecolor=fig.get_facecolor(), edgecolor='none')
    plt.close(fig)
    buf.seek(0)
    return buf.read()

def main():
    try:
        input_data = json.loads(sys.stdin.read())
        trade_data = input_data['trade']
        candles = input_data['candles']

        img_bytes = render_chart_image(trade_data, candles)
        b64 = base64.b64encode(img_bytes).decode('utf-8')
        print(json.dumps({"success": True, "image_base64": b64}))
    except Exception as err:
        print(json.dumps({"success": False, "error": str(err)}))

if __name__ == "__main__":
    main()
