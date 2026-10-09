// telegramBot.js
/**
 * Interactive Telegram Remote Control & Inbound Command Engine for Mytrada
 * Provides bidirectional communication with the operator via Telegram.
 *
 * Supported Commands:
 *  - /status         : Live Equity, Today PnL, Target status, Cooldowns
 *  - /trades         : Live Active Positions, Entry, TP, SL, Floating distance
 *  - /target <amt>   : Set/Update dynamic daily profit target (e.g. /target 250, /target off)
 *  - /lock           : Lock in today's current profit and stop trading until midnight
 *  - /pause          : Manually pause trading (sticky pause until /resume)
 *  - /resume         : Clear pause and daily lock, resume trading immediately
 *  - /risk <pct>     : Dynamically adjust risk percentage per trade (e.g. /risk 1.5)
 *  - /cooldown <sym> : Set manual cooldown for a pair (e.g. /cooldown BOOM300N 60)
 *  - /be             : Move Stop Loss on all open positions to Breakeven
 *  - /help           : Show available commands
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const config = require('./config');

const GOLD_STATE_FILE = path.join(__dirname, 'cache', 'gold_state.json');
const GOLD_TRADES_FILE = path.join(__dirname, 'cache', 'gold_active_trades.json');

function getGoldState() {
  if (fs.existsSync(GOLD_STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(GOLD_STATE_FILE, 'utf8'));
    } catch (e) {}
  }
  return { mode: 'PAPER', isPaused: false };
}

function setGoldState(state) {
  try {
    fs.writeFileSync(GOLD_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {}
}

function getGoldTrades() {
  if (fs.existsSync(GOLD_TRADES_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(GOLD_TRADES_FILE, 'utf8'));
    } catch (e) {}
  }
  return [];
}

let isPolling = false;
let lastUpdateId = 0;

/**
 * Dispatches an outbound HTML message to the configured Telegram Chat
 */
function sendTelegramMessage(text) {
  return new Promise((resolve) => {
    const botToken = config.TELEGRAM && config.TELEGRAM.BOT_TOKEN;
    const chatId   = config.TELEGRAM && config.TELEGRAM.CHAT_ID;

    if (!botToken || !chatId) {
      return resolve(false);
    }

    const payload = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });

    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(true);
        else resolve(false);
      });
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(payload);
    req.end();
  });
}

/**
 * Fetch incoming updates from Telegram API via Long-Polling
 */
