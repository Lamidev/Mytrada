const fs = require('fs');
const path = require('path');

function analyzeFile(filePath, portfolioName) {
  if (!fs.existsSync(filePath)) {
    console.log(`File not found: ${filePath}`);
    return;
  }
  const trades = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  console.log(`\n======================================================`);
  console.log(`📊 PERFORMANCE REPORT: ${portfolioName.toUpperCase()}`);
  console.log(`======================================================`);

  // We can group by closed date or signal date. Let's group by closed date (and also report signal date).
  const days = ['2026-08-13', '2026-08-14', '2026-08-15'];

  // Global totals
  let totalWins = 0;
  let totalLosses = 0;
  let totalOpen = 0;
  let totalGrossProfit = 0;
  let totalGrossLoss = 0;
  let totalNetUSD = 0;
  let totalNetR = 0;

  days.forEach(day => {
    // Trades closed on this day
    const closedOnDay = trades.filter(t => t.closedTime && t.closedTime.startsWith(day));
    const signalsOnDay = trades.filter(t => t.signalTime && t.signalTime.startsWith(day));

    let wins = 0;
    let losses = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let netUSD = 0;
    let netR = 0;

    closedOnDay.forEach(t => {
      if (t.outcome === 'WIN') {
        wins++;
        grossProfit += t.pnlUSD;
      } else if (t.outcome === 'LOSS') {
        losses++;
        grossLoss += Math.abs(t.pnlUSD);
      }
      netUSD += t.pnlUSD;
      netR += t.pnlR;
    });

    totalWins += wins;
    totalLosses += losses;
    totalGrossProfit += grossProfit;
    totalGrossLoss += grossLoss;
    totalNetUSD += netUSD;
    totalNetR += netR;

    const totalClosed = wins + losses;
    const winRate = totalClosed > 0 ? ((wins / totalClosed) * 100).toFixed(1) : "0.0";
    const statusText = netUSD > 0 ? `🟢 PROFIT (+$${netUSD.toFixed(2)} / +${netR.toFixed(1)}R)` : (netUSD < 0 ? `🔴 DRAWDOWN (-$${Math.abs(netUSD).toFixed(2)} / ${netR.toFixed(1)}R)` : `⚪ BREAKEVEN ($0.00)`);

    console.log(`\n📅 DATE: ${day} (${day === '2026-08-13' ? 'Aug 13' : (day === '2026-08-14' ? 'Aug 14 (Yesterday)' : 'Aug 15 (Today so far)')})`);
    console.log(`------------------------------------------------------`);
    console.log(`  Signals Generated: ${signalsOnDay.length}`);
    console.log(`  Positions Closed:  ${totalClosed} (${wins} Wins / ${losses} Losses)`);
    console.log(`  Win Rate:          ${winRate}%`);
    console.log(`  Total Profit (TP): +$${grossProfit.toFixed(2)} USD`);
    console.log(`  Total Loss (SL):   -$${grossLoss.toFixed(2)} USD`);
    console.log(`  End of Day Result: ${statusText}`);
    console.log(`  Closed Trades:`);
    closedOnDay.forEach(t => {
      const outcomeEmoji = t.outcome === 'WIN' ? '🟢 WIN (+1.3R / +$130)' : '🔴 LOSS (-1.0R / -$100)';
      console.log(`    • [${t.closedTime.slice(11, 16)} UTC] ${t.symbol} (${t.direction}) | Entry: ${t.entryPrice.toFixed(2)} ➔ Exit: ${t.exitPrice.toFixed(2)} | ${outcomeEmoji}`);
    });
  });

  const openTrades = trades.filter(t => t.status === 'OPEN');
  totalOpen = openTrades.length;

  console.log(`\n------------------------------------------------------`);
  console.log(`🏆 OVERALL TOTALS (Aug 13 - Aug 15):`);
  console.log(`  Total Closed Trades: ${totalWins + totalLosses}`);
  console.log(`  Wins:                ${totalWins} (Win Rate: ${((totalWins / (totalWins + totalLosses)) * 100).toFixed(1)}%)`);
  console.log(`  Losses:              ${totalLosses}`);
  console.log(`  Currently Open:      ${totalOpen}`);
  console.log(`  Total Gross Profit:  +$${totalGrossProfit.toFixed(2)} USD`);
  console.log(`  Total Gross Loss:    -$${totalGrossLoss.toFixed(2)} USD`);
  console.log(`  NET PnL:             ${totalNetUSD >= 0 ? '+' : ''}$${totalNetUSD.toFixed(2)} USD (${totalNetR >= 0 ? '+' : ''}${totalNetR.toFixed(1)}R)`);
  console.log(`  Status:              ${totalNetUSD > 0 ? '🟢 OVERALL PROFIT' : (totalNetUSD < 0 ? '🔴 OVERALL DRAWDOWN' : '⚪ BREAKEVEN')}`);
  console.log(`======================================================\n`);
}

analyzeFile(path.join(__dirname, 'top8_august_trades.json'), 'Top 8 Portfolio (Active Bot Config)');
analyzeFile(path.join(__dirname, 'all20_august_trades.json'), 'All 20 Boom & Crash Pairs');
