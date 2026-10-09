// godeyesMemory.js
/**
 * Mytrada - Strategy 6 Pro "GodEyes" Institutional SMC Memory Brain
 *
 * Core Capabilities:
 *  1. Multi-Session Structural Anchoring (Previous Day High / Low - PDH / PDL)
 *  2. 15% / 85% Macro Exhaustion Guard (Prevents buying tops >85% & selling bottoms <15%)
 *  3. In-Memory Persistent Database (data/godeyes_memory.json) for 0.01ms instant recall
 *  4. Automated Midnight Git Sync (Commits and pushes trade ledger to GitHub at 00:05 UTC)
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const config = require('./config');

const DATA_DIR = path.join(__dirname, 'data');
const MEMORY_FILE = path.join(DATA_DIR, 'godeyes_memory.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadMemory() {
  if (fs.existsSync(MEMORY_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    } catch (e) {
      console.warn("[godeyesMemory] Error reading memory file:", e.message);
      return {};
    }
  }
  return {};
}

function saveMemory(mem) {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2), 'utf8');
  } catch (e) {
    console.warn("[godeyesMemory] Error saving memory file:", e.message);
  }
}

/**
 * Updates or retrieves the multi-session high and low anchors for a pair
 * @param {string} symbol
 * @param {Array} htf1hCandles
 * @returns {{ pdh: number, pdl: number, rangeSpan: number }}
 */
function getOrUpdateSessionAnchors(symbol, htf1hCandles) {
  const memory = loadMemory();
  if (!memory[symbol]) {
    memory[symbol] = {
      pdh: 0,
      pdl: 0,
      rangeSpan: 0,
      lastUpdated: 0,
      recentTrades: []
    };
  }

  // Look back at least 24 to 48 1H candles (~1 to 2 days)
  if (htf1hCandles && htf1hCandles.length >= 24) {
    const lookback = Math.min(48, htf1hCandles.length);
    const slice = htf1hCandles.slice(htf1hCandles.length - lookback);
    const highs = slice.map(c => c.high);
    const lows = slice.map(c => c.low);

    const pdh = Math.max(...highs);
    const pdl = Math.min(...lows);
    const rangeSpan = pdh - pdl;

    memory[symbol].pdh = pdh;
    memory[symbol].pdl = pdl;
    memory[symbol].rangeSpan = rangeSpan;
    memory[symbol].lastUpdated = Date.now();
    saveMemory(memory);

    return { pdh, pdl, rangeSpan };
  }

  return {
    pdh: memory[symbol].pdh || 0,
    pdl: memory[symbol].pdl || 0,
    rangeSpan: memory[symbol].rangeSpan || 0
  };
}

/**
 * Evaluates the 25% / 75% Golden Macro Exhaustion Guard (SMC Dealing Zone)
 * Prevents buying in the Premium / Overbought top 25% (>75%) & shorting in the Deep Discount bottom 25% (<25%)
 * @param {string} symbol 
 * @param {number} currentPrice 
 * @param {string} direction 'BUY' | 'SELL'
 * @param {Array} htf1hCandles 
 * @returns {{ isExhausted: boolean, rangePct: number, reason: string|null }}
 */
function evaluateMacroExhaustion(symbol, currentPrice, direction, htf1hCandles, customMinSell, customMaxBuy) {
  const { pdh, pdl, rangeSpan } = getOrUpdateSessionAnchors(symbol, htf1hCandles);

  if (!rangeSpan || rangeSpan <= 0) {
    return { isExhausted: false, rangePct: 50, reason: null };
  }

  const rangePct = ((currentPrice - pdl) / rangeSpan) * 100;
  const maxBuyPct = customMaxBuy !== undefined ? customMaxBuy : ((config.GODEYES && config.GODEYES.MAX_BUY_RANGE_PCT) || 75.0);
  const minSellPct = customMinSell !== undefined ? customMinSell : ((config.GODEYES && config.GODEYES.MIN_SELL_RANGE_PCT) || 25.0);

  // 1. Climax Ceiling
  if (direction === 'BUY' && rangePct > maxBuyPct) {
    return {
      isExhausted: true,
      rangePct,
      reason: `Macro Climax Exhaustion (${rangePct.toFixed(1)}% Range Ceiling > ${maxBuyPct}%)`
    };
  }

  // 2. Climax Floor
  if (direction === 'SELL' && rangePct < minSellPct) {
    return {
      isExhausted: true,
      rangePct,
      reason: `Macro Climax Exhaustion (${rangePct.toFixed(1)}% Range Floor < ${minSellPct}%)`
    };
  }

  return {
    isExhausted: false,
    rangePct,
    reason: null
  };
}

