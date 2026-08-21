import { config } from './config';
import { BuySignal } from './walletMonitor';
import { startTrendScanner } from './trendScanner';
import { evaluateConviction } from './conviction';
import { runRiskChecks } from './riskChecks';
import { checkSpendAllowed, recordBuy } from './spendTracker';
import { executeBuy } from './executor';
import { addPosition, hasOpenPosition } from './positionTracker';
import { startExitMonitor } from './exitManager';
import { startControlServer } from './controlServer';
import { notifyBuy } from './notify';
import { getLastTradeForMint } from './tradeLedger';

console.log('='.repeat(60));
console.log('Solana trend-following meme-coin bot starting');
console.log(`Mode: ${config.dryRun ? 'DRY RUN (no real trades)' : 'LIVE — real SOL will be spent'}`);
console.log(
  `Entry strategy: trend scan (GeckoTerminal) — scans Solana's trending pools every ${config.trendScanIntervalSec}s, ` +
    `requires a confirmed +${(config.trendMinGainPct * 100).toFixed(0)}% uptrend then a ` +
    `${(config.trendMinPullbackPct * 100).toFixed(0)}-${(config.trendMaxPullbackPct * 100).toFixed(0)}% pullback off peak (buy-the-dip), ` +
    `min liquidity $${config.trendMinLiquidityUsd}, min 24h volume $${config.trendMinVolume24hUsd}. ` +
    `Brand-new/just-launched tokens are no longer traded — the old launch-momentum strategy (launchMonitor.ts) is disabled.`
);
console.log(
  `Position size: ${config.minPositionSizeSol}-${config.maxPositionSizeSol} SOL (conviction-scaled) | ` +
    `Daily cap: ${config.dailySpendCapSol} SOL`
);
console.log(
  `Exit strategy: take-profit +${(config.takeProfitPct * 100).toFixed(0)}% | ` +
    `stop-loss -${(config.stopLossPct * 100).toFixed(0)}% | ` +
    `max hold ${config.maxHoldMinutes} min`
);
console.log('='.repeat(60));

// Mints currently mid-handleSignal, from the moment a signal comes in to the
// moment a position is persisted (or the attempt is abandoned). Webhook
// providers can redeliver the same event, and a single on-chain transaction
// can trigger more than one detection path — without this guard, two
// concurrent calls for the same mint both pass the hasOpenPosition() check
// (since neither has written a position yet) and both proceed to buy,
// doubling API calls and risking a duplicate spend. This closes that race:
// the set is checked and claimed synchronously, before any `await`, so a
// second concurrent call for the same mint is rejected immediately.
const mintsInFlight = new Set<string>();

async function handleSignal(signal: BuySignal) {
  const { mint } = signal;

  if (mintsInFlight.has(mint)) {
    console.log(`[index] SKIPPED ${mint}: already processing a signal for this token`);
    return;
  }
  mintsInFlight.add(mint);

  try {
    if (hasOpenPosition(mint)) {
      console.log(`[index] SKIPPED ${mint}: already holding an open position in this token`);
      return;
    }

    // Never buy back into a mint we've already lost money on — permanent,
    // not a cooldown. A sideways-chopping token can keep re-qualifying as a
    // fresh trend/momentum signal indefinitely even though it's not really
    // going anywhere; a time-based cooldown just delays the same bleed
    // instead of stopping it. One loss on a mint is enough signal that it's
    // not a good bet — the bot moves on rather than trying it again.
    const lastTrade = getLastTradeForMint(mint);
    if (lastTrade && lastTrade.pnlSol <= 0) {
      console.log(
        `[index] SKIPPED ${mint}: already lost ${lastTrade.pnlSol.toFixed(4)} SOL (${lastTrade.pnlPct.toFixed(1)}%) on ` +
          `this mint previously — permanently excluded from re-entry`
      );
      return;
    }

    const conviction = await evaluateConviction(signal);
    if (!conviction.passed) {
      console.log(`[index] SKIPPED ${mint}: ${conviction.reason}`);
      return;
    }
    const positionSizeSol = conviction.positionSizeSol;
    console.log(
      `[index] conviction for ${mint}: score ${conviction.score.toFixed(2)} → ${positionSizeSol.toFixed(4)} SOL ` +
        `(momentum ${conviction.breakdown.momentum.toFixed(2)}, holderHealth ${conviction.breakdown.holderHealth.toFixed(2)}, ` +
        `washHealth ${conviction.breakdown.washHealth.toFixed(2)}` +
        (conviction.breakdown.creatorPct !== null ? `, creator ${(conviction.breakdown.creatorPct * 100).toFixed(1)}%` : '') +
        (conviction.breakdown.top10Pct !== null ? `, top10 ${(conviction.breakdown.top10Pct * 100).toFixed(1)}%` : '') +
        ')'
    );

    const spendCheck = checkSpendAllowed(mint, positionSizeSol);
    if (!spendCheck.allowed) {
      console.log(`[index] SKIPPED ${mint}: ${spendCheck.reason}`);
      return;
    }

    const risk = await runRiskChecks(mint, positionSizeSol, {
      solSpentLamports: Math.floor(signal.solSpent * 1e9),
      tokensReceivedRaw: signal.tokensReceivedRaw,
    });
    if (!risk.passed) {
      return; // runRiskChecks already logs the reason
    }

    const result = await executeBuy(mint, positionSizeSol);

    if (result.error) {
      console.error(`[index] execution failed for ${mint}: ${result.error}`);
      return;
    }

    // Only count the spend / open a tracked position once we know the buy
    // actually happened (or was dry-run logged, so the full pipeline —
    // including exit monitoring — can still be exercised end-to-end in
    // dry-run testing).
    recordBuy(mint, positionSizeSol);

    if (result.outAmountRaw) {
      addPosition({
        mint,
        sourceWallet: signal.walletAddress,
        entrySolSpent: positionSizeSol,
        tokensAmountRaw: result.outAmountRaw,
        boughtAt: Date.now(),
        buySignature: result.signature,
        dryRun: result.dryRun,
        conviction: {
          score: conviction.score,
          momentum: conviction.breakdown.momentum,
          holderHealth: conviction.breakdown.holderHealth,
          washHealth: conviction.breakdown.washHealth,
          creatorPct: conviction.breakdown.creatorPct,
          top10Pct: conviction.breakdown.top10Pct,
        },
      });
    } else {
      console.warn(
        `[index] bought ${mint} but no output amount was returned — position will not be tracked for auto-exit. Check manually.`
      );
    }

    if (result.dryRun) {
      console.log(`[index] DRY RUN complete for ${mint} — no funds moved.`);
    } else {
      console.log(`[index] LIVE buy complete for ${mint} — sig ${result.signature}`);
    }

    notifyBuy({
      mint,
      sourceWallet: signal.walletAddress,
      solSpent: positionSizeSol,
      signature: result.signature,
      dryRun: result.dryRun,
    });
  } finally {
    mintsInFlight.delete(mint);
  }
}

startTrendScanner(handleSignal);
startExitMonitor();
startControlServer(handleSignal);
