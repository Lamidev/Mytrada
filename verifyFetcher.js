// verifyFetcher.js
/**
 * Simple script to verify that dataFetcher.js can successfully fetch
 * and cache candles from the Deriv API.
 */

const { getCandles } = require('./dataFetcher');

async function testFetcher() {
  console.log("=========================================");
  console.log("Testing Deriv Data Fetcher Connection...");
  console.log("=========================================");
  
  try {
    // Fetch 50 candles of VIX 75 on the 15-minute timeframe
    const candles = await getCandles('R_75', '15m', 50, true);
    
    console.log(`\nSuccessfully fetched ${candles.length} candles!`);
    console.log("First candle details:", candles[0]);
    console.log("Last candle details:", candles[candles.length - 1]);
    
    // Test cache loading
    console.log("\nTesting cache retrieval...");
    const cachedCandles = await getCandles('R_75', '15m', 50, false);
    console.log(`Cache loading works! Loaded ${cachedCandles.length} candles instantly.`);
    console.log("=========================================");
  } catch (err) {
    console.error("Fetcher Verification Failed:", err);
  }
}

testFetcher();