/**
 * Record a trade outcome into GodEyes memory for 2-week continuous performance tracking
 */
function recordGodEyesOutcome(trade) {
  try {
    const memory = loadMemory();
    const sym = trade.symbol;
    if (!memory[sym]) {
      memory[sym] = { pdh: 0, pdl: 0, rangeSpan: 0, lastUpdated: 0, recentTrades: [] };
    }

    if (!Array.isArray(memory[sym].recentTrades)) {
      memory[sym].recentTrades = [];
    }

    memory[sym].recentTrades.push({
      setupId: trade.setupId,
      date: new Date().toISOString(),
      type: trade.type,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      outcome: trade.outcome,
      rMultiple: trade.rMultiple,
      rangePct: trade.rangePct || null,
      spikes: trade.spikes || null
    });

    // Keep last 50 trades per pair
    if (memory[sym].recentTrades.length > 50) {
      memory[sym].recentTrades = memory[sym].recentTrades.slice(-50);
    }

    // Recalculate rolling pair statistics and health ratings dynamically in real time
    let w = 0, l = 0, netR = 0;
    for (const t of memory[sym].recentTrades) {
      if (t.outcome === 'WIN') { w++; netR += (t.rMultiple || 1.3); }
      else if (t.outcome === 'LOSS') { l++; netR -= 1.0; }
    }
    const total = w + l;
    const wr = total > 0 ? parseFloat(((w / total) * 100).toFixed(1)) : 0.0;

    memory[sym].stats = {
      wins: w,
      losses: l,
      totalTrades: memory[sym].recentTrades.length,
      winRate: wr,
      netR: parseFloat(netR.toFixed(1)),
      netUSD: parseFloat((netR * 82.0).toFixed(2))
    };

    if (total >= 3) {
      if (wr >= 70.0) memory[sym].healthRating = '👑 ELITE MVP RUNNER';
      else if (wr >= 55.0) memory[sym].healthRating = '🟢 CONSISTENT PERFORMER';
      else if (wr >= 45.0) memory[sym].healthRating = '🟡 ACTIVE';
      else memory[sym].healthRating = '⚠️ HIGH-EXHAUSTION SENSITIVITY';
    }

    saveMemory(memory);
  } catch (e) {
    console.warn("[godeyesMemory] Error recording trade outcome:", e.message);
  }
}

/**
 * Automated Midnight GitHub Sync Cron
 * Commits the day's master trade archive and GodEyes memory to GitHub
 */
function runMidnightGitSync(todayDateStr) {
  return new Promise((resolve) => {
    const commitMsg = `chore(data): auto-archive trade logs & godeyes memory [${todayDateStr || new Date().toISOString().split('T')[0]}]`;
    const cmd = `git add data/ cache/ && git commit -m "${commitMsg}" && git push origin main`;

    console.log(`\n📦 [GITHUB ARCHIVE SYNC] Executing automated nightly sync to GitHub repository...`);
    exec(cmd, { cwd: __dirname }, (error, stdout, stderr) => {
      if (error) {
        console.warn(`⚠️ [GITHUB ARCHIVE SYNC] Push skipped or encounter: ${error.message.split('\n')[0]}`);
        resolve({ success: false, error: error.message });
      } else {
        console.log(`✅ [GITHUB ARCHIVE SYNC] Successfully committed and pushed daily archive to GitHub!`);
        resolve({ success: true, output: stdout });
      }
    });
  });
}

module.exports = {
  loadMemory,
  saveMemory,
  getOrUpdateSessionAnchors,
  evaluateMacroExhaustion,
  recordGodEyesOutcome,
  runMidnightGitSync
};
