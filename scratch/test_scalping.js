const config = require('../config');
const { getCandles } = require('../dataFetcher');
const { analyzeStructure } = require('../marketStructure');

async function test() {
  const symbols = ['BOOM1000', 'CRASH600', 'BOOM900', 'CRASH1000', '1HZ100V'];
  for (const sym of symbols) {
    const ltf = await getCandles(sym, '5m', 2000, false);
    let count = 0;
    for (let i = 50; i < ltf.length; i++) {
      const analysis = analyzeStructure(ltf, i, null, sym);
      if (analysis.setup) count++;
    }
    console.log(`Symbol ${sym}: ${count} setups on 5m`);
  }
}

test();
