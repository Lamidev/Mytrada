const { getCandles } = require('../dataFetcher');

async function testFetch() {
  try {
    console.log("Testing Deriv WS connection and fetching latest CRASH300N 5m candles...");
    const candles = await getCandles('CRASH300N', '5m', 2000, true);
    console.log(`Fetched ${candles.length} candles!`);
    const first = new Date((candles[0].time || candles[0].epoch * 1000)).toISOString();
    const last = new Date((candles[candles.length - 1].time || candles[candles.length - 1].epoch * 1000)).toISOString();
    console.log(`Range: ${first} to ${last}`);
  } catch (err) {
    console.error("Fetch failed:", err.message);
  }
  process.exit(0);
}

testFetch();
