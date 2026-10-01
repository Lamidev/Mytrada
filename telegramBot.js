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

const https = require('https');
const config = require('./config');

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
    { command: 'status', description: "Live balance, today's P&L, target & cooldowns" },
    { command: 'report', description: "Daily performance summary report" },
    { command: 'trades', description: "Live active positions & distance to TP/SL" },
    { command: 'target', description: "Set daily profit target (/target 300 or /target off)" },
    { command: 'lock', description: "Lock today's profit & move trades to Breakeven" },
    { command: 'close', description: "Close specific trade (/close CRASH1000)" },
    { command: 'closeall', description: "Close all open trades immediately" },
    { command: 'be', description: "Move open trades to Breakeven ($0 risk)" },
    { command: 'pause', description: "Pause new signals and entries" },
    { command: 'resume', description: "Resume active market scanning" },
    { command: 'risk', description: "Change risk % per trade (/risk 1.5)" },
    { command: 'audit', description: "View filter guard audit & prevented losses" },
    { command: 'help', description: "Show all command options" }
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
        `👑 <b>[MYTRADA COMMAND CENTER]</b>`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`,
        `<b>Available Remote Commands:</b>`,
        `• <code>/status</code> ➜ Live equity, P&L, daily target & cooldowns`,
        `• <code>/report</code> ➜ Daily performance summary report`,
        `• <code>/trades</code> ➜ Live active positions & distance to TP/SL`,
        `• <code>/target &lt;amt&gt;</code> ➜ Set daily profit target (e.g. <code>/target 300</code> or <code>/target off</code>)`,
        `• <code>/lock</code> ➜ Lock in today's profit & pause until 12:00 AM`,
        `• <code>/close &lt;pair&gt;</code> ➜ Close specific trade (e.g. <code>/close CRASH1000</code>)`,
        `• <code>/closeall</code> ➜ Close all open trades immediately`,
        `• <code>/be</code> ➜ Move open trades to Breakeven ($0 risk)`,
        `• <code>/pause</code> ➜ Manually pause bot (stays paused until /resume)`,
        `• <code>/resume</code> ➜ Resume trading immediately`,
        `• <code>/risk &lt;pct&gt;</code> ➜ Change risk % (e.g. <code>/risk 1.5</code>)`,
        `• <code>/cooldown &lt;pair&gt; [mins]</code> ➜ Pause pair (e.g. <code>/cooldown BOOM300N 60</code>)`,
        `• <code>/audit</code> ➜ View counterfactual filter audit & prevented losses`,
        `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━</code>`
      ].join('\n');
      await sendTelegramMessage(helpMsg);
      break;
    }

    case '/audit':
    case '/shadow': {
      if (handlers.getShadowAudit) {
        const auditHtml = await handlers.getShadowAudit();
        await sendTelegramMessage(auditHtml);
      }
      break;
    }

    case '/report': {
      if (handlers.getDailyReport) {
        const reportHtml = handlers.getDailyReport(arg1);
        await sendTelegramMessage(reportHtml);
      }
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
    case '/stop': {
      if (handlers.pauseBot) {
        handlers.pauseBot();
        await sendTelegramMessage(`⏸️ <b>[MYTRADA MANUAL PAUSE]</b>\nAll new signals and trading paused.\nSend <code>/resume</code> to restart scanning.`);
      }
      break;
    }

    case '/resume':
    case '/unpause': {
      if (handlers.resumeBot) {
        const res = handlers.resumeBot();
        await sendTelegramMessage(`▶️ <b>[MYTRADA TRADING RESUMED]</b>\nBot is now actively scanning <b>${res.symbolsCount} Elite Pairs</b>.`);
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
