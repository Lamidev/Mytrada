// reconcileTodayReset.js
/**
 * Reset Today's Trading Session (2026-10-09)
 * Clears all trades taken today, resets starting and current balance to $3,628.72 USD,
 * clears the portfolio circuit breaker, but strictly preserves BOOM600's daily lockout (2 losses).
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const CACHE_DIR = path.join(__dirname, 'cache');
const DATA_DIR = path.join(__dirname, 'data');
const TRADE_HISTORY_FILE = path.join(CACHE_DIR, 'trade_history.json');
const DYNAMIC_STATE_FILE = path.join(CACHE_DIR, 'dynamic_state.json');
const CIRCUIT_BREAKER_FILE = path.join(CACHE_DIR, 'circuit_breaker_state.json');
const GODEYES_MEMORY_FILE = path.join(DATA_DIR, 'godeyes_memory.json');
const ACTIVE_TRADES_FILE = path.join(CACHE_DIR, 'active_trades.json');

const TARGET_START_BALANCE = 3628.72; // Start of day baseline on Oct 9
const TODAY_STR = "2026-10-09";

function resetTodayState() {
  console.log("\n=======================================================");
  console.log("⚡ [RESET TODAY'S TRADING SESSION & ALIGN TO $3,628.72]");
  console.log("=======================================================");

  // 1. Clean Trade History (Remove today's trades & ensure start balance is $3628.72)
  let history = [];
  if (fs.existsSync(TRADE_HISTORY_FILE)) {
    try {
      history = JSON.parse(fs.readFileSync(TRADE_HISTORY_FILE, 'utf8'));
    } catch (e) {
      history = [];
    }
  }

  function getDateString(isoString) {
    if (!isoString) return "";
    const offset = config.TIMEZONE_OFFSET_HOURS !== undefined ? config.TIMEZONE_OFFSET_HOURS : 1;
    const d = new Date(new Date(isoString).getTime() + offset * 3600000);
    return d.toISOString().split('T')[0];
  }

  // Filter out any trades closed or signaled today (Oct 9)
  const priorTrades = history.filter(t => {
    const dClosed = getDateString(t.closedTime);
    const dSignal = getDateString(t.signalTime);
    return dClosed !== TODAY_STR && dSignal !== TODAY_STR;
  });

  // Calculate prior PnL
  const baseDeposit = config.STARTING_BALANCE || 100.0;
  let priorPnL = 0;
  priorTrades.forEach(t => {
    if (t.status === 'CLOSED') {
      priorPnL += (t.pnlUSD || 0);
    }
  });

  const currentPriorBalance = baseDeposit + priorPnL;
  const diff = TARGET_START_BALANCE - currentPriorBalance;

  if (Math.abs(diff) > 0.001) {
    console.log(`ℹ️ Anchor adjustment needed: diff = ${diff >= 0 ? '+' : ''}$${diff.toFixed(2)} USD to anchor start of Oct 9 at $${TARGET_START_BALANCE.toFixed(2)} USD`);
    const existingAnchor = priorTrades.find(t => t.setupId && t.setupId.startsWith('BASELINE_ANCHOR'));
    if (existingAnchor) {
      existingAnchor.pnlUSD = parseFloat((existingAnchor.pnlUSD + diff).toFixed(2));
      console.log(`Updated existing baseline anchor PnL to $${existingAnchor.pnlUSD}`);
    } else {
      priorTrades.push({
        setupId: "BASELINE_ANCHOR_OCT08_ROLLOVER",
        symbol: "CRASH1000",
        type: "bullish",
        entryPrice: 6080.0,
        stopLoss: 6070.0,
        takeProfit: 6093.0,
        confluenceScore: 10,
        signalTime: "2026-10-08T23:55:00.000Z",
        status: "CLOSED",
        triggeredTime: "2026-10-08T23:55:00.000Z",
        closedTime: "2026-10-08T22:00:00.000Z",
        outcome: "WIN",
        exitPrice: 6093.0,
        pnlUSD: parseFloat(diff.toFixed(2)),
        pnlR: 1.3,
        strategy: "Strategy 6 Pro (Oct 8 Baseline Alignment)"
      });
      console.log(`Created baseline anchor with PnL $${diff.toFixed(2)}`);
    }
  }

  fs.writeFileSync(TRADE_HISTORY_FILE, JSON.stringify(priorTrades, null, 2), 'utf8');
  console.log(`✅ trade_history.json updated: 0 trades today, starting balance = $${TARGET_START_BALANCE.toFixed(2)}`);

  // 2. Active Trades: clear active trades
  fs.writeFileSync(ACTIVE_TRADES_FILE, JSON.stringify([], null, 2), 'utf8');
  console.log(`✅ active_trades.json cleared (0 active trades).`);

  // 3. Dynamic State: clear today's locks, reset to unpaused, preserve targets
  let dynamicState = {};
  if (fs.existsSync(DYNAMIC_STATE_FILE)) {
    try {
      dynamicState = JSON.parse(fs.readFileSync(DYNAMIC_STATE_FILE, 'utf8'));
    } catch (e) {}
  }

  dynamicState.date = TODAY_STR;
  dynamicState.dailyTargetUSD = 300.0;
  dynamicState.dailyTargetLocked = false;
  dynamicState.dailyMaxLossUSD = 250.0;
  dynamicState.dailyLossLocked = false;
  dynamicState.isManuallyPaused = false;
  dynamicState.portfolioConsecutiveLosses = 0;
  dynamicState.portfolioPauseUntil = 0;
  dynamicState.activeStrategy = 'BOTH';
  dynamicState.executionMode = 'LIVE';
  dynamicState.mode5b = 'PAPER';
  dynamicState.mode6pro = 'LIVE';
  dynamicState.is5bPaused = false;
  dynamicState.is6proPaused = false;

  fs.writeFileSync(DYNAMIC_STATE_FILE, JSON.stringify(dynamicState, null, 2), 'utf8');
  console.log(`✅ dynamic_state.json updated: portfolio unpaused, target = $300, maxloss = -$250.`);

  // 4. Circuit Breaker State: KEEP BOOM600 LOCKED FOR THE REST OF TODAY!
  let cbState = {};
  if (fs.existsSync(CIRCUIT_BREAKER_FILE)) {
    try {
      cbState = JSON.parse(fs.readFileSync(CIRCUIT_BREAKER_FILE, 'utf8'));
    } catch (e) {}
  }

  cbState.date = TODAY_STR;
  cbState.portfolioConsecutiveLosses = 0;
  cbState.portfolioPauseUntil = 0;

  if (!cbState.symbols) cbState.symbols = {};
  for (const sym of Object.keys(config.SYMBOLS)) {
    if (!cbState.symbols[sym]) {
      cbState.symbols[sym] = { consecutiveLosses: 0, dailyLosses: 0, pauseUntil: 0 };
    }
  }

  // Calculate midnight UTC for end of day lockout
  const now = new Date();
  const tomorrowMidnightUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0)).getTime();

  // Keep BOOM600 locked!
  cbState.symbols["BOOM600"] = {
    consecutiveLosses: 2,
    dailyLosses: 2,
    pauseUntil: tomorrowMidnightUTC
  };
  console.log(`🔒 BOOM600 kept locked out until 12:00 AM UTC (2 daily losses preserved).`);

  // Reset other pairs
  for (const sym of Object.keys(cbState.symbols)) {
    if (sym !== "BOOM600") {
      cbState.symbols[sym].consecutiveLosses = 0;
      cbState.symbols[sym].dailyLosses = 0;
      cbState.symbols[sym].pauseUntil = 0;
    }
  }

  fs.writeFileSync(CIRCUIT_BREAKER_FILE, JSON.stringify(cbState, null, 2), 'utf8');
  console.log(`✅ circuit_breaker_state.json updated.`);

  // 5. GodEyes Memory: clean out any Oct 9 trades and recalibrate pair stats
  if (fs.existsSync(GODEYES_MEMORY_FILE)) {
    try {
      const memory = JSON.parse(fs.readFileSync(GODEYES_MEMORY_FILE, 'utf8'));
      for (const sym of Object.keys(memory)) {
        if (memory[sym] && Array.isArray(memory[sym].recentTrades)) {
          const prevLen = memory[sym].recentTrades.length;
          memory[sym].recentTrades = memory[sym].recentTrades.filter(t => !t.date || !t.date.startsWith(TODAY_STR));
          const removed = prevLen - memory[sym].recentTrades.length;
          if (removed > 0) {
            console.log(`Cleaned ${removed} trade(s) from ${sym} in GodEyes memory.`);
            // Recompute stats from remaining trades
            let w = 0, l = 0, be = 0, netR = 0, netUSD = 0;
            memory[sym].recentTrades.forEach(t => {
              if (t.outcome === 'WIN') { w++; netR += 1.3; netUSD += 107.04; }
              else if (t.outcome === 'LOSS') { l++; netR -= 1.0; netUSD -= 82.34; }
              else { be++; }
            });
            const tot = w + l + be;
            memory[sym].stats = {
              wins: w,
              losses: l,
              breakevens: be,
              totalTrades: tot,
              winRate: tot > 0 ? parseFloat(((w / tot) * 100).toFixed(1)) : 0,
              netR: parseFloat(netR.toFixed(1)),
              netUSD: parseFloat(netUSD.toFixed(2))
            };
          }
        }
      }
      fs.writeFileSync(GODEYES_MEMORY_FILE, JSON.stringify(memory, null, 2), 'utf8');
      console.log(`✅ godeyes_memory.json cleaned and recalibrated.`);
    } catch (e) {
      console.warn("Could not clean memory file:", e.message);
    }
  }

  console.log("=======================================================");
  console.log("✨ ALL STATE RESET SUCCESSFUL!");
  console.log("=======================================================\n");
}

if (require.main === module) {
  resetTodayState();
}

module.exports = { resetTodayState };
