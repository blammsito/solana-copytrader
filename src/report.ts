import { getAllTrades, ClosedTrade } from './tradeLedger';
import { getOpenPositions } from './positionTracker';
import { config } from './config';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

function fmtSol(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(4)} SOL`;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

async function previewCurrentValue(mint: string, tokensAmountRaw: string): Promise<number | null> {
  try {
    const url =
      `${config.jupiterApiUrl}/quote?inputMint=${mint}&outputMint=${SOL_MINT}` +
      `&amount=${tokensAmountRaw}&slippageBps=${config.maxSlippageBps}`;
    const res = await fetch(url, {
      headers: config.jupiterApiKey ? { 'x-api-key': config.jupiterApiKey } : {},
    });
    if (!res.ok) return null;
    const quote = (await res.json()) as any;
    if (!quote || quote.error) return null;
    return Number(quote.outAmount) / 1e9;
  } catch {
    return null;
  }
}

async function main() {
  const trades = getAllTrades();

  console.log('='.repeat(72));
  console.log('TRADE PERFORMANCE REPORT');
  console.log('='.repeat(72));

  if (trades.length === 0) {
    console.log('No closed trades yet — nothing to report until at least one position exits.');
  } else {
    const wins = trades.filter((t) => t.pnlSol > 0);
    const losses = trades.filter((t) => t.pnlSol <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnlSol, 0);
    const winRate = (wins.length / trades.length) * 100;
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnlSol, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnlSol, 0) / losses.length : 0;
    const expectancy = totalPnl / trades.length;
    const avgHoldMin = trades.reduce((s, t) => s + t.holdMinutes, 0) / trades.length;

    console.log(`Closed trades: ${trades.length}  (${wins.length} win / ${losses.length} loss)`);
    console.log(`Win rate: ${winRate.toFixed(1)}%`);
    console.log(`Total realized P&L: ${fmtSol(totalPnl)}`);
    console.log(`Avg win: ${fmtSol(avgWin)}   Avg loss: ${fmtSol(avgLoss)}`);
    console.log(`Expectancy per trade: ${fmtSol(expectancy)}`);
    console.log(`Avg hold time: ${avgHoldMin.toFixed(1)} min`);

    const exitReasonCounts = new Map<string, number>();
    for (const t of trades) {
      const key = t.exitReason.split(':')[0].trim();
      exitReasonCounts.set(key, (exitReasonCounts.get(key) ?? 0) + 1);
    }
    console.log('\nExit reasons:');
    for (const [reason, count] of exitReasonCounts.entries()) {
      console.log(`  ${reason}: ${count}`);
    }

    console.log('\nPer-wallet breakdown (sorted by P&L):');
    const byWallet = new Map<string, ClosedTrade[]>();
    for (const t of trades) {
      const arr = byWallet.get(t.sourceWallet) ?? [];
      arr.push(t);
      byWallet.set(t.sourceWallet, arr);
    }
    const rows = [...byWallet.entries()]
      .map(([wallet, ts]) => {
        const w = ts.filter((t) => t.pnlSol > 0).length;
        const pnl = ts.reduce((s, t) => s + t.pnlSol, 0);
        return { wallet, count: ts.length, winRate: (w / ts.length) * 100, pnl };
      })
      .sort((a, b) => b.pnl - a.pnl);

    for (const r of rows) {
      console.log(
        `  ${short(r.wallet)}   ${r.count} trades   ${r.winRate.toFixed(0)}% win   ${fmtSol(r.pnl)}`
      );
    }
  }

  const open = getOpenPositions();
  console.log('\n' + '-'.repeat(72));
  console.log(`Open positions: ${open.length}`);
  for (const p of open) {
    const heldMin = (Date.now() - p.boughtAt) / 60_000;
    const currentValue = await previewCurrentValue(p.mint, p.tokensAmountRaw);
    const unrealizedStr =
      currentValue === null
        ? 'unable to price right now'
        : `${fmtSol(currentValue - p.entrySolSpent)} (${fmtPct((currentValue / p.entrySolSpent - 1) * 100)}) unrealized`;
    console.log(
      `  ${p.mint.slice(0, 8)}...  from ${short(p.sourceWallet)}  entry ${p.entrySolSpent.toFixed(
        4
      )} SOL  held ${heldMin.toFixed(1)}min  ${unrealizedStr}`
    );
  }
  console.log('='.repeat(72));
}

main().catch((err) => {
  console.error('[report] failed:', err);
  process.exit(1);
});
