const { getCandles } = require('../dataFetcher');

async function forceRefreshAll() {
  const syms = ['CRASH300N'];
  for (const s of syms) {
    console.log(`Force refreshing ${s}...`);
    await getCandles(s, '5m', 2000, true);
    await getCandles(s, '1h', 500, true);
    await getCandles(s, '4h', 200, true);
    await getCandles(s, '1d', 100, true);
  }
  console.log("Done!");
}

forceRefreshAll();