function fetchUpdates(offset = 0) {
  return new Promise((resolve) => {
    const botToken = config.TELEGRAM && config.TELEGRAM.BOT_TOKEN;
    if (!botToken) return resolve([]);

    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${botToken}/getUpdates?offset=${offset}&timeout=20`,
      method: 'GET',
      timeout: 30000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            if (parsed.ok && Array.isArray(parsed.result)) {
              return resolve(parsed.result);
            }
          } catch (e) {}
        }
        resolve([]);
      });
    });

    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.end();
  });
}

/**
 * Registers native slash commands menu in Telegram UI
 */
function registerTelegramCommands() {
  const botToken = config.TELEGRAM && config.TELEGRAM.BOT_TOKEN;
  if (!botToken) return;

  const commands = [
    { command: 'status', description: "Live equity, today's P&L, active engines & state" },
    { command: 'memory', description: "GodEyes Institutional SMC Memory Brain & Macro Anchors" },
    { command: 'strategy', description: "Strategy switch: /strategy 6pro | 5b | both | none" },
    { command: 'mode', description: "Execution mode: /mode paper | live" },
    { command: 'gold', description: "Gold Scalper status, forward-test & controls" },
    { command: 'trades', description: "Live active positions & distance to TP/SL" },
    { command: 'report', description: "Daily performance summary report" },
    { command: 'target', description: "Set daily target: /target 250 (or /target off)" },
    { command: 'maxloss', description: "Set max loss floor: /maxloss 150 (or /maxloss off)" },
    { command: 'pause', description: "Pause scanning: /pause | /pause 5b | /pause 6pro | /pause gold" },
    { command: 'stopall', description: "Halt all engines: /stopall (stops 5b, 6pro, gold, live & paper)" },
    { command: 'resumeall', description: "Resume all engines: /resumeall (resumes 5b, 6pro, gold)" },
    { command: 'resume', description: "Resume scanning: /resume | /resume 5b | /resume 6pro | /resume gold" },
    { command: 'closeall', description: "Emergency exit: Close all open positions at market" },
    { command: 'help', description: "Show clean command control center" }
  ];

  const payload = JSON.stringify({ commands });
  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${botToken}/setMyCommands`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: 10000
  };

  const req = https.request(options, () => {});
  req.on('error', () => {});
  req.write(payload);
  req.end();
}

/**
 * Starts the inbound Telegram command listener
 * @param {Object} handlers Callbacks providing access to runner state
 */
async function startTelegramListener(handlers) {
  const botToken = config.TELEGRAM && config.TELEGRAM.BOT_TOKEN;
  const targetChatId = config.TELEGRAM && config.TELEGRAM.CHAT_ID;

  if (!botToken || !targetChatId) {
    console.warn("[telegramBot] Telegram credentials not configured. Inbound listener inactive.");
    return;
  }

  if (isPolling) return;
  isPolling = true;
  console.log(`📱 [telegramBot] Interactive Telegram Remote Control Listener active.`);

  // Auto-register slash commands menu with Telegram API
  try {
    registerTelegramCommands();
  } catch (e) {}

  // Drain old updates so we don't process stale past messages on restart
  try {
    const initialUpdates = await fetchUpdates(-1);
    if (initialUpdates.length > 0) {
      lastUpdateId = initialUpdates[initialUpdates.length - 1].update_id + 1;
    }
  } catch (e) {}

  while (isPolling) {
    try {
      const updates = await fetchUpdates(lastUpdateId);
      for (const update of updates) {
        lastUpdateId = update.update_id + 1;

        if (!update.message || !update.message.text) continue;

        const chatId = update.message.chat.id.toString();
        // Restrict strictly to authorized operator chat ID
        if (chatId !== targetChatId.toString()) {
          console.warn(`[telegramBot] Unauthorized access attempt from Chat ID: ${chatId}`);
          continue;
        }

        const rawText = update.message.text.trim();
        await handleCommand(rawText, handlers);
      }
    } catch (err) {
      // Quiet recovery from temporary connection drops
    }

    // Brief throttle before next poll
    await new Promise(r => setTimeout(r, 1000));
  }
}

/**
 * Parses and handles commands from the operator
 */
async function handleCommand(rawText, handlers) {
  const parts = rawText.split(/\s+/);
  const command = parts[0].toLowerCase().split('@')[0]; // strip bot username if any
  const arg1 = parts[1];
  const arg2 = parts[2];

  switch (command) {
    case '':
    case '/':
    case '/menu':
    case '/commands':
    case '/start':
    case '/help': {
      const helpMsg = [
        `👑 <b>[MYTRADA CONTROL CENTER]</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `📊 <b>MONITORING:</b>`,
        `• <code>/status</code> ➜ Balance, today's PnL, active engines & locks`,
        `• <code>/memory</code> ➜ GodEyes Neural Memory Brain & Macro Anchors`,
        `• <code>/health</code> ➜ Multi-pair health scorecard & quarantine status`,
        `• <code>/trades</code> ➜ Live open trades & distance to TP/SL`,
        `• <code>/gold</code> ➜ Gold Flash Scalper status & positions`,
        `• <code>/report</code> ➜ Today's performance report`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `🏛️ <b>STRATEGY & MODES:</b>`,
        `• <code>/strategy 6pro</code> ➜ Launch Strategy 6 Pro Live (Institutional SMC)`,
        `• <code>/strategy 5b</code> ➜ Launch Strategy 5B Live`,
        `• <code>/strategy both</code> ➜ Launch Dual Engine (6 Pro Live + 5B Paper)`,
        `• <code>/strategy none</code> ➜ Put bot into Standby (0 entries)`,
        `• <code>/mode paper</code> | <code>/mode live</code> ➜ Global execution mode`,
        `• <code>/mode gold paper</code> | <code>/mode gold live</code> ➜ Gold mode`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `🛡️ <b>RISK, QUARANTINE & GRADUATION:</b>`,
        `• <code>/target 250</code> ➜ Auto-close all & lock profit at +$250 (or <code>/target off</code>)`,
        `• <code>/maxloss 150</code> ➜ Auto-close all & stop loss floor at -$150 (or <code>/maxloss off</code>)`,
        `• <code>/promote CRASH150N</code> ➜ Graduate incubation pair to Live Trading`,
        `• <code>/demote CRASH150N</code> ➜ Demote pair back to Incubation Sandbox`,
        `• <code>/quarantine BOOM300N</code> ➜ Move pair to Paper Mode ($0 risk)`,
        `• <code>/unquarantine BOOM300N</code> ➜ Restore pair to Live Trading`,
        `• <code>/be</code> ➜ Move SL on open trades to Breakeven ($0 risk)`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `⚡ <b>CONTROL & EMERGENCY:</b>`,
        `• <code>/stopall</code> (or <code>/halt</code>, <code>/pause</code>) ➜ Emergency complete halt: stops all strategies (Live & Paper) & Gold`,
        `• <code>/resumeall</code> (or <code>/resume</code>) ➜ Resume all strategy engines and scanners`,
        `• <code>/resume CRASH600</code> (or <code>/unpause CRASH600</code>) ➜ Unlock paused/cooldown pair`,
        `• <code>/pause 5b</code> | <code>/pause 6pro</code> | <code>/pause gold</code> ➜ Pause specific engine`,
        `• <code>/resume 5b</code> | <code>/resume 6pro</code> | <code>/resume gold</code> ➜ Resume specific engine`,
        `• <code>/closeall</code> ➜ Close all active trades immediately at market`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`
      ].join('\n');
      await sendTelegramMessage(helpMsg);
      break;
    }

    case '/strategy':
    case '/strat': {
      if (!arg1) {
        const cur = handlers.getActiveStrategy ? handlers.getActiveStrategy() : 'BOTH';
        let label = '⚡ <b>DUAL ENGINE (6 Pro Live + 5B Paper Sandbox)</b>';
        if (cur === 'STRATEGY_6_PRO') label = '👑 <b>Strategy 6 Pro Only (Institutional SMC Sniper)</b>';
        else if (cur === 'STRATEGY_5B') label = '🚀 <b>Strategy 5B Only (Value-Zone Momentum Sniper)</b>';

        await sendTelegramMessage([
          `🏛️ <b>[MYTRADA ACTIVE STRATEGY ENGINE]</b>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `• <b>Current Configuration:</b> ${label}`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `👑 <b>Strategy 6 Pro:</b> 4H+1H Trend + Dealing Range + 5M Sweeps (~3-6 trades/day, 70% WR)`,
          `🚀 <b>Strategy 5B:</b> Value-Zone Spike Exhaustion Sniper (~10-15 trades/day)`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `💡 <b>Commands:</b>`,
          `• <code>/strategy both</code> — Run BOTH (6 Pro Live + 5B Paper Sandbox)`,
          `• <code>/strategy 6pro</code> — Run Strategy 6 Pro exclusively`,
          `• <code>/strategy 5b</code> — Run Strategy 5B Enhanced exclusively`
        ].join('\n'));
        break;
      }
      const choice = arg1.toLowerCase();
      if (choice.includes('both') || choice.includes('all') || choice.includes('dual')) {
        if (handlers.setActiveStrategy) handlers.setActiveStrategy('BOTH');
        await sendTelegramMessage([
          `⚡ <b>[DUAL STRATEGY ENGINE ACTIVATED]</b>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `• 👑 <b>Strategy 6 Pro:</b> <b>LIVE REAL TRADING</b> (Account Equity)`,
          `• 🔬 <b>Strategy 5B:</b> <b>PAPER FORWARD TEST</b> ($0 Risk Sandbox)`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `<i>Both engines are actively scanning in parallel. Control each anytime with /pause 5b or /pause 6pro.</i>`
        ].join('\n'));
      } else if (choice.includes('6') || choice.includes('pro') || choice.includes('smc')) {
        if (handlers.setActiveStrategy) handlers.setActiveStrategy('STRATEGY_6_PRO');
        await sendTelegramMessage(`👑 <b>[STRATEGY SWITCHED ➔ STRATEGY 6 PRO]</b>\nBot is now scanning exclusively with <b>Institutional SMC Liquidity & Valuation Sniper</b>.`);
      } else if (choice.includes('5') || choice.includes('5b')) {
        if (handlers.setActiveStrategy) handlers.setActiveStrategy('STRATEGY_5B');
        await sendTelegramMessage(`🚀 <b>[STRATEGY SWITCHED ➔ STRATEGY 5B ENHANCED]</b>\nBot is now scanning exclusively with <b>Strategy 5B Enhanced</b>.`);
      } else if (choice.includes('none') || choice.includes('off') || choice.includes('standby')) {
        if (handlers.setActiveStrategy) handlers.setActiveStrategy('NONE');
        await sendTelegramMessage(`🟡 <b>[MYTRADA ENGINE IN STANDBY]</b>\nMarket scanning halted. Bot is awaiting your /strategy command.`);
      } else {
        await sendTelegramMessage(`⚠️ Unknown strategy option. Use <code>/strategy both</code>, <code>/strategy 6pro</code>, <code>/strategy 5b</code>, or <code>/strategy none</code>.`);
      }
      break;
    }

    case '/mode': {
      if (!arg1) {
        const curStrat = handlers.getActiveStrategy ? handlers.getActiveStrategy() : 'BOTH';
        const curMode = handlers.getExecutionMode ? handlers.getExecutionMode() : 'PAPER';
        const gState = getGoldState();
        await sendTelegramMessage([
          `🧪 <b>[MYTRADA EXECUTION MODES]</b>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `• <b>Boom/Crash Strategy:</b> <code>${curStrat}</code>`,
          `• <b>Boom/Crash Mode:</b> <code>${curMode}</code>`,
          `• <b>Gold Scalper Mode:</b> <code>${gState.mode || 'PAPER'} (${gState.isPaused ? '⏸️ PAUSED' : '🟢 ACTIVE'})</code>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `💡 <b>Commands:</b>`,
          `• <code>/mode paper</code> — Global Boom/Crash Paper Sandbox ($0 risk)`,
          `• <code>/mode live</code> — Global Boom/Crash Live Real Trading`,
          `• <code>/mode 5b live</code> | <code>/mode 5b paper</code>`,
          `• <code>/mode 6pro live</code> | <code>/mode 6pro paper</code>`,
          `• <code>/mode gold paper</code> | <code>/mode gold live</code>`
        ].join('\n'));
        break;
      }
      const mChoice = arg1.toLowerCase();
      const mTarget = arg2 ? arg2.toLowerCase() : null;

      if (mChoice.includes('gold') && mTarget) {
        const isPaper = mTarget.includes('paper') || mTarget.includes('test');
        const gState = getGoldState();
        gState.mode = isPaper ? 'PAPER' : 'LIVE';
        setGoldState(gState);
        await sendTelegramMessage(`🥇 <b>Gold Scalper Mode updated to:</b> <code>${isPaper ? '🔬 PAPER FORWARD TEST ($0 Risk)' : '🟢 LIVE REAL TRADING'}</code>`);
      } else if (mChoice.includes('5b') && mTarget) {
        const isPaper = mTarget.includes('paper') || mTarget.includes('test');
        if (handlers.setStrategyMode) {
          handlers.setStrategyMode('5b', isPaper ? 'PAPER' : 'LIVE');
          if (!isPaper) handlers.setStrategyMode('6pro', 'PAPER');
        }
        const extraNote = !isPaper ? '\n👑 <i>Strategy 6 Pro automatically flipped to 🔬 PAPER SANDBOX</i>' : '';
        await sendTelegramMessage(`🚀 <b>Strategy 5B Mode updated to:</b> <code>${isPaper ? '🔬 PAPER SANDBOX ($0 Risk)' : '🟢 LIVE REAL TRADING'}</code>${extraNote}`);
      } else if (mChoice.includes('6') && mTarget) {
        const isPaper = mTarget.includes('paper') || mTarget.includes('test');
        if (handlers.setStrategyMode) {
          handlers.setStrategyMode('6pro', isPaper ? 'PAPER' : 'LIVE');
          if (!isPaper) handlers.setStrategyMode('5b', 'PAPER');
        }
        const extraNote = !isPaper ? '\n🚀 <i>Strategy 5B automatically flipped to 🔬 PAPER SANDBOX</i>' : '';
        await sendTelegramMessage(`👑 <b>Strategy 6 Pro Mode updated to:</b> <code>${isPaper ? '🔬 PAPER SANDBOX ($0 Risk)' : '🟢 LIVE REAL TRADING'}</code>${extraNote}`);
      } else if (mChoice.includes('paper') || mChoice.includes('test') || mChoice.includes('sandbox')) {
        if (handlers.setExecutionMode) handlers.setExecutionMode('PAPER');
        await sendTelegramMessage(`🔬 <b>[GLOBAL MODE ➔ PAPER SANDBOX]</b>\nAll signals across all strategies will now run as <b>Forward Test Setups ($0 real equity at risk)</b>.`);
      } else if (mChoice.includes('live') || mChoice.includes('real')) {
        if (handlers.setExecutionMode) handlers.setExecutionMode('LIVE');
        await sendTelegramMessage(`🟢 <b>[GLOBAL MODE ➔ LIVE REAL TRADING]</b>\nSignals will now execute with <b>Real Live Account Equity</b>.`);
      } else {
        await sendTelegramMessage(`⚠️ Unknown mode command. Use <code>/mode paper</code>, <code>/mode live</code>, <code>/mode 5b live</code>, <code>/mode 6pro paper</code>, or <code>/mode gold paper</code>.`);
      }
      break;
    }

    case '/gold':
    case '/xauusd': {
      const gState = getGoldState();
      const gTrades = getGoldTrades();
      const isPaper = gState.mode === 'PAPER';
      const statusBadge = gState.isPaused ? '⏸️ <b>PAUSED</b>' : '🟢 <b>SCANNING (M1 Liquidity Engine)</b>';

      await sendTelegramMessage([
        `🥇 <b>[MYTRADA GOLD FLASH SCALPER MONITOR]</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `• <b>Asset:</b> <code>Gold / USD (frxXAUUSD)</code>`,
        `• <b>Timeframe:</b> <code>1-Minute (M1 Flash Scalp)</code>`,
        `• <b>Engine State:</b> ${statusBadge}`,
        `• <b>Execution Mode:</b> <code>${isPaper ? '🔬 Paper Forward Test ($0 Risk)' : '🟢 Live Real Trading'}</code>`,
        `• <b>Active Positions:</b> <code>${gTrades.length} Trade(s) Open</code>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `💡 <b>Commands:</b>`,
        `• <code>/pause gold</code> — Pause Gold Scalper scanning`,
        `• <code>/resume gold</code> — Resume Gold Scalper scanning`,
        `• <code>/mode gold paper</code> — Forward Test Gold ($0 Risk)`,
        `• <code>/mode gold live</code> — Live Real Trading on Gold`
      ].join('\n'));
      break;
    }

    case '/report': {
      if (handlers.getDailyReport) {
        const reportHtml = handlers.getDailyReport(arg1);
        await sendTelegramMessage(reportHtml);
      }
      break;
    }

    case '/memory':
    case '/godeyes': {
      const { loadMemory } = require('./godeyesMemory');
      const memory = loadMemory();
      const pairs = Object.keys(memory);

      const lines = [
        `🧠 <b>[MYTRADA GODEYES NEURAL MEMORY LEDGER]</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `• <b>Cognitive Status:</b> 🟢 <b>ACTIVE & STREAMING</b>`,
        `• <b>Exhaustion Armor:</b> <code>15% Floor / 85% Ceiling</code>`,
        `• <b>Tracked Assets in Brain:</b> <code>${pairs.length} Elite Pairs</code>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `📊 <b>MULTI-SESSION PAIR INTELLIGENCE (8-DAY):</b>`
      ];

      for (const sym of pairs) {
        const p = memory[sym];
        const s = p.stats || { wins: 0, losses: 0, winRate: 0, netR: 0 };
        const rating = p.healthRating || 'ACTIVE';
        lines.push(`• <b>${sym}</b> [${rating}]`);
        lines.push(`  ├ <b>8-Day Record:</b> <code>${s.wins}W / ${s.losses}L (${s.winRate}% WR • +${s.netR}R)</code>`);
        lines.push(`  └ <b>Macro Range:</b> <code>${(p.pdl || 0).toFixed(2)} ➔ ${(p.pdh || 0).toFixed(2)} (${(p.rangeSpan || 0).toFixed(2)} pts)</code>`);
      }

      lines.push(`<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`);
      lines.push(`🛡️ <i>Guards: Climax Reversal Traps Auto-Blocked in 6 Pro Sandbox.</i>`);
      lines.push(`📦 <i>Cloud Sync: Automated GitHub push at 00:05 UTC.</i>`);

      await sendTelegramMessage(lines.join('\n'));
      break;
    }

    case '/status': {
      if (handlers.getStatus) {
        const statusHtml = await handlers.getStatus();
        await sendTelegramMessage(statusHtml);
      }
      break;
    }

    case '/trades':
    case '/positions': {
      if (handlers.getActiveTrades) {
        const tradesHtml = await handlers.getActiveTrades();
        await sendTelegramMessage(tradesHtml);
      }
      break;
    }

    case '/target': {
      if (!arg1) {
        const currentTarget = handlers.getDailyTarget ? handlers.getDailyTarget() : 0;
        await sendTelegramMessage(`🎯 Current Daily Profit Target: <b>${currentTarget > 0 ? `$${currentTarget.toFixed(2)} USD` : 'Disabled (Full Session)'}</b>\n\nUsage: <code>/target 250</code> or <code>/target off</code>`);
        break;
      }

      if (arg1.toLowerCase() === 'off' || arg1 === '0') {
        if (handlers.setDailyTarget) handlers.setDailyTarget(0);
        await sendTelegramMessage(`🎯 <b>Daily Profit Target Disabled.</b> Bot will scan for full session without daily cap.`);
      } else {
        const val = parseFloat(arg1);
        if (isNaN(val) || val <= 0) {
          await sendTelegramMessage(`⚠️ Invalid target amount. Example: <code>/target 300</code>`);
        } else {
          if (handlers.setDailyTarget) {
            const res = await handlers.setDailyTarget(val);
            if (res && res.alreadyHit) {
              await sendTelegramMessage(`🎯 <b>Daily Profit Target set to $${val.toFixed(2)} USD.</b>\n\n🚨 <b>Target already exceeded today (+$${res.todayNet.toFixed(2)} USD)!</b> Closed all active positions and locked in profits for the day.`);
            } else {
              await sendTelegramMessage(`🎯 <b>Daily Profit Target updated to:</b> <code>+$${val.toFixed(2)} USD</code>\nTrading will automatically lock when today's profit reaches this amount.`);
            }
          }
        }
      }
      break;
    }

    case '/maxloss':
    case '/losslimit': {
      if (!arg1) {
        const currentLoss = handlers.getDailyMaxLoss ? handlers.getDailyMaxLoss() : 0;
        await sendTelegramMessage(`🛡️ Current Daily Max Loss Floor: <b>${currentLoss > 0 ? `-$${currentLoss.toFixed(2)} USD` : 'Disabled (No Floor)'}</b>\n\nUsage: <code>/maxloss 200</code> or <code>/maxloss off</code>`);
        break;
      }

      if (arg1.toLowerCase() === 'off' || arg1 === '0') {
        if (handlers.setDailyMaxLoss) handlers.setDailyMaxLoss(0);
        await sendTelegramMessage(`🛡️ <b>Daily Max Loss Floor Disabled.</b> Bot will trade without a daily loss shutdown.`);
      } else {
        const val = parseFloat(arg1);
        if (isNaN(val) || val <= 0) {
          await sendTelegramMessage(`⚠️ Invalid loss amount. Example: <code>/maxloss 200</code> or <code>/maxloss off</code>`);
        } else {
          if (handlers.setDailyMaxLoss) {
            const res = await handlers.setDailyMaxLoss(val);
            if (res && res.alreadyHit) {
              await sendTelegramMessage(`🛡️ <b>Daily Max Loss Floor set to -$${val.toFixed(2)} USD.</b>\n\n🚨 <b>Floor already breached today (Net: -$${Math.abs(res.todayNet).toFixed(2)} USD)!</b> Closed all active positions and locked trading for the day to preserve capital.`);
            } else {
              await sendTelegramMessage(`🛡️ <b>Daily Max Loss Floor updated to:</b> <code>-$${val.toFixed(2)} USD</code>\nTrading will automatically lock if today's net realized loss reaches this amount below starting balance.`);
            }
          }
        }
      }
      break;
    }

    case '/lock':
    case '/lockprofit': {
      if (handlers.lockDailyProfit) {
        const res = await handlers.lockDailyProfit();
        await sendTelegramMessage([
          `🔒 <b>[MYTRADA DAILY PROFIT LOCK ACTIVATED]</b>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `💰 <b>Locked Realized Today:</b> <code>+$${res.todayNet.toFixed(2)} USD (${res.todayR >= 0 ? '+' : ''}${res.todayR.toFixed(1)}R)</code>`,
          `💵 <b>Account Equity:</b> <code>$${res.liveBalance.toFixed(2)} USD</code>`,
          `🛡️ <b>Status:</b> <b>NEW SIGNALS LOCKED FOR THE DAY</b>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `⏳ <i>Bot will automatically reset and resume tomorrow at 12:00 AM UTC. Send /resume to unlock immediately.</i>`
        ].join('\n'));
      }
      break;
    }

    case '/pause':
    case '/pauseall':
    case '/stop':
    case '/stopall':
    case '/halt': {
      const pTarget = (command === '/stopall' || command === '/pauseall' || command === '/halt') ? 'all' : (arg1 ? arg1.toLowerCase() : 'all');
      if (pTarget.includes('gold') || pTarget.includes('xau')) {
        const gState = getGoldState();
        gState.isPaused = true;
        setGoldState(gState);
        await sendTelegramMessage(`⏸️ <b>[GOLD FLASH SCALPER PAUSED]</b>\nGold M1 daemon paused. Boom & Crash scanners remain active.`);
      } else if (pTarget.includes('5b')) {
        if (handlers.pauseStrategy) handlers.pauseStrategy('5b');
        await sendTelegramMessage(`⏸️ <b>[STRATEGY 5B PAUSED]</b>\nStrategy 5B signal engine paused. Strategy 6 Pro remains active.`);
      } else if (pTarget.includes('6') || pTarget.includes('pro')) {
        if (handlers.pauseStrategy) handlers.pauseStrategy('6pro');
        await sendTelegramMessage(`⏸️ <b>[STRATEGY 6 PRO PAUSED]</b>\nStrategy 6 Pro signal engine paused. Strategy 5B remains active.`);
      } else {
        const gState = getGoldState();
        gState.isPaused = true;
        setGoldState(gState);
        if (handlers.pauseBot) handlers.pauseBot();
        await sendTelegramMessage([
          `🛑 <b>[MYTRADA COMPLETE STOP — ALL ENGINES HALTED]</b>`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `• <b>Strategy 5B:</b> ⏸️ HALTED (Live & Paper)`,
          `• <b>Strategy 6 Pro:</b> ⏸️ HALTED (Live & Paper)`,
          `• <b>Gold Flash Scalper:</b> ⏸️ HALTED (M1 Daemon)`,
          `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
          `🔒 <b>All scanning stopped.</b> Zero new trades will be taken across all modes.`,
          `🛡️ Existing open positions continue to be monitored until TP/SL.`,
          `▶️ Send <code>/resume</code> or <code>/resumeall</code> to restart all scanners.`
        ].join('\n'));
      }
      break;
    }

    case '/resume':
    case '/resumeall':
    case '/startall':
    case '/unpause': {
      const upperSym = arg1 ? arg1.toUpperCase() : '';
      if (config.SYMBOLS && config.SYMBOLS[upperSym]) {
        if (handlers.resumeSymbol) {
          const res = handlers.resumeSymbol(upperSym);
          if (res.success) {
            await sendTelegramMessage([
              `▶️ 🟢 <b>[PAIR UNLOCKED: ${upperSym}]</b>`,
              `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
              `<b>Asset:</b> <code>${upperSym}</code> (${res.name || upperSym})`,
              `<b>Status:</b> Lockout & circuit breaker cleared.`,
              `🚀 <b>${upperSym}</b> is now actively scanning for high-conviction setups.`
            ].join('\n'));
          } else {
            await sendTelegramMessage(`⚠️ ${res.error || 'Failed to resume symbol.'}`);
          }
        }
        break;
      }

      const rTarget = (command === '/resumeall' || command === '/startall') ? 'all' : (arg1 ? arg1.toLowerCase() : 'all');
      if (rTarget.includes('gold') || rTarget.includes('xau')) {
        const gState = getGoldState();
        gState.isPaused = false;
        setGoldState(gState);
        await sendTelegramMessage(`▶️ <b>[GOLD FLASH SCALPER RESUMED]</b>\nGold M1 daemon is now actively scanning.`);
      } else if (rTarget.includes('5b')) {
        if (handlers.resumeStrategy) handlers.resumeStrategy('5b');
        await sendTelegramMessage(`▶️ <b>[STRATEGY 5B RESUMED]</b>\nStrategy 5B is now actively scanning.`);
      } else if (rTarget.includes('6') || rTarget.includes('pro')) {
        if (handlers.resumeStrategy) handlers.resumeStrategy('6pro');
        await sendTelegramMessage(`▶️ <b>[STRATEGY 6 PRO RESUMED]</b>\nStrategy 6 Pro is now actively scanning.`);
      } else {
        const gState = getGoldState();
        gState.isPaused = false;
        setGoldState(gState);
        if (handlers.resumeBot) {
          const res = handlers.resumeBot();
          await sendTelegramMessage([
            `▶️ 🟢 <b>[MYTRADA ALL ENGINES RESUMED]</b>`,
            `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
            `• <b>Strategy 5B:</b> 🟢 ACTIVE & SCANNING`,
            `• <b>Strategy 6 Pro:</b> 🟢 ACTIVE & SCANNING`,
            `• <b>Gold Flash Scalper:</b> 🟢 ACTIVE & SCANNING`,
            `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
            `🚀 Actively scanning <b>${res.symbolsCount} Elite Pairs</b> across all strategies.`
          ].join('\n'));
        }
      }
      break;
    }

    case '/risk': {
      const pct = parseFloat(arg1);
      if (isNaN(pct) || pct <= 0 || pct > 10) {
        await sendTelegramMessage(`⚠️ Invalid risk percentage (Allowed: 0.5% – 10.0%). Example: <code>/risk 1.5</code>`);
      } else {
        if (handlers.setRiskPercent) {
          handlers.setRiskPercent(pct);
          await sendTelegramMessage(`🛡️ <b>Trade Risk Percentage updated to:</b> <code>${pct.toFixed(1)}% per trade</code>`);
        }
      }
      break;
    }

    case '/cooldown': {
      if (!arg1) {
        await sendTelegramMessage(`⚠️ Please specify symbol. Example: <code>/cooldown BOOM300N 60</code>`);
        break;
      }
      const sym = arg1.toUpperCase();
      const mins = parseInt(arg2) || 45;
      if (handlers.setSymbolCooldown) {
        handlers.setSymbolCooldown(sym, mins);
        await sendTelegramMessage(`🛡️ <b>Manual Cooldown:</b> <code>${sym}</code> paused for <b>${mins} minutes</b>.`);
      }
      break;
    }

    case '/close': {
      if (!arg1) {
        await sendTelegramMessage(`⚠️ Please specify which pair to close, or send <code>/closeall</code>.\nExample: <code>/close CRASH1000</code>`);
        break;
      }
      const targetSym = arg1.toUpperCase();
      if (targetSym === 'ALL') {
        if (handlers.closeAllTrades) {
          const res = await handlers.closeAllTrades();
          await sendTelegramMessage(res.message);
        }
      } else {
        if (handlers.closeTrade) {
          const res = await handlers.closeTrade(targetSym);
          await sendTelegramMessage(res.message);
        }
      }
      break;
    }

    case '/closeall': {
      if (handlers.closeAllTrades) {
        const res = await handlers.closeAllTrades();
        await sendTelegramMessage(res.message);
      }
      break;
    }

    case '/be':
    case '/breakeven': {
      if (handlers.moveToBreakeven) {
        const count = handlers.moveToBreakeven();
        await sendTelegramMessage(`🛡️ <b>Breakeven Guard:</b> Moved Stop Loss to entry price for <b>${count} active position(s)</b>.`);
      }
      break;
    }

    case '/health':
    case '/scorecard': {
      if (handlers.getHealth) {
        const healthHtml = await handlers.getHealth();
        await sendTelegramMessage(healthHtml);
      }
      break;
    }

    case '/quarantine':
    case '/isolate': {
      if (!arg1) {
        await sendTelegramMessage(`⚠️ Please specify symbol. Example: <code>/quarantine BOOM300N</code>`);
        break;
      }
      const sym = arg1.toUpperCase();
      const reason = arg2 ? args.slice(2).join(' ') : 'Manual quarantine via Telegram';
      if (handlers.quarantinePair) {
        const res = handlers.quarantinePair(sym, reason);
        if (res && res.success) {
          await sendTelegramMessage(`🚨 <b>[PAIR QUARANTINED]</b>\n<code>${sym}</code> demoted to <b>Paper Test Mode ($0 Real Risk)</b>.\nReason: <i>${reason}</i>`);
        } else {
          await sendTelegramMessage(`⚠️ Error quarantining pair: ${res ? res.error : 'Unknown'}`);
        }
      }
      break;
    }

    case '/unquarantine':
    case '/restore': {
      if (!arg1) {
        await sendTelegramMessage(`⚠️ Please specify symbol. Example: <code>/unquarantine BOOM300N</code>`);
        break;
      }
      const sym = arg1.toUpperCase();
      if (handlers.unquarantinePair) {
        const res = handlers.unquarantinePair(sym);
        if (res && res.success) {
          await sendTelegramMessage(`🏆 🟢 <b>[PAIR RESTORED TO LIVE]</b>\n<code>${sym}</code> is now restored to <b>Live Real Trading</b>! Consecutive loss counters reset.`);
        } else {
          await sendTelegramMessage(`⚠️ Error restoring pair: ${res ? res.error : 'Unknown'}`);
        }
      }
      break;
    }

    case '/promote':
    case '/graduate': {
      if (!arg1) {
        await sendTelegramMessage(`⚠️ Please specify symbol. Example: <code>/promote CRASH150N</code>`);
        break;
      }
      const sym = arg1.toUpperCase();
      if (handlers.promotePair) {
        const res = handlers.promotePair(sym);
        if (res && res.success) {
          await sendTelegramMessage([
            `🎓 🟢 <b>[PAIR OFFICIALLY PROMOTED TO LIVE TRADING]</b>`,
            `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
            `<b>Asset:</b> <code>${sym}</code> (${res.name || sym})`,
            `<b>Status:</b> <b>GRADUATED FROM INCUBATION</b>`,
            `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
            `🛡️ <b>Live Safety Net:</b> If this pair takes 2 consecutive losses on its live run, it will automatically demote back to Incubation Sandbox.`,
            `🚀 <i>Pair will now execute signals with Real Live Capital.</i>`
          ].join('\n'));
        } else {
          await sendTelegramMessage(`⚠️ Error promoting pair: ${res ? res.error : 'Unknown'}`);
        }
      }
      break;
    }

    case '/demote': {
      if (!arg1) {
        await sendTelegramMessage(`⚠️ Please specify symbol. Example: <code>/demote CRASH150N</code>`);
        break;
      }
      const sym = arg1.toUpperCase();
      const reason = arg2 ? args.slice(2).join(' ') : 'Manual demotion via Telegram';
      if (handlers.demotePair) {
        const res = handlers.demotePair(sym, reason);
        if (res && res.success) {
          await sendTelegramMessage([
            `🔬 🟡 <b>[PAIR DEMOTED TO INCUBATION SANDBOX]</b>`,
            `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
            `<b>Asset:</b> <code>${sym}</code> (${res.name || sym})`,
            `<b>Status:</b> <b>MONITOR-ONLY PAPER FORWARD TEST ($0 RISK)</b>`,
            `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
            `Reason: <i>${reason}</i>`
          ].join('\n'));
        } else {
          await sendTelegramMessage(`⚠️ Error demoting pair: ${res ? res.error : 'Unknown'}`);
        }
      }
      break;
    }

    default: {
      if (rawText.startsWith('/')) {
        await sendTelegramMessage(`❓ Unknown command: <code>${command}</code>\nSend <code>/help</code> for available commands.`);
      }
    }
  }
}

module.exports = {
  sendTelegramMessage,
  startTelegramListener
};
