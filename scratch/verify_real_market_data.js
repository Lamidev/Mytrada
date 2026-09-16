const fs = require('fs');
const path = require('path');

// Let's verify against exact trade alerts from user's Telegram log:
// Alert 1: CRASH500 Entry 3148.41 on Sep 15/16
// Alert 2: CRASH300N Entry 2125.29 on Sep 15
// Alert 3: BOOM300N Entry 380.44 on Sep 15

function checkCandleMatch(sym, targetPrice) {
  const p = path.join(__dirname, '..', 'cache', `${sym}_5m_2000.json`);
  if (!fs.existsSync(p)) return console.log(`${sym} file not found`);
  const candles = JSON.parse(fs.readFileSync(p, 'utf8'));
  const match = candles.find(c => Math.abs(c.close - targetPrice) < 0.05);
  if (match) {
    const d = new Date((match.time || match.epoch * 1000)).toISOString();
    console.log(`[MATCH FOUND] ${sym} @ ${targetPrice}: Found candle at ${d} (Open: ${match.open}, High: ${match.high}, Low: ${match.low}, Close: ${match.close})`);
  } else {
    console.log(`[NO EXACT MATCH] for ${sym} @ ${targetPrice}`);
  }
}

console.log("Cross-referencing user Telegram alerts with Deriv downloaded candles:\n");
checkCandleMatch('CRASH500', 3148.41);
checkCandleMatch('CRASH300N', 2125.29);
checkCandleMatch('BOOM300N', 380.44);
checkCandleMatch('BOOM300N', 376.99);
checkCandleMatch('CRASH99', 96549.41);
