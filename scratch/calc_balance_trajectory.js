// scratch/calc_balance_trajectory.js
// Calculate exact balance progression from Aug 30 to Sept 9 from the user's logs
const logs = [
  // Aug 30
  { date: "2026-08-30", pnlR: -5.7, netUSD: -17.10, startBal: 253.60, endBal: 236.50 },
  // Aug 31
  { date: "2026-08-31", pnlR: +8.9, netUSD: +67.72, startBal: 385.60, endBal: 453.32 },
  // Sept 1
  { date: "2026-09-01", pnlR: +1.5, netUSD: +12.46, startBal: 304.22, endBal: 316.68 },
  // Sept 2
  { date: "2026-09-02", pnlR: +1.5, netUSD: +13.06, startBal: 316.68, endBal: 329.74 },
  // Sept 6
  { date: "2026-09-06", pnlR: -0.4, netUSD: -6.20, startBal: 420.56, endBal: 414.36 },
  // Sept 7
  { date: "2026-09-07", pnlR: +6.4, netUSD: +84.29, startBal: 414.36, endBal: 498.65 },
  // Sept 8
  { date: "2026-09-08", pnlR: -0.8, netUSD: -15.28, startBal: 498.65, endBal: 483.37 },
  // Sept 9 (Today so far)
  { date: "2026-09-09", pnlR: +0.6, netUSD: +8.17, startBal: 483.37, endBal: 491.54 }
];

console.log("Total R generated from Aug 30 to Sept 9:", logs.reduce((a, b) => a + b.pnlR, 0).toFixed(1) + "R");

// If someone started with exactly $100 on Aug 30 with 3% risk compounding:
let bal = 100.0;
logs.forEach(l => {
  // 1R = 3% of balance
  const dailyGainPct = (l.pnlR * 0.03);
  bal = bal * (1 + dailyGainPct);
});
console.log("Hypothetical $100 account compounded on these exact trades would now be:", "$" + bal.toFixed(2));
