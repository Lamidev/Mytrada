const { getCandles } = require('../dataFetcher');

async function fetchWithRetry(sym, tf, count, maxRetries = 3) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      console.log(`Fetching ${sym} (${tf}, ${count}) attempt ${i}...`);
      const res = await getCandles(sym, tf, count, false); // use cache if already there
      if (res && res.length > 0) return res;
    } catch (e) {
      console.warn(`Attempt ${i} failed: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return [];
}

async function run() {
  await fetchWithRetry('CRASH300N', '5m', 2000);
  await fetchWithRetry('CRASH300N', '1h', 500);
  await fetchWithRetry('CRASH300N', '4h', 200);
  await fetchWithRetry('CRASH300N', '1d', 100);
  console.log("CRASH300N ready!");
}

run();
