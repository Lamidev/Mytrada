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

def draw_candles_on_ax(ax, candles):
    width = 0.6
    width2 = 0.1
    col_up = '#00ff88'
    col_down = '#ff3366'

    for i, c in enumerate(candles):
        op = float(c['open'])
        cl = float(c['close'])
        hi = float(c['high'])
        lo = float(c['low'])

        color = col_up if cl >= op else col_down
        bottom = min(op, cl)
        height = max(abs(cl - op), 0.0001)

        ax.bar(i, height, width, bottom=bottom, color=color, edgecolor=color)
        ax.bar(i, hi - max(op, cl), width2, bottom=max(op, cl), color=color)
        ax.bar(i, min(op, cl) - lo, width2, bottom=lo, color=color)

    ax.set_facecolor('#0f1117')
    ax.grid(True, linestyle=':', alpha=0.25, color='#ffffff')
    ax.tick_params(colors='#8b949e', which='both')
    for spine in ax.spines.values():
        spine.set_color('#2d3139')

def render_chart_image(trade_data, candles, htf_candles=None):
    prior_candles = candles[-45:] if len(candles) >= 45 else candles
    if not prior_candles:
        raise ValueError("No candles provided for chart rendering.")

    entry = trade_data['entry']
    tp = trade_data['tp']
    sl = trade_data['sl']
    symbol = trade_data.get('symbol', 'UNKNOWN')
    direction = trade_data.get('direction', 'BUY')

    has_htf = htf_candles is not None and len(htf_candles) > 0
    prior_htf = htf_candles[-35:] if has_htf and len(htf_candles) >= 35 else htf_candles

    if has_htf:
        fig, (ax_htf, ax_ltf) = plt.subplots(2, 1, figsize=(11, 7.5), dpi=100, gridspec_kw={'height_ratios': [1, 1.25]})
        fig.patch.set_facecolor('#0f1117')

        # ── TOP PANEL: 1H MACRO MARKET STRUCTURE ──
        draw_candles_on_ax(ax_htf, prior_htf)
        ax_htf.set_title(f"PANEL 1: 1-Hour (1H) Macro Market Structure | {symbol} (Last ~35 Hours)",
                         fontsize=10, color='#58a6ff', pad=8, fontweight='bold')
        ax_htf.axhline(entry, color='#00d4ff', linestyle=':', linewidth=1.2, alpha=0.7, label=f"Current Price: {entry:.2f}")
        ax_htf.legend(loc='upper left', fontsize=8, facecolor='#1a1d26', edgecolor='#2d3139', labelcolor='white')

        # ── BOTTOM PANEL: 5M EXECUTION RUNWAY ──
        draw_candles_on_ax(ax_ltf, prior_candles)
        ax_ltf.axhline(entry, color='#00d4ff', linestyle='--', linewidth=1.5, label=f"Entry: {entry:.2f}")
        ax_ltf.axhline(tp, color='#00ff88', linestyle='-', linewidth=2.0, label=f"TP Target: {tp:.2f}")
        ax_ltf.axhline(sl, color='#ff3366', linestyle='-', linewidth=2.0, label=f"Stop Loss: {sl:.2f}")

        all_prices = [float(c['low']) for c in prior_candles] + [float(c['high']) for c in prior_candles] + [entry, tp, sl]
        min_p = min(all_prices)
        max_p = max(all_prices)
        pad = (max_p - min_p) * 0.08
        ax_ltf.set_ylim(min_p - pad, max_p + pad)

        ax_ltf.set_title(f"PANEL 2: 5-Minute (5M) Execution Runway | {direction} | Entry: {entry:.2f} | TP: {tp:.2f} | SL: {sl:.2f}",
                         fontsize=10, color='white', pad=8, fontweight='bold')
        ax_ltf.legend(loc='upper left', fontsize=8, facecolor='#1a1d26', edgecolor='#2d3139', labelcolor='white')

    else:
        fig, ax_ltf = plt.subplots(figsize=(10, 5), dpi=100)
        fig.patch.set_facecolor('#0f1117')
        draw_candles_on_ax(ax_ltf, prior_candles)
        ax_ltf.axhline(entry, color='#00d4ff', linestyle='--', linewidth=1.5, label=f"Entry: {entry:.2f}")
        ax_ltf.axhline(tp, color='#00ff88', linestyle='-', linewidth=2.0, label=f"TP Target: {tp:.2f}")
        ax_ltf.axhline(sl, color='#ff3366', linestyle='-', linewidth=2.0, label=f"Stop Loss: {sl:.2f}")

        all_prices = [float(c['low']) for c in prior_candles] + [float(c['high']) for c in prior_candles] + [entry, tp, sl]
        min_p = min(all_prices)
        max_p = max(all_prices)
        pad = (max_p - min_p) * 0.08
        ax_ltf.set_ylim(min_p - pad, max_p + pad)

        ax_ltf.set_title(f"Mytrada Vision Audit | {symbol} {direction} | Entry: {entry:.2f} | TP: {tp:.2f} | SL: {sl:.2f}",
                         fontsize=11, color='white', pad=10)
        ax_ltf.legend(loc='upper left', fontsize=9, facecolor='#1a1d26', edgecolor='#2d3139', labelcolor='white')

    plt.tight_layout()

    from io import BytesIO
    buf = BytesIO()
    plt.savefig(buf, format='png', facecolor=fig.get_facecolor(), edgecolor='none')
    plt.close(fig)
    buf.seek(0)
    return buf.read()

def process_payload(input_data):
    trade_data = input_data['trade']
    candles = input_data['candles']
    htf_candles = input_data.get('htf_candles')
    img_bytes = render_chart_image(trade_data, candles, htf_candles)
    return base64.b64encode(img_bytes).decode('utf-8')

def main():
    if '--daemon' in sys.argv:
        print("WORKER_READY", flush=True)
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                input_data = json.loads(line)
                b64 = process_payload(input_data)
                print(json.dumps({"success": True, "image_base64": b64}), flush=True)
            except Exception as err:
                print(json.dumps({"success": False, "error": str(err)}), flush=True)
    else:
        try:
            input_data = json.loads(sys.stdin.read())
            b64 = process_payload(input_data)
            print(json.dumps({"success": True, "image_base64": b64}))
        except Exception as err:
            print(json.dumps({"success": False, "error": str(err)}))

if __name__ == "__main__":
    main()
