import { getAllTrades, ClosedTrade } from './tradeLedger';

/**
 * Checks whether the conviction score (and its individual components —
 * momentum, holder health, wash health) actually predicts trade outcomes,
 * using real closed-trade data. This is the feedback loop conviction.ts's
 * thresholds and weights were missing at launch: without it, every knob in
 * that file is a permanent guess instead of something checked against
 * results.
 *
 * Run via `npm run conviction-report`. Needs closed trades with a recorded
 * `conviction` snapshot (see positionTracker.ts / tradeLedger.ts) — trades
 * from before conviction scoring existed, or from a signal source that
 * skipped it, are reported separately and excluded from the bucketed stats
 * so they don't dilute the signal.
 */

interface Bucket {
  label: string;
  trades: ClosedTrade[];
}

function fmtSol(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(4)} SOL`;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function summarizeBucket(label: string, trades: ClosedTrade[]): void {
  if (trades.length === 0) {
    console.log(`  ${label.padEnd(14)} 0 trades`);
    return;
  }
  const wins = trades.filter((t) => t.pnlSol > 0);
  const winRate = (wins.length / trades.length) * 100;
  const avgPnlPct = avg(trades.map((t) => t.pnlPct));
  const totalPnlSol = trades.reduce((s, t) => s + t.pnlSol, 0);
  console.log(
    `  ${label.padEnd(14)} ${String(trades.length).padStart(3)} trades   ` +
      `${winRate.toFixed(0).padStart(3)}% win   avg ${fmtPct(avgPnlPct).padStart(8)}   total ${fmtSol(totalPnlSol)}`
  );
}

async function main() {
  const allTrades = getAllTrades();

  console.log('='.repeat(72));
  console.log('CONVICTION SCORING — OUTCOME REPORT');
  console.log('='.repeat(72));

  const scored = allTrades.filter((t) => t.conviction);
  const unscored = allTrades.filter((t) => !t.conviction);

  if (unscored.length > 0) {
    console.log(
      `\n${unscored.length} closed trade(s) have no conviction snapshot (pre-dates conviction ` +
        `scoring, or came from a signal source without it) — excluded from the stats below.`
    );
  }

  if (scored.length === 0) {
    console.log(
      '\nNo scored trades yet — nothing to analyze until at least one conviction-scored position closes.' +
        '\nThis is expected right after launch-momentum + conviction scoring went live; re-run this once ' +
        'the bot has closed a handful of trades.'
    );
    console.log('='.repeat(72));
    return;
  }

  console.log(`\nScored trades: ${scored.length}`);

  // Bucket by overall conviction score — the number that actually drove
  // position sizing — into quartile-ish bands.
  console.log('\nBy overall conviction score:');
  const scoreBuckets: Bucket[] = [
    { label: '0.00-0.25', trades: scored.filter((t) => t.conviction!.score < 0.25) },
    { label: '0.25-0.50', trades: scored.filter((t) => t.conviction!.score >= 0.25 && t.conviction!.score < 0.5) },
    { label: '0.50-0.75', trades: scored.filter((t) => t.conviction!.score >= 0.5 && t.conviction!.score < 0.75) },
    { label: '0.75-1.00', trades: scored.filter((t) => t.conviction!.score >= 0.75) },
  ];
  for (const b of scoreBuckets) summarizeBucket(b.label, b.trades);

  // Bucket by each individual component to see which one(s) are actually
  // carrying the signal, rather than treating the average as a black box.
  const components: Array<{ name: string; get: (t: ClosedTrade) => number }> = [
    { name: 'momentum', get: (t) => t.conviction!.momentum },
    { name: 'holderHealth', get: (t) => t.conviction!.holderHealth },
    { name: 'washHealth', get: (t) => t.conviction!.washHealth },
  ];

  for (const comp of components) {
    console.log(`\nBy ${comp.name} component:`);
    const buckets: Bucket[] = [
      { label: 'low (<0.33)', trades: scored.filter((t) => comp.get(t) < 0.33) },
      { label: 'mid (0.33-0.66)', trades: scored.filter((t) => comp.get(t) >= 0.33 && comp.get(t) < 0.66) },
      { label: 'high (>=0.66)', trades: scored.filter((t) => comp.get(t) >= 0.66) },
    ];
    for (const b of buckets) summarizeBucket(b.label, b.trades);
  }

  // Winners vs losers, averaged — the fastest way to eyeball whether higher
  // conviction is actually correlated with better outcomes at all.
  const wins = scored.filter((t) => t.pnlSol > 0);
  const losses = scored.filter((t) => t.pnlSol <= 0);
  console.log('\nWinners vs losers — average scores:');
  console.log(
    `  Winners (${wins.length}): score ${avg(wins.map((t) => t.conviction!.score)).toFixed(2)}, ` +
      `momentum ${avg(wins.map((t) => t.conviction!.momentum)).toFixed(2)}, ` +
      `holderHealth ${avg(wins.map((t) => t.conviction!.holderHealth)).toFixed(2)}, ` +
      `washHealth ${avg(wins.map((t) => t.conviction!.washHealth)).toFixed(2)}`
  );
  console.log(
    `  Losers  (${losses.length}): score ${avg(losses.map((t) => t.conviction!.score)).toFixed(2)}, ` +
      `momentum ${avg(losses.map((t) => t.conviction!.momentum)).toFixed(2)}, ` +
      `holderHealth ${avg(losses.map((t) => t.conviction!.holderHealth)).toFixed(2)}, ` +
      `washHealth ${avg(losses.map((t) => t.conviction!.washHealth)).toFixed(2)}`
  );

  // Holder concentration numbers directly (not just the derived health
  // score) — worth seeing the raw creator%/top10% split for wins vs losses
  // too, since the health score compresses both into one number.
  const withCreatorPct = scored.filter((t) => t.conviction!.creatorPct !== null);
  const withTop10Pct = scored.filter((t) => t.conviction!.top10Pct !== null);
  if (withCreatorPct.length > 0 || withTop10Pct.length > 0) {
    console.log('\nRaw concentration numbers (where available):');
    if (withCreatorPct.length > 0) {
      const winnersCreator = withCreatorPct.filter((t) => t.pnlSol > 0);
      const losersCreator = withCreatorPct.filter((t) => t.pnlSol <= 0);
      console.log(
        `  creator% — winners avg ${(avg(winnersCreator.map((t) => t.conviction!.creatorPct!)) * 100).toFixed(1)}%, ` +
          `losers avg ${(avg(losersCreator.map((t) => t.conviction!.creatorPct!)) * 100).toFixed(1)}%`
      );
    }
    if (withTop10Pct.length > 0) {
      const winnersTop10 = withTop10Pct.filter((t) => t.pnlSol > 0);
      const losersTop10 = withTop10Pct.filter((t) => t.pnlSol <= 0);
      console.log(
        `  top10%   — winners avg ${(avg(winnersTop10.map((t) => t.conviction!.top10Pct!)) * 100).toFixed(1)}%, ` +
          `losers avg ${(avg(losersTop10.map((t) => t.conviction!.top10Pct!)) * 100).toFixed(1)}%`
      );
    }
  }

  console.log('\n' + '-'.repeat(72));
  console.log(
    'Read this as a directional check, not statistical proof — sample sizes will be small for a\n' +
      'while. The buckets to watch: does win rate/avg P&L actually climb with conviction score, and\n' +
      'do winners cluster at meaningfully higher scores than losers? If not, the weights in\n' +
      'conviction.ts (or the underlying signals themselves) need rethinking, not just retuning.'
  );
  console.log('='.repeat(72));
}

main().catch((err) => {
  console.error('[convictionReport] failed:', err);
  process.exit(1);
});
