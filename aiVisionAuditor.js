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

/**
 * Renders the chart via python and returns Base64 PNG string.
 */
function renderChartBase64(trade, candles) {
  return new Promise((resolve, reject) => {
    const pythonScript = path.join(__dirname, 'chart_auditor.py');
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

    const payload = JSON.stringify({
      trade,
      candles: candles.slice(-50)
    });

    let stdoutData = '';
    let stderrData = '';
    let isFinished = false;

    const timer = setTimeout(() => {
      if (!isFinished) {
        isFinished = true;
        try { child.kill(); } catch (e) {}
        reject(new Error("Chart rendering timeout (4s)"));
      }
    }, 4000);

    const child = spawn(pythonCmd, [pythonScript], {
      cwd: __dirname,
      env: process.env
    });

    child.stdout.on('data', chunk => { stdoutData += chunk.toString(); });
    child.stderr.on('data', chunk => { stderrData += chunk.toString(); });

    child.on('error', err => {
      if (!isFinished) {
        isFinished = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on('close', code => {
      if (!isFinished) {
        isFinished = true;
        clearTimeout(timer);
        try {
          const res = JSON.parse(stdoutData.trim());
          if (res.success && res.image_base64) {
            resolve(res.image_base64);
          } else {
            reject(new Error(res.error || "Unknown render error"));
          }
        } catch (e) {
          reject(new Error(`Render parse error: ${stdoutData || stderrData}`));
        }
      }
    });

    child.stdin.write(payload);
    child.stdin.end();
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
 * @returns {Promise<{ verdict: 'TAKE' | 'LEAVE', confidence: number, reason: string }>}
 */
async function auditTradeWithVision({ symbol, direction, entry, tp, sl, candles }) {
  if (!API_KEY) {
    return {
      verdict: 'TAKE',
      confidence: 0.5,
      reason: 'Gemini API key not configured — proceeding on Strategy 5C math.'
    };
  }

  try {
    // 1. Render chart to base64 via Python
    const base64Img = await renderChartBase64({ symbol, direction, entry, tp, sl }, candles);

    // 2. Query Gemini 2.5 Flash Vision via native Node fetch
    const prompt = `You are the Senior Quantitative Risk Officer and Institutional Chart Auditor for the Mytrada Algo Trading Bot.
Auditing Trade Setup:
- Asset: ${symbol}
- Direction: ${direction} (Momentum Exhaustion Sniper)
- Entry Price (Blue dashed line): ${entry.toFixed(2)}
- Target TP (Green solid line): ${tp.toFixed(2)}
- Stop Loss (Red solid line): ${sl.toFixed(2)}

CALIBRATED EVALUATION RULES:
1. In an active trend, breaking single minor prior candle highs (for BUY) or minor lows (for SELL) is NORMAL healthy trend continuation (Break of Structure). DO NOT veto healthy breakouts.
2. ONLY VETO ('LEAVE') if price is entering directly into a major, unmistakable, multi-touch horizontal brick wall (e.g. strong double-top or triple-top ceiling right above Entry for BUY, or major double/triple bottom floor right below Entry for SELL).
3. If the path to Take Profit is open or in an established trend without an immediate multi-touch brick wall, approve ('TAKE').

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
  auditTradeWithVision
};
