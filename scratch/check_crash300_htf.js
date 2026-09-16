const { getCandles } = require('../dataFetcher');

async function checkCrash300() {
  const h1Candles = await getCandles('CRASH300N', '1h', 500, false);
  const h4Candles = await getCandles('CRASH300N', '4h', 200, false);
  const dailyCandles = await getCandles('CRASH300N', '1d', 100, false);
  console.log(`CRASH300N 1h: ${h1Candles.length}, 4h: ${h4Candles.length}, 1d: ${dailyCandles.length}`);
  
  const last1h = h1Candles[h1Candles.length - 1];
  console.log("Last 1h candle:", last1h);
}

checkCrash300();
