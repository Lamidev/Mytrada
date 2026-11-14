// strategy6.js
/**
 * 👑 STRATEGY 6: STRUCTURAL MOMENTUM SNIPER
 * 
 * Evolution of Strategy 5B Pro with institutional Price Action & SMC filters:
 * 1. Triple Confluence: 1D + 4H + 1H 50 EMA Macro Trend
 * 2. Universal 2-Spike / 3-Spike Exhaustion Pullback with Value-Zone Retest
 * 3. 🛡️ Guard 1 (CHoCH Structure Shield): Rejects SELLs on Higher High spikes (Boom) 
 *    and BUYs on Lower Low crashes (Crash).
 * 4. 🛡️ Guard 2 (Spike Density Shield): Rejects entry during high-velocity spike clusters (>=3 spikes in 45m).
 * 5. 🛡️ Guard 3 (Equilibrium Dealing Range Corridor): Enforces 35% floor for Boom Sells and 65% ceiling for Crash Buys.
 * 6. 🛡️ Guard 4 (Active 1H Bar Guard): Enforces active 1H bar color alignment.
 */

const config = require('./config');
const { evaluateMacroExhaustion } = require('./godeyesMemory');

function calculateEMA(prices, period) {
  if (!prices || prices.length < period) return [];
  const k = 2 / (period + 1);
  const ema = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += prices[i];
  let prev = sum / period;
  ema[period - 1] = prev;
  for (let i = period; i < prices.length; i++) {
    prev = (prices[i] - prev) * k + prev;
    ema[i] = prev;
  }
  return ema;
}

function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 1.0;
  let trSum = 0;
  for (let i = 1; i <= period; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trSum += tr;
  }
  let prevAtr = trSum / period;
  for (let i = period + 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    prevAtr = (prevAtr * (period - 1) + tr) / period;
  }
  return prevAtr;
}

/**
 * Finds preceding spike peaks on Boom (or crash troughs on Crash)
 * in the recent M5 history before the current setup.
 */
function findPrecedingSwingExtreme(ltfCandles, mode, currentSpikeStartIndex, atr) {
  // Look back up to 24 bars (2 hours) before the current spike started
  const lookbackEnd = Math.max(0, currentSpikeStartIndex - 24);
  
  if (mode === 'BOOM') {
    let prevSpikePeak = -Infinity;
    let found = false;
    for (let i = currentSpikeStartIndex - 2; i >= lookbackEnd; i--) {
      const c = ltfCandles[i];
      if (!c) continue;
      const isSpike = (c.close > c.open) && ((c.high - c.low) >= (atr * 0.8));
      if (isSpike) {
        if (c.high > prevSpikePeak) prevSpikePeak = c.high;
        found = true;
      } else if (found && prevSpikePeak > -Infinity) {
        // We've found the peak of the preceding spike sequence
        break;
      }
    }
    return found ? prevSpikePeak : null;
  } else {
    // CRASH
    let prevCrashTrough = Infinity;
    let found = false;
    for (let i = currentSpikeStartIndex - 2; i >= lookbackEnd; i--) {
      const c = ltfCandles[i];
      if (!c) continue;
      const isCrash = (c.close < c.open) && ((c.high - c.low) >= (atr * 0.8));
      if (isCrash) {
        if (c.low < prevCrashTrough) prevCrashTrough = c.low;
        found = true;
      } else if (found && prevCrashTrough < Infinity) {
        break;
      }
    }
    return found ? prevCrashTrough : null;
  }
}

/**
 * Counts spike/crash frequency in a rolling 45-minute window (last 9 M5 bars)
 */
function getRollingSpikeCount(ltfCandles, mode, atr, windowBars = 9) {
  const startIdx = Math.max(0, ltfCandles.length - windowBars);
  let count = 0;
  for (let i = startIdx; i < ltfCandles.length; i++) {
    const c = ltfCandles[i];
    if (!c) continue;
    const isDirectionalSpike = mode === 'BOOM'
      ? (c.close > c.open && (c.high - c.low) >= (atr * 0.8))
      : (c.close < c.open && (c.high - c.low) >= (atr * 0.8));
    if (isDirectionalSpike) count++;
  }
  return count;
}

/**
 * Evaluates Market Structure for Strategy 6 (Triple Confluence)
 */
