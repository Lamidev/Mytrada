// getTrades.js
/**
 * Utility script to fetch the history of trades executed on Deriv or simulated in Backtests.
 * 
 * Usage:
 *   node getTrades.js [options]
 * 
 * Options:
 *   --backtest          Display historical backtested trades (default)
 *   --live              Connect to Deriv API and fetch live/demo account closed trades
 *   --portfolio         (With --live) Display active open positions on live/demo account
 *   --statement         (With --live) Display account transaction ledger statement
 *   --symbol <symbol>   Filter trades by symbol (e.g. R_25, 1HZ50V)
 *   --outcome <tp|sl>   Filter by outcome (tp: take profit / win, sl: stop loss / loss)
 *   --limit <number>    Limit the number of trades displayed (default: 50)
 *   --raw               Output raw JSON data instead of formatted tables
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const dotenv = require('dotenv');
const config = require('./config');

// Load environment variables from .env
dotenv.config();

// Color codes for beautiful CLI output
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";

// Parse CLI arguments
const args = process.argv.slice(2);
const limitIndex = args.indexOf('--limit');
let limit = 50;
if (limitIndex !== -1 && args[limitIndex + 1]) {
  const parsedLimit = parseInt(args[limitIndex + 1], 10);
  if (!isNaN(parsedLimit) && parsedLimit > 0) {
    limit = parsedLimit;
  }
}

const symbolIndex = args.indexOf('--symbol');
const filterSymbol = (symbolIndex !== -1 && args[symbolIndex + 1]) ? args[symbolIndex + 1].toUpperCase() : null;

const outcomeIndex = args.indexOf('--outcome');
const filterOutcome = (outcomeIndex !== -1 && args[outcomeIndex + 1]) ? args[outcomeIndex + 1].toLowerCase() : null;

const showRaw = args.includes('--raw') || args.includes('--json');
const isLive = args.includes('--live');
const isPortfolio = args.includes('--portfolio');
const isStatement = args.includes('--statement');

const CACHE_FILE = path.join(__dirname, 'cache', 'backtest_results.json');

async function main() {
  if (isLive) {
    await handleLiveMode();
  } else {
    await handleBacktestMode();
  }
}

/**
 * Handle Backtest Mode: Read from cache/backtest_results.json
 */
