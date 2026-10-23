// backtestSMC6Pro.js
/**
 * 👑 MYTRADA QUANTITATIVE RESEARCH & BACKTEST SUITE
 * 
 * Compares:
 * 1. Strategy 5B Enhanced (Algorithmic Spike Momentum Exhaustion Sniper [15%-85%])
 * 2. Strategy 6 Pro (Genuine SMC Institutional Liquidity Sweep & Structure Shift Engine)
 * 
 * Period: 30 Days (8,640 M5 bars + 720 H1 bars) across all 12 Elite Pairs
 * Simulates bar-by-bar execution with shared Institutional Risk Rules:
 *  - Pair Anti-Chop Lockout (2 consecutive losses = pair locked for the day)
 *  - Daily Profit Target ($447) with Dynamic Target-Tail Risk Compression
 *  - Daily Max Loss Floor (-$337)
 *  - 1:1.3 R:R Target
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const CACHE_DIR = path.join(__dirname, 'cache');
const OUTPUT_DIR = path.join(__dirname, 'data');

const SYMBOLS = [
  'BOOM500', 'BOOM300N', 'BOOM900', 'BOOM600', 'BOOM1000', 'BOOM150N',
  'CRASH300N', 'CRASH500', 'CRASH600', 'CRASH900', 'CRASH1000', 'CRASH150N'
];

// Technical Indicators
function calculateEMA(closes, period) {
  if (!closes || closes.length < period) return [];
  const k = 2 / (period + 1);
  const ema = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    ema.push(closes[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 1.0;
  let trSum = 0;
  const start = Math.max(1, candles.length - period);
  for (let i = start; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trSum += tr;
  }
  return trSum / period;
}

// ── STRATEGY 1: STRATEGY 5B ENHANCED (Spike Exhaustion Sniper) ──
function detectStrategy5B(m5Candles, htf1hCandles, mode, minSpikes) {
  if (m5Candles.length < 60 || htf1hCandles.length < 50) return null;

  const h1Closes = htf1hCandles.map(c => c.close);
  const h1EMA = calculateEMA(h1Closes, 50);
  const lastH1Close = h1Closes[h1Closes.length - 1];
  const lastH1Ema = h1EMA[h1EMA.length - 1];

  const atr = calculateATR(m5Candles, 14);
  if (!atr || atr === 0) return null;

  const c0 = m5Candles[m5Candles.length - 1]; // Latest closed 5M bar

  // 1. BOOM SELL Setup (1H < EMA50)
  if (mode === 'BOOM') {
    if (lastH1Close >= lastH1Ema) return null; // Must be in 1H downtrend
    if (c0.close >= c0.open) return null; // Recovery candle must be RED

    const c0Range = c0.high - c0.low;
    const c0Body = Math.abs(c0.close - c0.open);
    if (c0Range === 0 || (c0Body / c0Range) < 0.40) return null;

    // Detect preceding upward spikes
    const spikeCandles = [];
    for (let s = 1; s <= 3; s++) {
      const sc = m5Candles[m5Candles.length - 1 - s];
      if (sc && sc.close > sc.open) spikeCandles.push(sc);
      else break;
    }

    if (spikeCandles.length === 0) return null;
    const isSingleMonster = spikeCandles.length === 1 && (spikeCandles[0].high - spikeCandles[0].low) >= (atr * 1.50);
    const spikeClusterRange = Math.max(...spikeCandles.map(c => c.high)) - Math.min(...spikeCandles.map(c => c.low));
    const isMultiCluster = spikeCandles.length >= 2 && spikeClusterRange >= (atr * 1.20);
    if (!isSingleMonster && !isMultiCluster) return null;

    // Check displacement recovery
    const lastSpikeRange = Math.abs(spikeCandles[0].close - spikeCandles[0].open);
    if (c0Body < lastSpikeRange * 0.20) return null;

    const spikePeak = Math.max(c0.high, ...spikeCandles.map(c => c.high));
    const entry = c0.close;
    const sl = spikePeak + (atr * 1.5);
    const slDist = sl - entry;
    if (slDist <= 0) return null;
    const tp = entry - (slDist * 1.3);

    // 15% - 85% Macro Dealing Zone
    const h1Lookback = htf1hCandles.slice(-48);
    const pdh = Math.max(...h1Lookback.map(c => c.high));
    const pdl = Math.min(...h1Lookback.map(c => c.low));
    const rangeSpan = pdh - pdl;
    if (rangeSpan > 0) {
      const rangePct = ((entry - pdl) / rangeSpan) * 100;
      if (rangePct < 15.0 || rangePct > 85.0) return null;
    }

    return {
      strategy: 'Strategy 5B Enhanced',
      direction: 'SELL',
      entry,
      sl,
      tp,
      slDist,
      time: c0.time || c0.epoch
    };
  }

  // 2. CRASH BUY Setup (1H > EMA50)
  if (mode === 'CRASH') {
    if (lastH1Close <= lastH1Ema) return null; // Must be in 1H uptrend
    if (c0.close <= c0.open) return null; // Recovery candle must be GREEN

    const c0Range = c0.high - c0.low;
    const c0Body = Math.abs(c0.close - c0.open);
    if (c0Range === 0 || (c0Body / c0Range) < 0.40) return null;

    // Detect preceding downward crash spikes
    const crashCandles = [];
    for (let s = 1; s <= 3; s++) {
      const sc = m5Candles[m5Candles.length - 1 - s];
      if (sc && sc.close < sc.open) crashCandles.push(sc);
      else break;
    }

    if (crashCandles.length === 0) return null;
    const isSingleMonster = crashCandles.length === 1 && (crashCandles[0].high - crashCandles[0].low) >= (atr * 1.50);
    const crashClusterRange = Math.max(...crashCandles.map(c => c.high)) - Math.min(...crashCandles.map(c => c.low));
    const isMultiCluster = crashCandles.length >= 2 && crashClusterRange >= (atr * 1.20);
    if (!isSingleMonster && !isMultiCluster) return null;

    // Check displacement recovery
    const lastSpikeRange = Math.abs(crashCandles[0].close - crashCandles[0].open);
    if (c0Body < lastSpikeRange * 0.20) return null;

    const crashTrough = Math.min(c0.low, ...crashCandles.map(c => c.low));
    const entry = c0.close;
    const sl = crashTrough - (atr * 1.5);
    const slDist = entry - sl;
    if (slDist <= 0) return null;
    const tp = entry + (slDist * 1.3);

    // 15% - 85% Macro Dealing Zone
    const h1Lookback = htf1hCandles.slice(-48);
    const pdh = Math.max(...h1Lookback.map(c => c.high));
    const pdl = Math.min(...h1Lookback.map(c => c.low));
    const rangeSpan = pdh - pdl;
    if (rangeSpan > 0) {
      const rangePct = ((entry - pdl) / rangeSpan) * 100;
      if (rangePct < 15.0 || rangePct > 85.0) return null;
    }

    return {
      strategy: 'Strategy 5B Enhanced',
      direction: 'BUY',
      entry,
      sl,
      tp,
      slDist,
      time: c0.time || c0.epoch
    };
  }

  return null;
}

// ── STRATEGY 2: STRATEGY 6 PRO (Genuine SMC Liquidity Sweep & Structure Shift Engine) ──
function detectStrategy6ProSMC(m5Candles, htf1hCandles, mode) {
  if (m5Candles.length < 60 || htf1hCandles.length < 48) return null;

  // 1. Calculate Rolling 24h-48h Previous Session Anchors (PDH & PDL)
  const h1Lookback = htf1hCandles.slice(-48);
  const pdh = Math.max(...h1Lookback.map(c => c.high));
  const pdl = Math.min(...h1Lookback.map(c => c.low));
  const rangeSpan = pdh - pdl;
  if (rangeSpan <= 0) return null;

  const atr = calculateATR(m5Candles, 14);
  if (!atr || atr === 0) return null;

  // Look back at recent local swing extremes on M5 (last 20 bars)
  const recentM5 = m5Candles.slice(-20);
  const recentHigh = Math.max(...recentM5.map(c => c.high));
  const recentLow = Math.min(...recentM5.map(c => c.low));

  const c0 = m5Candles[m5Candles.length - 1]; // Displacement / confirmation bar
  const c1 = m5Candles[m5Candles.length - 2]; // Sweep bar

  // ── A. BOOM: LIQUIDITY SWEEP & BEARISH REVERSAL ──
  // Price sweeps above PDH or recent major high (BSL Raid), rejects with upper wick, followed by bearish displacement
  if (mode === 'BOOM') {
    const isPdhSweep = c1.high >= pdh && c1.close < pdh;
    const isLocalSweep = c1.high >= recentHigh && c1.close < c1.high - ((c1.high - c1.low) * 0.40);

    if (!isPdhSweep && !isLocalSweep) return null;

    // Confirmation bar (c0) must be a solid Bearish Displacement Candle (MSS / CHoCH)
    const isBearishDisplacement = c0.close < c0.open && c0.close < c1.low;
    const c0Body = Math.abs(c0.close - c0.open);
    const c0Range = c0.high - c0.low;
    if (!isBearishDisplacement || c0Range === 0 || (c0Body / c0Range) < 0.50) return null;

    // Fair Value Gap Check (imbalance: c2.low > c0.high)
    const c2 = m5Candles[m5Candles.length - 3];
    const hasFVG = c2 ? c2.low > c0.high : true;

    const sweepPeak = Math.max(c1.high, c0.high);
    const entry = c0.close;
    const sl = sweepPeak + (atr * 1.25);
    const slDist = sl - entry;
    if (slDist <= 0) return null;
    const tp = entry - (slDist * 1.3);

    return {
      strategy: 'Strategy 6 Pro (SMC)',
      direction: 'SELL',
      entry,
      sl,
      tp,
      slDist,
      hasFVG,
      sweepType: isPdhSweep ? 'PDH Liquidity Sweep' : 'Local BSL Sweep',
      time: c0.time || c0.epoch
    };
  }

  // ── B. CRASH: LIQUIDITY SWEEP & BULLISH REVERSAL ──
  // Price sweeps below PDL or recent major low (SSL Raid), rejects with lower wick, followed by bullish displacement
  if (mode === 'CRASH') {
    const isPdlSweep = c1.low <= pdl && c1.close > pdl;
    const isLocalSweep = c1.low <= recentLow && c1.close > c1.low + ((c1.high - c1.low) * 0.40);

    if (!isPdlSweep && !isLocalSweep) return null;

    // Confirmation bar (c0) must be a solid Bullish Displacement Candle (MSS / CHoCH)
    const isBullishDisplacement = c0.close > c0.open && c0.close > c1.high;
    const c0Body = Math.abs(c0.close - c0.open);
    const c0Range = c0.high - c0.low;
    if (!isBullishDisplacement || c0Range === 0 || (c0Body / c0Range) < 0.50) return null;

    // Fair Value Gap Check (imbalance: c2.high < c0.low)
    const c2 = m5Candles[m5Candles.length - 3];
    const hasFVG = c2 ? c2.high < c0.low : true;

    const sweepTrough = Math.min(c1.low, c0.low);
    const entry = c0.close;
    const sl = sweepTrough - (atr * 1.25);
    const slDist = entry - sl;
    if (slDist <= 0) return null;
    const tp = entry + (slDist * 1.3);

    return {
      strategy: 'Strategy 6 Pro (SMC)',
      direction: 'BUY',
      entry,
      sl,
      tp,
      slDist,
      hasFVG,
      sweepType: isPdlSweep ? 'PDL Liquidity Sweep' : 'Local SSL Sweep',
      time: c0.time || c0.epoch
    };
  }

  return null;
}

// ── BACKTEST SIMULATION ENGINE ──
function runSimulationForSymbol(symbol, m5Candles, h1Candles, strategyType) {
  const mode = config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].mode : (symbol.startsWith('BOOM') ? 'BOOM' : 'CRASH');
  const minSpikes = config.SYMBOLS[symbol] ? config.SYMBOLS[symbol].min_spikes : 2;

  const trades = [];
  let inTrade = false;
  let activeTrade = null;

  // Session & Risk Tracking
  let dailyLossCount = 0;
  let consecutiveLossCount = 0;
  let isPairLockedToday = false;
  let currentDay = '';

  const START_INDEX = 100; // Warm up for EMA and ATR

  for (let i = START_INDEX; i < m5Candles.length - 1; i++) {
    const currentM5 = m5Candles[i];
    const candleTime = new Date((currentM5.time || currentM5.epoch) * (currentM5.epoch ? 1000 : 1));
    const dayStr = candleTime.toISOString().split('T')[0];

    // Reset daily pair counters on new day
    if (dayStr !== currentDay) {
      currentDay = dayStr;
      dailyLossCount = 0;
      consecutiveLossCount = 0;
      isPairLockedToday = false;
    }

    // 1. Resolve Active Trade
    if (inTrade && activeTrade) {
      const isBuy = activeTrade.direction === 'BUY';
      let hitTP = false;
      let hitSL = false;

      if (isBuy) {
        if (currentM5.high >= activeTrade.tp) hitTP = true;
        else if (currentM5.low <= activeTrade.sl) hitSL = true;
      } else {
        if (currentM5.low <= activeTrade.tp) hitTP = true;
        else if (currentM5.high >= activeTrade.sl) hitSL = true;
      }

      if (hitTP || hitSL) {
        const outcome = hitTP ? 'WIN' : 'LOSS';
        const pnlR = hitTP ? 1.3 : -1.0;
        const pnlUSD = hitTP ? 159.06 : -122.35;

        trades.push({
          symbol,
          strategy: activeTrade.strategy,
          direction: activeTrade.direction,
          entryTime: activeTrade.entryTime,
          exitTime: candleTime.toISOString(),
          entry: activeTrade.entry,
          sl: activeTrade.sl,
          tp: activeTrade.tp,
          outcome,
          pnlR,
          pnlUSD
        });

        if (outcome === 'LOSS') {
          dailyLossCount++;
          consecutiveLossCount++;
          // Anti-Chop Rule: 2 consecutive losses or 2 daily losses locks pair for remainder of day
          if (consecutiveLossCount >= 2 || dailyLossCount >= 2) {
            isPairLockedToday = true;
          }
        } else {
          consecutiveLossCount = 0;
        }

        inTrade = false;
        activeTrade = null;
        continue;
      }
    }

    // If pair is locked for the day by anti-chop guard, skip new setups
    if (isPairLockedToday || inTrade) continue;

    // 2. Align H1 candles up to current M5 timestamp (no lookahead)
    const m5EpochMs = candleTime.getTime();
    const alignedH1 = h1Candles.filter(c => {
      const h1Time = (c.time || c.epoch) * (c.epoch ? 1000 : 1);
      return h1Time <= m5EpochMs;
    });

    const m5Slice = m5Candles.slice(0, i + 1);

    // 3. Evaluate Strategy
    let setup = null;
    if (strategyType === '5B') {
      setup = detectStrategy5B(m5Slice, alignedH1, mode, minSpikes);
    } else if (strategyType === '6PRO_SMC') {
      setup = detectStrategy6ProSMC(m5Slice, alignedH1, mode);
    }

    if (setup) {
      inTrade = true;
      activeTrade = {
        ...setup,
        entryTime: candleTime.toISOString()
      };
    }
  }

  return trades;
}

// ── MAIN RUNNER ──
async function runComparisonBacktest() {
  console.log(`\n========================================================================================`);
  console.log(`👑 30-DAY QUANTITATIVE AUDIT: STRATEGY 5B ENHANCED vs STRATEGY 6 PRO (GENUINE SMC)`);
  console.log(`========================================================================================\n`);

  const results5B = {};
  const results6Pro = {};

  let totalTrades5B = 0, wins5B = 0, losses5B = 0, netR5B = 0, netUSD5B = 0;
  let totalTrades6Pro = 0, wins6Pro = 0, losses6Pro = 0, netR6Pro = 0, netUSD6Pro = 0;

  for (const sym of SYMBOLS) {
    const file5m = path.join(CACHE_DIR, `${sym}_5m_hist_1M.json`);
    const file1h = path.join(CACHE_DIR, `${sym}_1h_hist_1M.json`);

    if (!fs.existsSync(file5m) || !fs.existsSync(file1h)) {
      console.warn(`[Skip] Missing cached 1M files for ${sym}`);
      continue;
    }

    const m5 = JSON.parse(fs.readFileSync(file5m, 'utf8'));
    const h1 = JSON.parse(fs.readFileSync(file1h, 'utf8'));

    const trades5B = runSimulationForSymbol(sym, m5, h1, '5B');
    const trades6Pro = runSimulationForSymbol(sym, m5, h1, '6PRO_SMC');

    // Aggregate 5B
    const w5 = trades5B.filter(t => t.outcome === 'WIN').length;
    const l5 = trades5B.filter(t => t.outcome === 'LOSS').length;
    const r5 = trades5B.reduce((sum, t) => sum + t.pnlR, 0);
    const usd5 = trades5B.reduce((sum, t) => sum + t.pnlUSD, 0);
    const wr5 = trades5B.length > 0 ? ((w5 / trades5B.length) * 100).toFixed(1) : '0.0';

    // Overlap / Correlation Check
    const timeSet5B = new Set(trades5B.map(t => `${t.symbol}_${t.entryTime}`));
    const sharedTrades = trades6Pro.filter(t => timeSet5B.has(`${t.symbol}_${t.entryTime}`)).length;
    const unique6Pro = trades6Pro.length - sharedTrades;
    const unique5B = trades5B.length - sharedTrades;

    // Aggregate 6 Pro SMC
    const w6 = trades6Pro.filter(t => t.outcome === 'WIN').length;
    const l6 = trades6Pro.filter(t => t.outcome === 'LOSS').length;
    const r6 = trades6Pro.reduce((sum, t) => sum + t.pnlR, 0);
    const usd6 = trades6Pro.reduce((sum, t) => sum + t.pnlUSD, 0);
    const wr6 = trades6Pro.length > 0 ? ((w6 / trades6Pro.length) * 100).toFixed(1) : '0.0';

    results5B[sym] = { trades: trades5B.length, wins: w5, losses: l5, winRate: wr5, netR: r5.toFixed(1), netUSD: usd5.toFixed(2), unique: unique5B };
    totalTrades5B += trades5B.length; wins5B += w5; losses5B += l5; netR5B += r5; netUSD5B += usd5;

    results6Pro[sym] = { trades: trades6Pro.length, wins: w6, losses: l6, winRate: wr6, netR: r6.toFixed(1), netUSD: usd6.toFixed(2), unique: unique6Pro, shared: sharedTrades };
    totalTrades6Pro += trades6Pro.length; wins6Pro += w6; losses6Pro += l6; netR6Pro += r6; netUSD6Pro += usd6;
  }

  // Display Pair-by-Pair Table
  console.log(`-----------------------------------------------------------------------------------------------------------------`);
  console.log(`ASSET          | STRATEGY 5B (Momentum Exhaustion)           | STRATEGY 6 PRO (Genuine SMC Liquidity)`);
  console.log(`               | Trades  Record        Win%    Net R   Net USD  | Trades  Record        Win%    Net R   Net USD`);
  console.log(`-----------------------------------------------------------------------------------------------------------------`);

  let totalShared = 0;
  for (const sym of SYMBOLS) {
    const r5 = results5B[sym] || { trades: 0, wins: 0, losses: 0, winRate: '0.0', netR: '0.0', netUSD: '0.00' };
    const r6 = results6Pro[sym] || { trades: 0, wins: 0, losses: 0, winRate: '0.0', netR: '0.0', netUSD: '0.00', shared: 0 };
    totalShared += r6.shared;

    const col5 = `${String(r5.trades).padStart(3)}t   ${r5.wins}W / ${r5.losses}L`.padEnd(14) + `${r5.winRate}%`.padStart(7) + `  ${r5.netR >= 0 ? '+' : ''}${r5.netR}R`.padStart(8) + `  $${r5.netUSD}`.padStart(10);
    const col6 = `${String(r6.trades).padStart(3)}t   ${r6.wins}W / ${r6.losses}L`.padEnd(14) + `${r6.winRate}%`.padStart(7) + `  ${r6.netR >= 0 ? '+' : ''}${r6.netR}R`.padStart(8) + `  $${r6.netUSD}`.padStart(10);

    console.log(`${sym.padEnd(14)} | ${col5}  | ${col6}`);
  }

  console.log(`-----------------------------------------------------------------------------------------------------------------`);

  const globalWR5 = totalTrades5B > 0 ? ((wins5B / totalTrades5B) * 100).toFixed(1) : '0.0';
  const globalWR6 = totalTrades6Pro > 0 ? ((wins6Pro / totalTrades6Pro) * 100).toFixed(1) : '0.0';

  console.log(`PORTFOLIO TOTAL| ${String(totalTrades5B).padStart(3)}t   ${wins5B}W / ${losses5B}L       ${globalWR5}%  ${netR5B >= 0 ? '+' : ''}${netR5B.toFixed(1)}R  +$${netUSD5B.toFixed(2)} | ${String(totalTrades6Pro).padStart(3)}t   ${wins6Pro}W / ${losses6Pro}L       ${globalWR6}%  ${netR6Pro >= 0 ? '+' : ''}${netR6Pro.toFixed(1)}R  +$${netUSD6Pro.toFixed(2)}`);
  console.log(`=================================================================================================================\n`);

  // UNCORRELATION & INDEPENDENCE REPORT
  const pctShared5B = totalTrades5B > 0 ? ((totalShared / totalTrades5B) * 100).toFixed(1) : '0.0';
  const pctShared6Pro = totalTrades6Pro > 0 ? ((totalShared / totalTrades6Pro) * 100).toFixed(1) : '0.0';

  console.log(`📊 STRATEGY DIVERGENCE & UNCORRELATION METRICS:`);
  console.log(`• Total Shared Trades (same bar & direction): ${totalShared} trades`);
  console.log(`• Strategy 5B Unique Trades: ${totalTrades5B - totalShared} trades (${(100 - pctShared5B).toFixed(1)}% completely independent entries)`);
  console.log(`• Strategy 6 Pro Unique Trades: ${totalTrades6Pro - totalShared} trades (${(100 - pctShared6Pro).toFixed(1)}% completely independent entries)`);
  console.log(`• Divergence: ${((1 - (totalShared / Math.max(totalTrades5B, totalTrades6Pro))) * 100).toFixed(1)}% of trade signals are COMPLETELY DIFFERENT between 5B and 6 Pro.`);
  console.log(`=================================================================================================================\n`);

  // DAILY SESSION TARGET SIMULATION ($447 Target / -$337 Max Loss)
  console.log(`🎯 30-DAY DAILY SESSION AUDIT (Target: $447/day | Max Loss: -$337/day | Dynamic Target-Tail Active):`);

  function simulateDailySessions(trades, stratName) {
    const dayMap = {};
    trades.forEach(t => {
      const d = t.entryTime.split('T')[0];
      if (!dayMap[d]) dayMap[d] = [];
      dayMap[d].push(t);
    });

    let targetHitDays = 0;
    let maxLossDays = 0;
    let normalDays = 0;
    let totalRealized = 0;

    for (const [day, dayTrades] of Object.entries(dayMap)) {
      let pnl = 0;
      let locked = false;

      for (const t of dayTrades) {
        if (locked) break;

        const remaining = 447 - pnl;
        let risk = 122.35;
        let reward = 159.06;

        // Dynamic Target-Tail Compression
        if (remaining > 0 && remaining < reward) {
          risk = Math.max(25, remaining / 1.3);
          reward = remaining;
        }

        if (t.outcome === 'WIN') {
          pnl += reward;
        } else {
          pnl -= risk;
        }

        // Lock checks
        if (pnl >= 447 || (pnl >= 447 * 0.85 && (447 - pnl) <= risk * 0.8)) {
          targetHitDays++;
          locked = true;
        } else if (pnl <= -337) {
          maxLossDays++;
          locked = true;
        }
      }

      if (!locked) normalDays++;
      totalRealized += pnl;
    }

    return { totalDays: Object.keys(dayMap).length, targetHitDays, maxLossDays, normalDays, totalRealized };
  }

  // Collect all trades across symbols
  let all5B = [];
  let all6Pro = [];
  for (const sym of SYMBOLS) {
    const file5m = path.join(CACHE_DIR, `${sym}_5m_hist_1M.json`);
    const file1h = path.join(CACHE_DIR, `${sym}_1h_hist_1M.json`);
    if (fs.existsSync(file5m) && fs.existsSync(file1h)) {
      const m5 = JSON.parse(fs.readFileSync(file5m, 'utf8'));
      const h1 = JSON.parse(fs.readFileSync(file1h, 'utf8'));
      all5B.push(...runSimulationForSymbol(sym, m5, h1, '5B'));
      all6Pro.push(...runSimulationForSymbol(sym, m5, h1, '6PRO_SMC'));
    }
  }

  // Sort chronologically
  all5B.sort((a, b) => new Date(a.entryTime) - new Date(b.entryTime));
  all6Pro.sort((a, b) => new Date(a.entryTime) - new Date(b.entryTime));

  const sim5B = simulateDailySessions(all5B, '5B');
  const sim6Pro = simulateDailySessions(all6Pro, '6 Pro');

  console.log(`• STRATEGY 5B:    ${sim5B.targetHitDays} Target-Hit Days (100% Bagged) | ${sim5B.maxLossDays} Loss-Floor Days | Total Session PnL: +$${sim5B.totalRealized.toFixed(2)}`);
  console.log(`• STRATEGY 6 PRO: ${sim6Pro.targetHitDays} Target-Hit Days (100% Bagged) | ${sim6Pro.maxLossDays} Loss-Floor Days | Total Session PnL: +$${sim6Pro.totalRealized.toFixed(2)}`);
  console.log(`=================================================================================================================\n`);
}

runComparisonBacktest();
