// tradeExecutor.js
/**
 * Module for executing trades and monitoring open positions via the Deriv WebSocket API.
 * Follows the same raw WebSocket architecture as dataFetcher.js to ensure zero third-party dependencies.
 */

const WebSocket = require('ws');
const config = require('./config');

const notifiedContracts = new Set();
let monitorWs = null;

/**
 * Places a Multiplier trade (MULTUP or MULTDOWN) on Deriv based on SMC trade setup coordinates.
 * Converts price-based TP/SL into absolute dollar amounts for the Deriv Multiplier contract.
 *
 * @param {string} symbol Asset symbol (e.g., "R_10")
 * @param {string} type Setup type ("bullish" or "bearish")
 * @param {number} entryPrice Entry price level
 * @param {number} stopLossPrice Stop loss price level
 * @param {number} takeProfitPrice Take profit price level
 * @returns {Promise<number>} Resolves with the contract ID
 */
function placeTrade(symbol, type, entryPrice, stopLossPrice, takeProfitPrice) {
  return new Promise((resolve, reject) => {
    const wsUrl = config.DERIV_WS_URL;
    const ws = new WebSocket(wsUrl);
    const token = process.env.DERIV_API_TOKEN;

    if (!token) {
      return reject(new Error("DERIV_API_TOKEN is not defined in environment variables."));
    }

    const stake = parseFloat(process.env.TRADE_STAKE || 1);
    const multiplier = parseFloat(process.env.TRADE_MULTIPLIER || 20);
    const contractType = type === 'bullish' ? 'MULTUP' : 'MULTDOWN';

    // 1. Calculate SL and TP USD dollar values
    // stopLossUSD = stake * multiplier * |entryPrice - stopLossPrice| / entryPrice
    const riskAmount = Math.abs(entryPrice - stopLossPrice);
    let stopLossUSD = (stake * multiplier * riskAmount) / entryPrice;
    
    // Capping stopLossUSD at 95% of stake because Deriv has automatic stop-out at 100% loss of stake,
    // and specifying a SL equal or greater than stake will be rejected or redundant.
    if (stopLossUSD >= stake) {
      stopLossUSD = stake * 0.95;
    }
    stopLossUSD = parseFloat(stopLossUSD.toFixed(2));

    // takeProfitUSD = stake * multiplier * |takeProfitPrice - entryPrice| / entryPrice
    const rewardAmount = Math.abs(takeProfitPrice - entryPrice);
    let takeProfitUSD = (stake * multiplier * rewardAmount) / entryPrice;
    takeProfitUSD = parseFloat(takeProfitUSD.toFixed(2));

    let isResolved = false;

    // Timeout safety
    const timeout = setTimeout(() => {
      if (!isResolved) {
        cleanup();
        reject(new Error(`Timeout: Deriv trade execution timed out after 20 seconds.`));
      }
    }, 20000);

    const cleanup = () => {
      isResolved = true;
      clearTimeout(timeout);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };

    ws.on('open', () => {
      console.log(`[tradeExecutor] Executing ${type} trade on ${symbol} - Connecting & Authorizing...`);
      ws.send(JSON.stringify({ authorize: token }));
    });

    ws.on('message', (data) => {
      try {
        const response = JSON.parse(data.toString());

        if (response.error) {
          cleanup();
          return reject(new Error(`Deriv API Error: ${response.error.message}`));
        }

        // Action 1: Authorize Success -> Request Contract Proposal
        if (response.msg_type === 'authorize') {
          console.log(`[tradeExecutor] Authorized successfully. Email: ${response.authorize.email}`);

          const proposalRequest = {
            proposal: 1,
            amount: stake,
            basis: 'stake',
            contract_type: contractType,
            currency: 'USD',
            symbol: symbol,
            multiplier: multiplier
          };

          // Apply limit order SL/TP if they are valid amounts
          const limitOrder = {};
          if (stopLossUSD >= 0.01) {
            limitOrder.stop_loss = stopLossUSD;
          }
          if (takeProfitUSD >= 0.01) {
            limitOrder.take_profit = takeProfitUSD;
          }

          if (Object.keys(limitOrder).length > 0) {
            proposalRequest.limit_order = limitOrder;
          }

          console.log(`[tradeExecutor] Sending proposal request for ${symbol}:`, JSON.stringify(proposalRequest));
          ws.send(JSON.stringify(proposalRequest));
        }

        // Action 2: Proposal Success -> Buy Contract
        else if (response.msg_type === 'proposal') {
          const proposalId = response.proposal.id;
          const askPrice = response.proposal.ask_price;
          console.log(`[tradeExecutor] Proposal obtained successfully. ID: ${proposalId}, cost: $${askPrice}`);

          const buyRequest = {
            buy: proposalId,
            price: askPrice
          };

          console.log(`[tradeExecutor] Sending purchase order for proposal ${proposalId}...`);
          ws.send(JSON.stringify(buyRequest));
        }

        // Action 3: Buy Success -> Resolve
        else if (response.msg_type === 'buy') {
          cleanup();
          const contractId = response.buy.contract_id;
          console.log(`[tradeExecutor] Trade successfully placed! Contract ID: ${contractId}`);
          resolve(contractId);
        }
      } catch (err) {
        cleanup();
        reject(err);
      }
    });

    ws.on('error', (err) => {
      cleanup();
      reject(err);
    });

    ws.on('close', () => {
      if (!isResolved) {
        reject(new Error("WebSocket closed prematurely before trade could be executed."));
      }
    });
  });
}

