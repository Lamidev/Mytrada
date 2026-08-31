# Mytrada Quantitative Strategy Changelog & Fail-Safe Rollback Registry

**Repository:** `Mytrada`  
**Active Production Model:** Strategy 5B (High-Frequency Momentum Exhaustion Sniper)  
**Purpose:** Official historical log of all parameter, code, and portfolio modifications. Provides an immutable audit trail and instant **Fail-Safe Switch / Rollback Instructions** for any experimental or tuning change.

---

## 📑 Changelog Table of Contents
1. [Active Production Snapshot](#active-production-snapshot)
2. [Version History & Modification Logs](#version-history--modification-logs)
   - [v5.2 — August 29, 2026](#v52--august-29-2026)
   - [v5.1 — August 28, 2026](#v51--august-28-2026)
   - [v5.0 — August 25, 2026](#v50--august-25-2026)
   - [v4.0 — August 23, 2026 (Baseline)](#v40--august-23-2026-baseline)
3. [Fail-Safe Switch: Instant Rollback Manual](#fail-safe-switch-instant-rollback-manual)

---

## Active Production Snapshot

| Parameter | Current Live Setting | File Location | Baseline Default |
| :--- | :--- | :--- | :--- |
| **Strategy Model** | Strategy 5B (Momentum Exhaustion) | [`runner.js`](file:///c:/Users/user/Desktop/My-Projects/Active-projects/Mytrada/runner.js) | Strategy 5B |
| **Active Portfolio** | 7 Elite Pairs (`BOOM100`, `BOOM300N`, `BOOM600`, `BOOM900`, `CRASH1000`, `CRASH200`, `CRASH500`) | [`config.js`](file:///c:/Users/user/Desktop/My-Projects/Active-projects/Mytrada/config.js#L14-L25) | 13 Pairs |
| **Target R:R** | Fixed 1:1.3 R:R | [`config.js`](file:///c:/Users/user/Desktop/My-Projects/Active-projects/Mytrada/config.js#L47) | 1:1.3 |
| **Max Risk USD** | $3.00 (3.0% on $100) | [`config.js`](file:///c:/Users/user/Desktop/My-Projects/Active-projects/Mytrada/config.js#L43-L44) | $3.00 |
| **BOOM100 Min Spikes** | **3 Spikes** | [`config.js`](file:///c:/Users/user/Desktop/My-Projects/Active-projects/Mytrada/config.js#L16) | 2 Spikes |
| **BOOM300N Min Spikes** | **3 Spikes** | [`config.js`](file:///c:/Users/user/Desktop/My-Projects/Active-projects/Mytrada/config.js#L17) | 2 Spikes |
| **BOOM600 Min Spikes** | **3 Spikes** | [`config.js`](file:///c:/Users/user/Desktop/My-Projects/Active-projects/Mytrada/config.js#L18) | 2 Spikes |
| **Tier 1 Cooldown** | **45 Minutes** (9x M5 bars) | [`config.js`](file:///c:/Users/user/Desktop/My-Projects/Active-projects/Mytrada/config.js#L54) | 30 Minutes |
| **Tier 2 Cooldown** | **60 Minutes** (12x M5 bars) | [`config.js`](file:///c:/Users/user/Desktop/My-Projects/Active-projects/Mytrada/config.js#L55) | 60 Minutes |
| **Daily Symbol Loss Cap** | **3 Losses** (End-of-day Lockout) | [`config.js`](file:///c:/Users/user/Desktop/My-Projects/Active-projects/Mytrada/config.js#L56) | 3 Losses |

---

## Version History & Modification Logs

### v5.2 — August 29, 2026
* **Commit:** `62d6a8e`
* **Author/Operator:** Antigravity / Lamidev
* **Changes Made:**
  - Upgraded `BOOM100` from `min_spikes: 2` to `min_spikes: 3`.
* **Rationale / Hypothesis:**
  - `BOOM100` experienced rapid double-spike false exhaustions during high-volatility sessions on Wednesday/Thursday. Requiring 3 consecutive spikes forces deeper exhaustion before triggering sell signals.
* **Live Impact Observed:**
  - `BOOM100` went 2W / 2L on Saturday (+0.6R) and 0 trades on Sunday, completely avoiding the Sunday drawdown session.
* **Rollback Switch:**
  - Change line 16 in `config.js` and `mt5_runner.py` from `min_spikes: 3` back to `min_spikes: 2`.

---

### v5.1 — August 28, 2026
* **Commit:** `2bc21a2`
* **Author/Operator:** Antigravity / Lamidev
* **Changes Made:**
  - Upgraded `BOOM600` from `min_spikes: 2` to `min_spikes: 3`.
  - Increased Tier-1 Circuit Breaker `TIER_1_PAUSE_MINS` from `30` to `45` minutes.
* **Rationale / Hypothesis:**
  - 30 minutes (6 M5 candles) proved too short to allow violent spike momentum to settle after an SL breach. 45 minutes (9 M5 candles) ensures a deeper market structure reset before re-engaging.
* **Live Impact Observed:**
  - Prevented rapid-fire revenge entries during extended multi-spike runs on `CRASH200` and `BOOM600`.
* **Rollback Switch:**
  - In `config.js`, set `BOOM600` `min_spikes: 2` and `TIER_1_PAUSE_MINS: 30`.

---

### v5.0 — August 25, 2026
* **Commit:** `c6edc7c`, `44058f7`, `9140661`
* **Author/Operator:** Antigravity / Lamidev
* **Changes Made:**
  - Upgraded `BOOM300N` to `min_spikes: 3`.
  - Implemented persistent JSON cache for circuit breakers, active trades, and daily reports across restarts.
  - Added real-time Telegram disconnect / crash alerts.
  - Streamlined signal output format.
* **Rationale / Hypothesis:**
  - `BOOM300N` has extreme spike frequency; 2 spikes frequently resulted in premature entries. 3 spikes delivered 68.4% backtest win rate.
* **Live Impact Observed:**
  - `BOOM300N` achieved top performance on Thursday (4W / 0L, +100% WR) and Saturday (4W / 2L, +67% WR).
* **Rollback Switch:**
  - Set `BOOM300N` `min_spikes: 2`.

---

### v4.0 — August 23, 2026 (Baseline Strategy 5B Launch)
* **Commit:** `0f3433e`
* **Author/Operator:** Antigravity / Lamidev
* **Baseline Configuration:**
  - 13 Elite Boom & Crash Portfolio.
  - Daily + 4H + 1H 50 EMA multi-timeframe trend confluence.
  - 1H Chop Clearance Filter (>0.08%).
  - 2-Spike Exhaustion Trigger with 5M Body $\ge 50\%$.
  - 1:1.3 R:R Fixed TP with Peak $\pm 1.5\times$ ATR SL.
  - 30m / 60m / 3-Loss Circuit Breakers.

---

## Fail-Safe Switch: Instant Rollback Manual

If ANY new parameter or tuning test produces consecutive adverse results, use this section to immediately return to a known profitable baseline without guessing.

### Option 1: Revert Entire Codebase to v4.0 Baseline
To restore the clean baseline state via git:
```bash
git checkout 0f3433e -- config.js runner.js mt5_runner.py
pm2 restart all
```

### Option 2: Individual Parameter Toggles (in `config.js`)

#### 1. Revert Cooldown to 30 Minutes:
```javascript
// config.js line 54:
TIER_1_PAUSE_MINS: 30, // Default 30m
```

#### 2. Revert All Pairs to Pure 2-Spike Mode:
```javascript
// config.js lines 16-19:
"BOOM100":   { name: "Boom 100 Index",  mode: "BOOM", min_spikes: 2 },
"BOOM300N":  { name: "Boom 300 Index",  mode: "BOOM", min_spikes: 2 },
"BOOM600":   { name: "Boom 600 Index",  mode: "BOOM", min_spikes: 2 },
"BOOM900":   { name: "Boom 900 Index",  mode: "BOOM", min_spikes: 2 },
```

#### 3. Restart Signal Engine (Apply Changes Live):
```bash
pm2 restart runner
# or
node runner.js
```