async function handleBacktestMode() {
  if (!showRaw) {
    console.log(`\n${BOLD}${CYAN}=================================================================================================`);
    console.log(`📊 MYTRADA BACKTESTED TRADES SEARCHER`);
    console.log(`=================================================================================================${RESET}`);
    console.log(`Database Source: ${CACHE_FILE}`);
    if (filterSymbol) console.log(`Filter Symbol  : ${filterSymbol}`);
    if (filterOutcome) console.log(`Filter Outcome : ${filterOutcome.toUpperCase()}`);
    console.log(`Display Limit  : ${limit} trades`);
    console.log(`-------------------------------------------------------------------------------------------------`);
  }

  // Check if cache file exists, if not, offer to run compilation
  if (!fs.existsSync(CACHE_FILE)) {
    if (!showRaw) {
      console.log(`${YELLOW}⚠️ Backtest results file does not exist. Compiling it now...${RESET}`);
    }
    try {
      // Dynamically run generateCache.js or run backtests
      await compileBacktestCache();
    } catch (err) {
      console.error(`${RED}${BOLD}❌ Failed to compile backtests: ${err.message}${RESET}`);
      process.exit(1);
    }
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (err) {
    console.error(`${RED}${BOLD}❌ Error reading backtest cache file: ${err.message}${RESET}`);
    process.exit(1);
  }

  // Extract all trades from all pairs
  let allTrades = [];
  if (data.pairs && Array.isArray(data.pairs)) {
    data.pairs.forEach(pair => {
      if (pair.trades && Array.isArray(pair.trades)) {
        pair.trades.forEach(t => {
          allTrades.push({
            ...t,
            pairName: pair.name
          });
        });
      }
    });
  }

  // Sort trades by exitTime (newest first)
  allTrades.sort((a, b) => b.exitTime - a.exitTime);

  // Apply filters
  if (filterSymbol) {
    allTrades = allTrades.filter(t => t.symbol.toUpperCase() === filterSymbol || t.symbol.toUpperCase() === filterSymbol.replace('VIX', 'R_'));
  }

  if (filterOutcome) {
    if (filterOutcome === 'tp' || filterOutcome === 'win') {
      allTrades = allTrades.filter(t => t.result === 'win');
    } else if (filterOutcome === 'sl' || filterOutcome === 'loss') {
      allTrades = allTrades.filter(t => t.result === 'loss');
    }
  }

  // Apply limit
  const totalFound = allTrades.length;
  const slicedTrades = allTrades.slice(0, limit);

  if (showRaw) {
    console.log(JSON.stringify(slicedTrades, null, 2));
    process.exit(0);
  }

  displayBacktestTradesTable(slicedTrades, totalFound);
}

/**
 * Handle Live Mode: Fetch from Deriv WebSocket API
 */
async function handleLiveMode() {
  const token = process.env.DERIV_API_TOKEN;
  if (!token) {
    console.error(`${RED}${BOLD}❌ Error: DERIV_API_TOKEN is not defined in your .env file.${RESET}`);
    process.exit(1);
  }

  if (!showRaw) {
    console.log(`\n${BOLD}${CYAN}=================================================================================================`);
    console.log(`📊 DERIV LIVE ACCOUNT TRADE SCANNER`);
    console.log(`=================================================================================================${RESET}`);
    console.log(`Connecting to: ${config.DERIV_WS_URL}`);
    console.log(`Token: ${token.substring(0, 4)}...${token.substring(token.length - 3)}`);
    if (filterSymbol) console.log(`Filter Symbol  : ${filterSymbol}`);
    if (filterOutcome) console.log(`Filter Outcome : ${filterOutcome.toUpperCase()}`);
    console.log(`Fetch Limit: ${limit} records`);
    console.log(`-------------------------------------------------------------------------------------------------`);
  }

  try {
    const ws = await connectWS(config.DERIV_WS_URL, token);

    if (isPortfolio) {
      const openContracts = await fetchPortfolio(ws);
      let filtered = openContracts;
      if (filterSymbol) {
        filtered = filtered.filter(c => c.symbol.toUpperCase() === filterSymbol || c.symbol.toUpperCase() === filterSymbol.replace('VIX', 'R_'));
      }
      if (showRaw) {
        console.log(JSON.stringify(filtered.slice(0, limit), null, 2));
      } else {
        displayPortfolioTable(filtered.slice(0, limit));
      }
    } else if (isStatement) {
      const statementTxs = await fetchStatement(ws, limit);
      if (showRaw) {
        console.log(JSON.stringify(statementTxs, null, 2));
      } else {
        displayStatementTable(statementTxs);
      }
    } else {
      // Default live mode: closed profit table
      const closedTrades = await fetchProfitTable(ws, limit);
      let filtered = closedTrades;
      if (filterSymbol) {
        filtered = filtered.filter(t => t.symbol.toUpperCase() === filterSymbol || t.symbol.toUpperCase() === filterSymbol.replace('VIX', 'R_'));
      }
      if (filterOutcome) {
        filtered = filtered.filter(t => {
          const isWin = parseFloat(t.profit) > 0;
          return filterOutcome === 'tp' || filterOutcome === 'win' ? isWin : !isWin;
        });
      }
      if (showRaw) {
        console.log(JSON.stringify(filtered, null, 2));
      } else {
        displayProfitTable(filtered);
      }
    }

    ws.close();
  } catch (error) {
    console.error(`\n${RED}${BOLD}❌ Live Connection Error: ${error.message}${RESET}\n`);
    process.exit(1);
  }
}

/**
 * Compiles the backtest results using the generateCache algorithm
 */
function compileBacktestCache() {
  return new Promise((resolve, reject) => {
    try {
      const { runBacktest } = require('./backtester');
      const { getCandles } = require('./dataFetcher');
      
      const symbols = Object.keys(config.SYMBOLS);
      const reports = [];
      
      let completedCount = 0;
      
      if (symbols.length === 0) {
        return reject(new Error("No symbols defined in config.js"));
      }

      const run = async () => {
        for (const symbol of symbols) {
          try {
            const ltfCandles = await getCandles(symbol, config.DEFAULT_LTF, 2000, false);
            const htfCandles = await getCandles(symbol, config.DEFAULT_HTF, 500, false);
            const report = runBacktest(symbol, ltfCandles, htfCandles);
            report.name = config.SYMBOLS[symbol];
            reports.push(report);
          } catch (err) {
            console.warn(`   ⚠️ Warning: failed to backtest ${symbol}: ${err.message}`);
          }
        }
        
        // Compile global consolidated statistics
        const totalTrades = reports.reduce((sum, r) => sum + r.totalTrades, 0);
        const totalWins = reports.reduce((sum, r) => sum + r.wins, 0);
        const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
        const netProfit = reports.reduce((sum, r) => sum + r.netProfit, 0);
        const totalROI = (netProfit / (config.STARTING_BALANCE * reports.length)) * 100;
        const maxDrawdown = Math.max(...reports.map(r => r.maxDrawdown));
        
        const profitFactors = reports.filter(r => isFinite(r.profitFactor) && r.profitFactor > 0).map(r => r.profitFactor);
        const avgProfitFactor = profitFactors.length > 0 ? profitFactors.reduce((sum, val) => sum + val, 0) / profitFactors.length : 1;
        
        reports.sort((a, b) => b.roi - a.roi);
        
        const results = {
          global: {
            totalTrades,
            wins: totalWins,
            losses: totalTrades - totalWins,
            winRate: parseFloat(winRate.toFixed(2)),
            netProfit: parseFloat(netProfit.toFixed(2)),
            roi: parseFloat(totalROI.toFixed(2)),
            maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
            avgProfitFactor: parseFloat(avgProfitFactor.toFixed(2)),
            startingBalance: config.STARTING_BALANCE * reports.length,
            pairsCount: reports.length
          },
          pairs: reports
        };
        
        fs.writeFileSync(CACHE_FILE, JSON.stringify(results, null, 2), 'utf8');
        resolve();
      };
      
      run();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Connects to Deriv WS and authorizes.
 */
function connectWS(url, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let isResolved = false;

    const timeout = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        ws.terminate();
        reject(new Error("Timeout establishing connection and authorizing (15s)."));
      }
    }, 15000);

    ws.on('open', () => {
      if (!showRaw) console.log(`[WebSocket] Connected. Sending authorization...`);
      ws.send(JSON.stringify({ authorize: token }));
    });

    ws.on('message', (data) => {
      try {
        const response = JSON.parse(data.toString());
        if (response.error) {
          clearTimeout(timeout);
          isResolved = true;
          ws.close();
          return reject(new Error(`Authorization failed: ${response.error.message}`));
        }

        if (response.msg_type === 'authorize') {
          clearTimeout(timeout);
          isResolved = true;
          if (!showRaw) {
            console.log(`[WebSocket] Authorized: ${response.authorize.email}`);
            console.log(`            Account ID: ${response.authorize.loginid} (${response.authorize.currency})`);
            console.log(`            Balance   : $${parseFloat(response.authorize.balance).toFixed(2)} ${response.authorize.currency}`);
            console.log(`-------------------------------------------------------------------------------------------------`);
          }
          ws.removeAllListeners('message');
          resolve(ws);
        }
      } catch (err) {
        clearTimeout(timeout);
        isResolved = true;
        ws.close();
        reject(err);
      }
    });

    ws.on('error', (err) => {
      if (!isResolved) {
        clearTimeout(timeout);
        isResolved = true;
        reject(err);
      }
    });
  });
}