/**
 * Establishes a persistent, auto-reconnecting WebSocket connection to stream and monitor open positions.
 * Fires `onClosedCallback` exactly once when any contract closes.
 *
 * @param {Function} onClosedCallback Function called with closed trade statistics: ({ symbol, contractId, profit, result, contractDetails })
 */
function monitorPositions(onClosedCallback) {
  const token = process.env.DERIV_API_TOKEN;
  if (!token) {
    console.error("[tradeExecutor] Cannot monitor positions: DERIV_API_TOKEN is missing in environment variables.");
    return;
  }

  const connect = () => {
    console.log("[tradeExecutor] Opening persistent monitoring WebSocket connection...");
    monitorWs = new WebSocket(config.DERIV_WS_URL);
    let pingInterval = null;

    monitorWs.on('open', () => {
      console.log("[tradeExecutor] Monitoring stream opened. Authorizing...");
      monitorWs.send(JSON.stringify({ authorize: token }));

      // Keep connection alive with 30s pings
      pingInterval = setInterval(() => {
        if (monitorWs && monitorWs.readyState === WebSocket.OPEN) {
          monitorWs.send(JSON.stringify({ ping: 1 }));
        }
      }, 30000);
    });

    monitorWs.on('message', (data) => {
      try {
        const response = JSON.parse(data.toString());

        if (response.error) {
          console.error("[tradeExecutor] Monitoring Stream API Error:", response.error.message);
          return;
        }

        // Action 1: Authorize Success -> Subscribe to open contracts
        if (response.msg_type === 'authorize') {
          console.log("[tradeExecutor] Monitoring stream authorized. Subscribing to open contracts...");
          monitorWs.send(JSON.stringify({ proposal_open_contract: 1, subscribe: 1 }));
        }

        // Action 2: Receive contract update
        else if (response.msg_type === 'proposal_open_contract') {
          const contract = response.proposal_open_contract;
          if (!contract) return;

          const { contract_id, symbol, profit, is_sold, status } = contract;

          // Process sold contract if we haven't handled this specific transaction yet
          if (is_sold && !notifiedContracts.has(contract_id)) {
            notifiedContracts.add(contract_id);
            console.log(`[tradeExecutor] Contract closed: ${contract_id} on ${symbol}. Realized Profit: $${profit} USD`);

            // Let's categorize the outcome: TP hit vs SL hit
            // In multipliers, profit > 0 is winning (TP/win) and profit <= 0 is losing (SL/loss/stop-out)
            const result = parseFloat(profit) > 0 ? 'TP' : 'SL';

            onClosedCallback({
              symbol: symbol,
              contractId: contract_id,
              profit: parseFloat(profit),
              result: result,
              contractDetails: contract
            });
          }
        }
      } catch (err) {
        console.error("[tradeExecutor] Failed to process message in monitoring loop:", err);
      }
    });

    monitorWs.on('error', (err) => {
      console.error("[tradeExecutor] Monitoring Stream encountered a connection error:", err.message);
    });

    monitorWs.on('close', () => {
      console.log("[tradeExecutor] Monitoring Stream closed. Attempting reconnect in 5 seconds...");
      if (pingInterval) {
        clearInterval(pingInterval);
      }
      setTimeout(connect, 5000);
    });
  };

  connect();
}

module.exports = {
  placeTrade,
  monitorPositions
};
