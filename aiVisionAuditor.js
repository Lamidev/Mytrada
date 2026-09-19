// aiVisionAuditor.js
/**
 * Institutional Multimodal AI Vision Gatekeeper for Mytrada Algo Trading Bot.
 * Bridges Strategy 5C signal detection with Gemini 2.5 Flash Vision.
 * Spawns headless Python chart renderer and audits visual headroom via native Node fetch.
 */

const { spawn } = require('child_process');
const path = require('path');
require('dotenv').config();

const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

let chartDaemon = null;
let daemonStdoutBuffer = '';
const pendingQueue = [];

function getChartDaemon() {
  if (chartDaemon && !chartDaemon.killed) {
    return chartDaemon;
  }

  const pythonScript = path.join(__dirname, 'chart_auditor.py');
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

  chartDaemon = spawn(pythonCmd, [pythonScript, '--daemon'], {
    cwd: __dirname,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  daemonStdoutBuffer = '';

  chartDaemon.stdout.on('data', chunk => {
    daemonStdoutBuffer += chunk.toString();
    const lines = daemonStdoutBuffer.split('\n');
    daemonStdoutBuffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'WORKER_READY') continue;

      if (pendingQueue.length > 0) {
        const item = pendingQueue.shift();
        clearTimeout(item.timer);
        try {
          const res = JSON.parse(trimmed);
          if (res.success && res.image_base64) {
            item.resolve(res.image_base64);
          } else {
            item.reject(new Error(res.error || "Unknown daemon error"));
          }
        } catch (e) {
          item.reject(new Error(`Daemon parse error: ${e.message}`));
        }
      }
    }
  });

  chartDaemon.stderr.on('data', chunk => {
    // console.warn('[chartDaemon stderr]:', chunk.toString());
  });

  chartDaemon.on('exit', () => {
    chartDaemon = null;
    while (pendingQueue.length > 0) {
      const item = pendingQueue.shift();
      clearTimeout(item.timer);
      item.reject(new Error("Chart daemon exited prematurely"));
    }
  });

  return chartDaemon;
}

// Pre-warm daemon on process startup
try {
  getChartDaemon();
} catch (e) {}

/**
 * Renders the chart via python daemon and returns Base64 PNG string.
 */