/**
 * Sends request and waits for response of specific msg_type
 */
function sendRequest(ws, requestBody, responseMsgType) {
  return new Promise((resolve, reject) => {
    const onMessage = (data) => {
      try {
        const response = JSON.parse(data.toString());
        if (response.error) {
          ws.removeListener('message', onMessage);
          return reject(new Error(`API Error on ${responseMsgType}: ${response.error.message}`));
        }
        if (response.msg_type === responseMsgType) {
          ws.removeListener('message', onMessage);
          resolve(response[responseMsgType]);
        }
      } catch (err) {
        ws.removeListener('message', onMessage);
        reject(err);
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify(requestBody));
  });
}

function fetchPortfolio(ws) {
  return sendRequest(ws, { portfolio: 1 }, 'portfolio').then(p => p.contracts || []);
}

function fetchProfitTable(ws, fetchLimit) {
  return sendRequest(ws, { profit_table: 1, limit: fetchLimit, description: 1, sort: 'DESC' }, 'profit_table').then(p => p.transactions || []);
}

function fetchStatement(ws, fetchLimit) {
  return sendRequest(ws, { statement: 1, limit: fetchLimit, description: 1 }, 'statement').then(s => s.transactions || []);
}

/**
 * Display Backtest Trades in a table
 */
function displayBacktestTradesTable(trades, totalFound) {
  console.log(`${BOLD}${YELLOW}📋 CHRONOLOGICAL BACKTEST TRADES SUMMARY (Newest First):${RESET}`);
  if (trades.length === 0) {
    console.log(`No backtested trades matching the filters were found.\n`);
    return;
  }

  const header = String.prototype.concat(
    `| ${"Exit Time (Local)".padEnd(19)} | `,
    `| ${"Asset".padEnd(8)} | `,
    `${"Type".padEnd(5)} | `,
    `${"Entry Price".padStart(12)} | `,
    `${"Stop Loss".padStart(12)} | `,
    `${"Take Profit".padStart(12)} | `,
    `${"Exit Price".padStart(12)} | `,
    `${"Profit ($)".padStart(12)} | `,
    `${"Outcome".padEnd(8)} |`
  );
  console.log(header);
  console.log("-".repeat(header.length));

  let totalWin = 0;
  let totalLoss = 0;
  let winCount = 0;
  let lossCount = 0;

  trades.forEach(t => {
    const exitTime = new Date(t.exitTime);
    const dateStr = exitTime.toLocaleString().substring(0, 19).padEnd(19);
    const symbolStr = t.symbol.replace('R_', 'VIX ').padEnd(8);
    const typeStr = t.type.toUpperCase().padEnd(5);
    const entryPrice = parseFloat(t.entryPrice).toFixed(2).padStart(12);
    const stopLoss = parseFloat(t.stopLoss).toFixed(2).padStart(12);
    const takeProfit = parseFloat(t.takeProfit).toFixed(2).padStart(12);
    const exitPrice = parseFloat(t.exitPrice).toFixed(2).padStart(12);
    
    const profit = parseFloat(t.profit);
    const isWin = t.result === 'win';
    const profitSign = profit >= 0 ? "+" : "";
    const profitColor = isWin ? GREEN : RED;
    const profitStr = `${profitColor}${profitSign}$${profit.toFixed(2)}${RESET}`.padStart(21);
    
    const outcome = isWin ? "🏆 TP HIT" : "🛡️ SL HIT";
    if (isWin) {
      winCount++;
      totalWin += profit;
    } else {
      lossCount++;
      totalLoss += Math.abs(profit);
    }

    const row = String.prototype.concat(
      `| ${dateStr} | `,
      `| ${CYAN}${symbolStr}${RESET} | `,
      `${typeStr} | `,
      `${entryPrice} | `,
      `${stopLoss} | `,
      `${takeProfit} | `,
      `${exitPrice} | `,
      `${profitStr} | `,
      `${isWin ? GREEN : RED}${outcome.padEnd(8)}${RESET} |`
    );
    console.log(row);
  });

  console.log("=".repeat(header.length));

  const count = trades.length;
  const netProfit = totalWin - totalLoss;
  const winRate = count > 0 ? (winCount / count) * 100 : 0;
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? Infinity : 1;

  console.log(`\n${BOLD}${CYAN}📊 Backtest Sub-Metrics (Displayed ${count} of ${totalFound} total trades found):${RESET}`);
  console.log(`   • Wins vs Losses : ${GREEN}${winCount} Wins${RESET} / ${RED}${lossCount} Losses${RESET} (Win Rate: ${BOLD}${winRate.toFixed(2)}%${RESET})`);
  console.log(`   • Display Net P/L: ${netProfit >= 0 ? GREEN : RED}${netProfit >= 0 ? "+" : ""}$${netProfit.toFixed(2)} USD${RESET}`);
  console.log(`   • Profit Factor  : ${BOLD}${profitFactor === Infinity ? 'Infinity' : profitFactor.toFixed(2)}${RESET}`);
  console.log(`=================================================================================================\n`);
}

/**
 * Formats and displays active open positions (Portfolio)
 */
function displayPortfolioTable(contracts) {
  console.log(`${BOLD}${YELLOW}📋 ACTIVE OPEN POSITIONS (Portfolio):${RESET}`);
  if (contracts.length === 0) {
    console.log(`No active positions found.\n`);
    return;
  }

  const header = String.prototype.concat(
    `| ${"Opened Time (Local)".padEnd(19)} | `,
    `${"Contract ID".padEnd(12)} | `,
    `${"Asset".padEnd(8)} | `,
    `${"Type".padEnd(8)} | `,
    `${"Stake".padStart(8)} | `,
    `${"Current P/L".padStart(12)} |`
  );
  console.log(header);
  console.log("-".repeat(header.length));

  contracts.forEach(c => {
    const buyTime = new Date(c.buy_price ? c.date_start * 1000 : c.purchase_time * 1000);
    const dateStr = buyTime.toLocaleString().substring(0, 19).padEnd(19);
    const contractId = c.contract_id.toString().padEnd(12);
    const symbolStr = (c.symbol || 'N/A').replace('R_', 'VIX ').padEnd(8);
    const typeStr = c.contract_type.padEnd(8);
    const stakeStr = `$${parseFloat(c.buy_price).toFixed(2)}`.padStart(8);
    
    const profit = c.payout ? (parseFloat(c.payout) - parseFloat(c.buy_price)) : 0;
    const profitSign = profit >= 0 ? "+" : "";
    const profitColor = profit >= 0 ? GREEN : RED;
    const profitStr = `${profitColor}${profitSign}$${profit.toFixed(2)}${RESET}`.padStart(21);

    const row = String.prototype.concat(
      `| ${dateStr} | `,
      `${contractId} | `,
      `${CYAN}${symbolStr}${RESET} | `,
      `${typeStr} | `,
      `${stakeStr} | `,
      `${profitStr} |`
    );
    console.log(row);
    if (c.longcode) {
      console.log(`   └─ ${YELLOW}Description:${RESET} ${c.longcode}`);
    }
  });
  console.log("=".repeat(header.length) + "\n");
}

/**
 * Formats and displays closed trades (Profit Table)
 */
function displayProfitTable(txs) {
  console.log(`${BOLD}${GREEN}🏆 CLOSED TRADES HISTORY (Profit Table):${RESET}`);
  if (txs.length === 0) {
    console.log(`No closed trades found matching filters on your Deriv account.\n`);
    return;
  }

  const header = String.prototype.concat(
    `| ${"Sell Time (Local)".padEnd(19)} | `,
    `${"Contract ID".padEnd(12)} | `,
    `${"Asset".padEnd(8)} | `,
    `${"Type".padEnd(8)} | `,
    `${"Stake".padStart(8)} | `,
    `${"Payout".padStart(8)} | `,
    `${"Net Profit".padStart(12)} | `,
    `${"Outcome".padEnd(8)} |`
  );
  console.log(header);
  console.log("-".repeat(header.length));

  let totalWin = 0;
  let totalLoss = 0;
  let winCount = 0;
  let lossCount = 0;

  txs.forEach(t => {
    const sellTime = new Date(t.sell_time * 1000);
    const dateStr = sellTime.toLocaleString().substring(0, 19).padEnd(19);
    const contractId = t.contract_id.toString().padEnd(12);
    const symbolStr = (t.symbol || 'N/A').replace('R_', 'VIX ').padEnd(8);
    const typeStr = t.contract_type.padEnd(8);
    const stakeStr = `$${parseFloat(t.buy_price).toFixed(2)}`.padStart(8);
    const payoutStr = `$${parseFloat(t.sell_price).toFixed(2)}`.padStart(8);
    
    const profit = parseFloat(t.profit);
    const isProfit = profit > 0;
    const profitSign = profit >= 0 ? "+" : "";
    const profitColor = isProfit ? GREEN : RED;
    const profitStr = `${profitColor}${profitSign}$${profit.toFixed(2)}${RESET}`.padStart(21);
    
    let outcome = "MANUAL";
    const longcode = (t.longcode || "").toLowerCase();
    
    if (isProfit) {
      winCount++;
      totalWin += profit;
      if (longcode.includes('take profit') || longcode.includes('target reached') || longcode.includes('limit reached')) {
        outcome = "🏆 TP HIT";
      } else {
        outcome = longcode.includes('contract won') ? "🏆 TP HIT" : "🏆 WIN";
      }
    } else {
      lossCount++;
      totalLoss += Math.abs(profit);
      if (longcode.includes('stop loss') || longcode.includes('stopped out') || longcode.includes('stop-out')) {
        outcome = "🛡️ SL HIT";
      } else {
        outcome = "🛡️ LOSS";
      }
    }

    const row = String.prototype.concat(
      `| ${dateStr} | `,
      `${contractId} | `,
      `${CYAN}${symbolStr}${RESET} | `,
      `${typeStr} | `,
      `${stakeStr} | `,
      `${payoutStr} | `,
      `${profitStr} | `,
      `${isProfit ? GREEN : RED}${outcome.padEnd(8)}${RESET} |`
    );
    console.log(row);
    if (t.longcode) {
      console.log(`   └─ ${YELLOW}Description:${RESET} ${t.longcode}`);
    }
  });

  console.log("=".repeat(header.length));

  const totalCount = txs.length;
  const winRate = totalCount > 0 ? (winCount / totalCount) * 100 : 0;
  const netProfit = totalWin - totalLoss;
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? Infinity : 1;

  console.log(`\n${BOLD}${CYAN}📊 Closed Trades Summary (Last ${totalCount} Trades):${RESET}`);
  console.log(`   • Wins vs Losses: ${GREEN}${winCount} Wins${RESET} / ${RED}${lossCount} Losses${RESET} (Win Rate: ${BOLD}${winRate.toFixed(2)}%${RESET})`);
  console.log(`   • Net Profit/Loss: ${netProfit >= 0 ? GREEN : RED}${netProfit >= 0 ? "+" : ""}$${netProfit.toFixed(2)} USD${RESET}`);
  console.log(`   • Profit Factor  : ${BOLD}${profitFactor === Infinity ? 'Infinity' : profitFactor.toFixed(2)}${RESET}`);
  console.log(`-------------------------------------------------------------------------------------------------\n`);
}

/**
 * Formats and displays statement transactions (Ledger)
 */
function displayStatementTable(txs) {
  console.log(`${BOLD}${MAGENTA}📖 TRANSACTION LEDGER (Statement):${RESET}`);
  if (txs.length === 0) {
    console.log(`No ledger transactions found.\n`);
    return;
  }

  const header = String.prototype.concat(
    `| ${"Transaction Time (Local)".padEnd(19)} | `,
    `${"Ref ID".padEnd(12)} | `,
    `${"Action".padEnd(10)} | `,
    `${"Amount".padStart(10)} | `,
    `${"Balance".padStart(12)} |`
  );
  console.log(header);
  console.log("-".repeat(header.length));

  txs.forEach(t => {
    const time = new Date(t.transaction_time * 1000);
    const dateStr = time.toLocaleString().substring(0, 19).padEnd(19);
    const refId = t.reference_id ? t.reference_id.toString().padEnd(12) : "N/A".padEnd(12);
    const actionStr = (t.action_type || 'N/A').toUpperCase().padEnd(10);
    
    const amount = parseFloat(t.amount);
    const amountSign = amount >= 0 ? "+" : "";
    const amountColor = amount >= 0 ? GREEN : RED;
    const amountStr = `${amountColor}${amountSign}$${amount.toFixed(2)}${RESET}`.padStart(19);
    
    const balanceStr = `$${parseFloat(t.balance_after).toFixed(2)}`.padStart(12);

    const row = String.prototype.concat(
      `| ${dateStr} | `,
      `${refId} | `,
      `${actionStr} | `,
      `${amountStr} | `,
      `${balanceStr} |`
    );
    console.log(row);
    if (t.longcode) {
      console.log(`   └─ ${YELLOW}Details:${RESET} ${t.longcode}`);
    }
  });
  console.log("=".repeat(header.length) + "\n");
}

main();
