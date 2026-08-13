# scratch/find_mt5_symbols.py
# Lists ALL symbols available in MT5 that contain "boom" or "crash"
import MetaTrader5 as mt5

if not mt5.initialize():
    print(f"MT5 connect failed: {mt5.last_error()}")
    exit(1)

all_symbols = mt5.symbols_get()
print(f"\nMT5 connected. Total symbols available: {len(all_symbols)}\n")

print("=== ALL BOOM SYMBOLS ===")
boom_syms = [s for s in all_symbols if 'boom' in s.name.lower()]
for s in boom_syms:
    print(f"  Name: {s.name:<20} | Description: {s.description}")

print("\n=== ALL CRASH SYMBOLS ===")
crash_syms = [s for s in all_symbols if 'crash' in s.name.lower()]
for s in crash_syms:
    print(f"  Name: {s.name:<20} | Description: {s.description}")

mt5.shutdown()