function evaluateStructureS6(htf1hCandles, htf4hCandles, dailyCandles, mode) {
  const requiredTrend = mode === 'BOOM' ? 'bearish' : 'bullish';
  if (!htf1hCandles || htf1hCandles.length < 55) {
    return { ready: false, isAligned: false };
  }

  // 1. 1H 50 EMA
  const htf1hCloses = htf1hCandles.map(c => c.close);
  const htf1hEMA = calculateEMA(htf1hCloses, 50);
  const last1hClose = htf1hCloses[htf1hCloses.length - 1];
  const last1hEma = htf1hEMA[htf1hEMA.length - 1];
  const htf1hTrend = last1hClose > last1hEma ? 'bullish' : 'bearish';
  const h1ClearancePct = last1hEma > 0 ? (Math.abs(last1hClose - last1hEma) / last1hEma) * 100 : 0;
  const chopOk = !config.USE_HTF_CHOP_FILTER || h1ClearancePct >= 0.08;

  // 2. 4H 50 EMA
  let htf4hTrend = 'N/A';
  if (htf4hCandles && htf4hCandles.length >= 55) {
    const htf4hCloses = htf4hCandles.map(c => c.close);
    const htf4hEMA = calculateEMA(htf4hCloses, 50);
    const last4hClose = htf4hCloses[htf4hCloses.length - 1];
    const last4hEma = htf4hEMA[htf4hEMA.length - 1];
    htf4hTrend = last4hClose > last4hEma ? 'bullish' : 'bearish';
  }

  // 3. Daily 50 EMA
  let dailyTrend = 'N/A';
  if (dailyCandles && dailyCandles.length >= 30) {
    const dailyCloses = dailyCandles.map(c => c.close);
    const dailyEMA = calculateEMA(dailyCloses, Math.min(50, dailyCloses.length - 1));
    if (dailyEMA.length > 0) {
      const lastDailyClose = dailyCloses[dailyCloses.length - 1];
      const lastDailyEma = dailyEMA[dailyEMA.length - 1];
      dailyTrend = lastDailyClose > lastDailyEma ? 'bullish' : 'bearish';
    }
  }

  const blockers = [];
  if (dailyTrend !== 'N/A' && config.REQUIRE_DAILY_CONFLUENCE && dailyTrend !== requiredTrend) {
    blockers.push(`1D ${dailyTrend}`);
  }
  if (htf4hTrend !== 'N/A' && htf4hTrend !== requiredTrend) {
    blockers.push(`4H ${htf4hTrend}`);
  }
  if (htf1hTrend !== requiredTrend) {
    blockers.push(`1H ${htf1hTrend}`);
  } else if (!chopOk) {
    blockers.push(`1H chop ${h1ClearancePct.toFixed(2)}% (min 0.08%)`);
  }

  return {
    ready: true,
    htf1hTrend,
    htf4hTrend,
    dailyTrend,
    h1ClearancePct,
    chopOk,
    isAligned: blockers.length === 0,
    blockers
  };
}

/**
 * 👑 STRATEGY 6 SIGNAL DETECTION ENGINE
 */