function renderChartBase64(trade, candles, htfCandles = null) {
  return new Promise((resolve, reject) => {
    try {
      const daemon = getChartDaemon();
      const payloadObj = {
        trade,
        candles: candles.slice(-50)
      };
      if (htfCandles && htfCandles.length > 0) {
        payloadObj.htf_candles = htfCandles.slice(-40);
      }

      const timer = setTimeout(() => {
        const idx = pendingQueue.findIndex(p => p.timer === timer);
        if (idx !== -1) {
          pendingQueue.splice(idx, 1);
          reject(new Error("Chart rendering timeout (12s)"));
        }
      }, 12000);

      pendingQueue.push({ resolve, reject, timer });
      daemon.stdin.write(JSON.stringify(payloadObj) + '\n');
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Audits a proposed trade setup using Gemini 2.5 Flash Multimodal Vision.
 * @param {Object} params Setup parameters:
 *   - symbol: string (e.g. 'CRASH500')
 *   - direction: 'BUY' | 'SELL'
 *   - entry: number
 *   - tp: number
 *   - sl: number
 *   - candles: Array<{ open, high, low, close, time }> (Last 30-50 M5 candles)
 *   - htfCandles: Array<{ open, high, low, close, time }> (Last 30-40 1H candles, optional)
 * @returns {Promise<{ verdict: 'TAKE' | 'LEAVE', confidence: number, reason: string }>}
 */
async function auditTradeWithVision({ symbol, direction, entry, tp, sl, candles, htfCandles = null }) {
  if (!API_KEY) {
    return {
      verdict: 'TAKE',
      confidence: 0.5,
      reason: 'Gemini API key not configured — proceeding on Strategy 5C math.'
    };
  }

  try {
    // 1. Render chart to base64 via Python (Dual-Panel if htfCandles provided)
    const base64Img = await renderChartBase64({ symbol, direction, entry, tp, sl }, candles, htfCandles);

    // 2. Query Gemini 2.5 Flash Vision via native Node fetch
    const hasDualPanel = htfCandles && htfCandles.length > 0;
    const prompt = hasDualPanel ? `You are the Senior Quantitative Risk Officer and Institutional Chart Auditor for the Mytrada Algo Trading Bot.
Auditing Trade Setup:
- Asset: ${symbol}
- Direction: ${direction} (Value-Zone Exhaustion Sniper)
- Entry Price (Blue dashed line): ${entry.toFixed(2)}
- Target TP (Green solid line): ${tp.toFixed(2)}
- Stop Loss (Red solid line): ${sl.toFixed(2)}

The image shows a Dual-Timeframe Panel:
• TOP PANEL: 1-Hour (1H) Macro Market Structure (last ~35 hours). Cyan dotted line shows current price.
• BOTTOM PANEL: 5-Minute (5M) Execution Runway with Entry (blue), TP Target (green), and SL (red).

INSTITUTIONAL CRITERIA & DERIV SYNTHETIC MECHANICS:
1. SYNTHETIC TICK DRIFT & EXHAUSTION DYNAMICS:
   - On Boom (SELL) and Crash (BUY), the index is programmed to naturally drift in the trend direction tick-by-tick once counter-trend spikes stop.
   - A 2-to-3 spike counter-trend pullback that reaches the 5M 20/50 EMA value zone is the intended institutional setup.
   - If the final 5M entry bar has closed with a solid reversal body (red on Boom, green on Crash), the spike burst has stopped. Do NOT reject the trade simply because the spikes were large — the completed pullback into the EMA is the expected pattern.
2. 1H MACRO STRUCTURE (Top Panel):
   - Reject ('LEAVE') ONLY if the 1H macro trend is unaligned, in steep runaway counter-trend momentum, or if price is severely over-extended at the tail-end of a multi-day move.
3. 5M RUNWAY & OBSTACLES (Bottom Panel):
   - Reject ('LEAVE') if there is an insurmountable multi-hour major horizontal brick wall (support floor for SELL, resistance ceiling for BUY) directly blocking the TP line.
   - Normal minor local wicks, previous single candle lows, or trend continuation levels are expected to be swept by tick drift — do not over-filter normal trend progression.
4. APPROVAL: Approve ('TAKE') if the 1H structure is aligned and the 5M runway toward the TP target has reasonable room to deliver before major macro barriers.

Respond strictly in JSON:
{
  "verdict": "TAKE" | "LEAVE",
  "confidence": number,
  "reason": "1 concise sentence explaining the visual chart rationale covering macro trend, exhaustion quality, & runway."
}` : `You are the Senior Quantitative Risk Officer and Institutional Chart Auditor for the Mytrada Algo Trading Bot.
Auditing Trade Setup:
- Asset: ${symbol}
- Direction: ${direction} (Value-Zone Exhaustion Sniper)
- Entry Price (Blue dashed line): ${entry.toFixed(2)}
- Target TP (Green solid line): ${tp.toFixed(2)}
- Stop Loss (Red solid line): ${sl.toFixed(2)}

INSTITUTIONAL CRITERIA & DERIV SYNTHETIC MECHANICS:
1. On Boom/Crash, 2-to-3 spikes retesting the 20/50 EMA followed by an exhaustion close is the intended entry. Do NOT mistake completed spikes for unexhausted momentum.
2. Reject ('LEAVE') ONLY if an insurmountable major horizontal brick wall directly blocks the Green TP target line.
3. Approve ('TAKE') if the exhaustion candle has paused the spikes and the path to Take Profit is open.

Respond strictly in JSON:
{
  "verdict": "TAKE" | "LEAVE",
  "confidence": number,
  "reason": "1 concise sentence explaining the visual chart rationale."
}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`;
    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), 15000); // 15s network timeout

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: "image/png",
                data: base64Img
              }
            }
          ]
        }],
        generationConfig: {
          response_mime_type: "application/json",
          temperature: 0.1
        }
      })
    });

    clearTimeout(fetchTimeout);
    const data = await response.json();

    if (data.candidates && data.candidates[0]) {
      const text = data.candidates[0].content.parts[0].text;
      const parsed = JSON.parse(text);
      const rawVerdict = String(parsed.verdict || 'TAKE').toUpperCase();
      const verdict = rawVerdict === 'LEAVE' ? 'LEAVE' : 'TAKE';
      return {
        verdict,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.85,
        reason: String(parsed.reason || 'Headroom evaluated by AI Vision.').trim()
      };
    } else {
      return {
        verdict: 'TAKE',
        confidence: 0.5,
        reason: 'Gemini API response fallback — proceeding on Strategy 5C math.'
      };
    }
  } catch (err) {
    return {
      verdict: 'TAKE',
      confidence: 0.5,
      reason: `AI Vision fallback: ${err.message || 'timed out'}`
    };
  }
}

module.exports = {
  auditTradeWithVision,
  renderChartBase64
};
