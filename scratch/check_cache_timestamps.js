const fs = require('fs');
const path = require('path');

const symbols = ['CRASH300N', 'CRASH500', 'BOOM300N', 'BOOM200', 'BOOM500', 'CRASH1000', 'CRASH99'];

symbols.forEach(sym => {
  const p = path.join(__dirname, '..', 'cache', `${sym}_5m_hist_1M.json`);
  if (fs.existsSync(p)) {
    const candles = JSON.parse(fs.readFileSync(p, 'utf8'));
    const first = new Date((candles[0].time || candles[0].epoch * 1000)).toISOString();
    const last = new Date((candles[candles.length - 1].time || candles[candles.length - 1].epoch * 1000)).toISOString();
    console.log(`${sym}: ${candles.length} candles | from ${first} to ${last}`);
  } else {
    console.log(`${sym}: cache file not found`);
  }
});