function detectStrategy6Setup(ltfCandles, htf1hCandles, htf4hCandles, dailyCandles, mode, minSpikesRequired, symbol) {
  if (!ltfCandles || !htf1hCandles || ltfCandles.length < 35 || htf1hCandles.length < 55) return null;

  const ms = evaluateStructureS6(htf1hCandles, htf4hCandles, dailyCandles, mode);
  if (!ms.ready || !ms.chopOk || !ms.isAligned) return null;

  const { htf1hTrend, htf4hTrend, dailyTrend, h1ClearancePct } = ms;
  const atr = calculateATR(ltfCandles, 14);
  if (!atr || atr === 0) return null;

  // ── CASE 1: SELL (BOOM) ──
  if (mode === 'BOOM') {
    // 1. Pullback Confirmation: Closed RED candles
    let confirmCandles = [];
    for (let cIdx = 0; cIdx < 2; cIdx++) {
      const c = ltfCandles[ltfCandles.length - 1 - cIdx];
      if (!c || c.close >= c.open) break;
      confirmCandles.push(c);
    }
    if (confirmCandles.length < 1) return null;

    const c0 = confirmCandles[0];
    const c0Range = c0.high - c0.low;
    const c0Body = Math.abs(c0.close - c0.open);
    const bodyRatio = c0Range > 0 ? (c0Body / c0Range) : 0;
    if (bodyRatio < 0.40) return null;

    // 2. Dynamic Spike Exhaustion (1 Monster Spike >=1.5x ATR or Cluster >=1.2x ATR)
    let activeConfirmCount = confirmCandles.length;
    let s0 = ltfCandles[ltfCandles.length - 1 - activeConfirmCount];

    if (!s0 || s0.close <= s0.open) {
      if (activeConfirmCount === 2) {
        activeConfirmCount = 1;
        confirmCandles = [confirmCandles[0]];
        s0 = ltfCandles[ltfCandles.length - 1 - activeConfirmCount];
      }
      if (!s0 || s0.close <= s0.open) return null;
    }

    const spikeCandles = [s0];
    const s0Range = s0.high - s0.low;

    for (let s = 1; s <= 2; s++) {
      const c = ltfCandles[ltfCandles.length - 1 - activeConfirmCount - s];
      if (c && c.close > c.open) {
        spikeCandles.push(c);
      } else {
        break;
      }
    }

    const currentSpikeStartIndex = ltfCandles.length - 1 - activeConfirmCount - (spikeCandles.length - 1);
    const spikePeak = Math.max(...confirmCandles.map(c => c.high), ...spikeCandles.map(c => c.high));
    const spikeClusterRange = Math.max(...spikeCandles.map(c => c.high)) - Math.min(...spikeCandles.map(c => c.low));

    const isSingleMonster = spikeCandles.length === 1 && s0Range >= (atr * 1.50);
    const isMultiCluster = spikeCandles.length >= 2 && spikeClusterRange >= (atr * (config.MIN_SPIKE_CLUSTER_ATR_RATIO || 1.20));
    if (!isSingleMonster && !isMultiCluster) return null;

    // Super-Monster check
    const isSuperMonster = s0Range >= (atr * 2.50) || spikeClusterRange >= (atr * 2.50);
    if (isSuperMonster && activeConfirmCount < 2) return null;

    // 5M 50 EMA Value Zone
    const ltfCloses = ltfCandles.map(c => c.close);
    const ltfEMA = calculateEMA(ltfCloses, 50);
    const lastLtfEma = ltfEMA && ltfEMA.length > 0 ? ltfEMA[ltfEMA.length - 1] : null;
    const maxAtrDist = (config.VALUE_ZONE_MAX_ATR_DIST || 2.5) * atr;
    if (lastLtfEma && (lastLtfEma - spikePeak) > maxAtrDist) return null;

    // Displacement recovery >= 20%
    const lastBoomSpike = spikeCandles[0];
    const lastSpikeRange = Math.abs(lastBoomSpike.close - lastBoomSpike.open);
    const totalRecoveryBody = confirmCandles.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0);
    if (totalRecoveryBody < (lastSpikeRange * 0.20)) return null;

    const entry = c0.close;
    const sl = spikePeak + (atr * 1.5);
    const slDist = sl - entry;
    if (slDist <= 0) return null;
    const tp = entry - (slDist * (config.REWARD_RATIO || 1.3));
    const candleEpoch = c0.epoch || c0.time;

    // ══════════════════════════════════════════════════════════════════════════
    // 👑 STRATEGY 6 GUARDS: THE INSTITUTIONAL EDGE
    // ══════════════════════════════════════════════════════════════════════════
    let isBlocked = false;
    let blockedReason = null;

    // 🛡️ GUARD 1: Micro-Structure Shift Check (CHoCH Armor)
    // On Boom SELL: Current Spike Peak must NOT be higher than Preceding Spike Peak
    const prevSpikePeak = findPrecedingSwingExtreme(ltfCandles, 'BOOM', currentSpikeStartIndex, atr);
    if (prevSpikePeak !== null && spikePeak > prevSpikePeak) {
      isBlocked = true;
      blockedReason = `Strategy 6 Structure Shield: Bullish CHoCH (Current Spike ${spikePeak.toFixed(2)} broke above Previous Peak ${prevSpikePeak.toFixed(2)})`;
    }

    // 🛡️ GUARD 2: Spike Density & Clustering Velocity Guard
    const recentSpikeCount = getRollingSpikeCount(ltfCandles, 'BOOM', atr, 9);
    if (!isBlocked && recentSpikeCount >= 3) {
      isBlocked = true;
      blockedReason = `Strategy 6 Velocity Shield: Spike Cluster detected (${recentSpikeCount} spikes in last 45m). Market in expansion`;
    }

    // 🛡️ GUARD 3: Dealing Range Equilibrium Corridor (35% Floor for Boom)
    const minSellS6 = 35.0; // tighter than 5B's 20%
    const maxBuyS6 = 80.0;
    const exhaustionS6 = evaluateMacroExhaustion(symbol, entry, 'SELL', htf1hCandles, minSellS6, maxBuyS6);
    if (!isBlocked && exhaustionS6.isExhausted) {
      isBlocked = true;
      blockedReason = `Strategy 6 Equilibrium Shield: ${exhaustionS6.reason}`;
    }

    // 🛡️ GUARD 4: Active 1H Bar Guard
    const current1hCandle = htf1hCandles && htf1hCandles.length > 0 ? htf1hCandles[htf1hCandles.length - 1] : null;
    if (!isBlocked && current1hCandle && current1hCandle.close > current1hCandle.open) {
      isBlocked = true;
      blockedReason = `Strategy 6 Bar Shield: Active 1H candle is Bullish (${current1hCandle.close.toFixed(2)} > ${current1hCandle.open.toFixed(2)})`;
    }

    return {
      strategy: 'Strategy 6',
      direction: 'SELL',
      type: 'bearish',
      htf4hTrend,
      htf1hTrend,
      dailyTrend,
      entry,
      sl,
      tp,
      slDist,
      atr,
      refPrice: spikePeak,
      h1ClearancePct,
      bodyRatio,
      valueZoneTouched: `Price Action Displacement (${activeConfirmCount}x 5M Recovery >=20%)`,
      candleEpoch,
      confirmCount: activeConfirmCount,
      spikeCountLabel: `${spikeCandles.length} Spikes (S6 Structure Validated)`,
      valuationLabel: `Macro Range: ${exhaustionS6.rangePct.toFixed(1)}% (S6 Corridor [${minSellS6}%-${maxBuyS6}%])`,
      liquidityLabel: prevSpikePeak ? `Structure Lower High (${spikePeak.toFixed(1)} <= ${prevSpikePeak.toFixed(1)})` : 'Clean Structure',
      isBlocked,
      blockedReason
    };
  }

  // ── CASE 2: BUY (CRASH) ──
  if (mode === 'CRASH') {
    // 1. Pullback Confirmation: Closed GREEN candles
    let confirmCandles = [];
    for (let cIdx = 0; cIdx < 2; cIdx++) {
      const c = ltfCandles[ltfCandles.length - 1 - cIdx];
      if (!c || c.close <= c.open) break;
      confirmCandles.push(c);
    }
    if (confirmCandles.length < 1) return null;

    const c0 = confirmCandles[0];
    const c0Range = c0.high - c0.low;
    const c0Body = Math.abs(c0.close - c0.open);
    const bodyRatio = c0Range > 0 ? (c0Body / c0Range) : 0;
    if (bodyRatio < 0.40) return null;

    // 2. Dynamic Crash Exhaustion
    let activeConfirmCount = confirmCandles.length;
    let s0 = ltfCandles[ltfCandles.length - 1 - activeConfirmCount];

    if (!s0 || s0.close >= s0.open) {
      if (activeConfirmCount === 2) {
        activeConfirmCount = 1;
        confirmCandles = [confirmCandles[0]];
        s0 = ltfCandles[ltfCandles.length - 1 - activeConfirmCount];
      }
      if (!s0 || s0.close >= s0.open) return null;
    }

    const crashCandles = [s0];
    const s0Range = s0.high - s0.low;

    for (let s = 1; s <= 2; s++) {
      const c = ltfCandles[ltfCandles.length - 1 - activeConfirmCount - s];
      if (c && c.close < c.open) {
        crashCandles.push(c);
      } else {
        break;
      }
    }

    const currentSpikeStartIndex = ltfCandles.length - 1 - activeConfirmCount - (crashCandles.length - 1);
    const crashTrough = Math.min(...confirmCandles.map(c => c.low), ...crashCandles.map(c => c.low));
    const crashClusterRange = Math.max(...crashCandles.map(c => c.high)) - Math.min(...crashCandles.map(c => c.low));

    const isSingleMonster = crashCandles.length === 1 && s0Range >= (atr * 1.50);
    const isMultiCluster = crashCandles.length >= 2 && crashClusterRange >= (atr * (config.MIN_SPIKE_CLUSTER_ATR_RATIO || 1.20));
    if (!isSingleMonster && !isMultiCluster) return null;

    const isSuperMonster = s0Range >= (atr * 2.50) || crashClusterRange >= (atr * 2.50);
    if (isSuperMonster && activeConfirmCount < 2) return null;

    // 5M 50 EMA Value Zone
    const ltfCloses = ltfCandles.map(c => c.close);
    const ltfEMA = calculateEMA(ltfCloses, 50);
    const lastLtfEma = ltfEMA && ltfEMA.length > 0 ? ltfEMA[ltfEMA.length - 1] : null;
    const maxAtrDist = (config.VALUE_ZONE_MAX_ATR_DIST || 2.5) * atr;
    if (lastLtfEma && (crashTrough - lastLtfEma) > maxAtrDist) return null;

    // Displacement recovery >= 20%
    const lastCrashSpike = crashCandles[0];
    const lastSpikeRange = Math.abs(lastCrashSpike.close - lastCrashSpike.open);
    const totalRecoveryBody = confirmCandles.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0);
    if (totalRecoveryBody < (lastSpikeRange * 0.20)) return null;

    const entry = c0.close;
    const sl = crashTrough - (atr * 1.5);
    const slDist = entry - sl;
    if (slDist <= 0) return null;
    const tp = entry + (slDist * (config.REWARD_RATIO || 1.3));
    const candleEpoch = c0.epoch || c0.time;

    // ══════════════════════════════════════════════════════════════════════════
    // 👑 STRATEGY 6 GUARDS: THE INSTITUTIONAL EDGE
    // ══════════════════════════════════════════════════════════════════════════
    let isBlocked = false;
    let blockedReason = null;

    // 🛡️ GUARD 1: Micro-Structure Shift Check (CHoCH Armor)
    // On Crash BUY: Current Crash Trough must NOT be lower than Preceding Crash Trough
    const prevCrashTrough = findPrecedingSwingExtreme(ltfCandles, 'CRASH', currentSpikeStartIndex, atr);
    if (prevCrashTrough !== null && crashTrough < prevCrashTrough) {
      isBlocked = true;
      blockedReason = `Strategy 6 Structure Shield: Bearish CHoCH (Current Crash ${crashTrough.toFixed(2)} broke below Previous Low ${prevCrashTrough.toFixed(2)})`;
    }

    // 🛡️ GUARD 2: Spike Density & Clustering Velocity Guard
    const recentCrashCount = getRollingSpikeCount(ltfCandles, 'CRASH', atr, 9);
    if (!isBlocked && recentCrashCount >= 3) {
      isBlocked = true;
      blockedReason = `Strategy 6 Velocity Shield: Crash Cluster detected (${recentCrashCount} crashes in last 45m). Market in cascade`;
    }

    // 🛡️ GUARD 3: Dealing Range Equilibrium Corridor (65% Ceiling for Crash)
    const minSellS6 = 20.0;
    const maxBuyS6 = 65.0; // tighter than 5B's 80%
    const exhaustionS6 = evaluateMacroExhaustion(symbol, entry, 'BUY', htf1hCandles, minSellS6, maxBuyS6);
    if (!isBlocked && exhaustionS6.isExhausted) {
      isBlocked = true;
      blockedReason = `Strategy 6 Equilibrium Shield: ${exhaustionS6.reason}`;
    }

    // 🛡️ GUARD 4: Active 1H Bar Guard
    const current1hCandle = htf1hCandles && htf1hCandles.length > 0 ? htf1hCandles[htf1hCandles.length - 1] : null;
    if (!isBlocked && current1hCandle && current1hCandle.close < current1hCandle.open) {
      isBlocked = true;
      blockedReason = `Strategy 6 Bar Shield: Active 1H candle is Bearish (${current1hCandle.close.toFixed(2)} < ${current1hCandle.open.toFixed(2)})`;
    }

    return {
      strategy: 'Strategy 6',
      direction: 'BUY',
      type: 'bullish',
      htf4hTrend,
      htf1hTrend,
      dailyTrend,
      entry,
      sl,
      tp,
      slDist,
      atr,
      refPrice: crashTrough,
      h1ClearancePct,
      bodyRatio,
      valueZoneTouched: `Price Action Displacement (${activeConfirmCount}x 5M Recovery >=20%)`,
      candleEpoch,
      confirmCount: activeConfirmCount,
      spikeCountLabel: `${crashCandles.length} Spikes (S6 Structure Validated)`,
      valuationLabel: `Macro Range: ${exhaustionS6.rangePct.toFixed(1)}% (S6 Corridor [${minSellS6}%-${maxBuyS6}%])`,
      liquidityLabel: prevCrashTrough ? `Structure Higher Low (${crashTrough.toFixed(1)} >= ${prevCrashTrough.toFixed(1)})` : 'Clean Structure',
      isBlocked,
      blockedReason
    };
  }

  return null;
}

module.exports = {
  detectStrategy6Setup,
  evaluateStructureS6,
  findPrecedingSwingExtreme,
  getRollingSpikeCount
};
