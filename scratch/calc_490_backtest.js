// scratch/calc_490_backtest.js
// Scale the 30-day backtest to the user's current ~$490 account size (1R = $14.70)
const riskPerTrade = 14.70; // 3.0% of $490

const topPairs = [
  { symbol: "BOOM500",  mode: "2-Spike", netR: 56.0, wr: "59.6%" },
  { symbol: "BOOM300N", mode: "3-Spike", netR: 36.7, wr: "56.6%" },
  { symbol: "CRASH500", mode: "2-Spike", netR: 39.8, wr: "58.9%" },
  { symbol: "CRASH600", mode: "2-Spike", netR: 32.1, wr: "54.9%" },
  { symbol: "CRASH900", mode: "2-Spike", netR: 22.1, wr: "58.7%" },
  { symbol: "BOOM200",  mode: "3-Spike", netR: 13.4, wr: "64.3%" },
  { symbol: "CRASH99",  mode: "3-Spike", netR: 13.1, wr: "65.4%" },
  { symbol: "CRASH1000",mode: "2-Spike", netR: 10.9, wr: "54.8%" },
  { symbol: "BOOM100",  mode: "3-Spike", netR: 5.8,  wr: "51.6%" }
];

console.log("=== 30-DAY EXPECTED RETURN AT YOUR CURRENT $490 BALANCE (1R = $14.70) ===");
let totR = 0;
let totUSD = 0;
topPairs.forEach(p => {
  const usd = p.netR * riskPerTrade;
  totR += p.netR;
  totUSD += usd;
  console.log(`${p.symbol.padEnd(10)} (${p.mode.padEnd(7)}): ${p.netR > 0 ? '+' : ''}${p.netR.toFixed(1)}R | +$${usd.toFixed(2)} USD (WR: ${p.wr})`);
});
console.log(`TOTAL PORTFOLIO: +${totR.toFixed(1)}R | +$${totUSD.toFixed(2)} USD (approx +${(totUSD/490*100).toFixed(0)}% monthly return without compounding)`);
