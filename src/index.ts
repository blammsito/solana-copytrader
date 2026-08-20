import { config } from './config';
import { BuySignal } from './walletMonitor';
import { startLaunchMonitor } from './launchMonitor';
import { runRiskChecks } from './riskChecks';
import { checkSpendAllowed, recordBuy } from './spendTracker';
import { executeBuy } from './executor';
import { addPosition, hasOpenPosition } from './positionTracker';
import { startExitMonitor } from './exitManager';
import { notifyBuy } from './notify';

console.log('='.repeat(60));
console.log('Solana momentum-sniper bot starting');
console.log(`Mode: ${config.dryRun ? 'DRY RUN (no real trades)' : 'LIVE — real SOL will be spent'}`);
console.log(
  `Entry strategy: pump.fun launch momentum — ${config.momentumMinBuys} buys + ` +
    `${config.momentumMinVolumeSol} SOL within ${config.momentumWindowSec}s of launch`
);
console.log(`Position size: ${config.positionSizeSol} SOL | Daily cap: ${config.dailySpendCapSol} SOL`);
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

    const spendCheck = checkSpendAllowed(mint, config.positionSizeSol);
    if (!spendCheck.allowed) {
      console.log(`[index] SKIPPED ${mint}: ${spendCheck.reason}`);
      return;
    }

    const risk = await runRiskChecks(mint, config.positionSizeSol, {
      solSpentLamports: Math.floor(signal.solSpent * 1e9),
      tokensReceivedRaw: signal.tokensReceivedRaw,
    });
    if (!risk.passed) {
      return; // runRiskChecks already logs the reason
    }

    const result = await executeBuy(mint, config.positionSizeSol);

    if (result.error) {
      console.error(`[index] execution failed for ${mint}: ${result.error}`);
      return;
    }

    // Only count the spend / open a tracked position once we know the buy
    // actually happened (or was dry-run logged, so the full pipeline —
    // including exit monitoring — can still be exercised end-to-end in
    // dry-run testing).
    recordBuy(mint, config.positionSizeSol);

    if (result.outAmountRaw) {
      addPosition({
        mint,
        sourceWallet: signal.walletAddress,
        entrySolSpent: config.positionSizeSol,
        tokensAmountRaw: result.outAmountRaw,
        boughtAt: Date.now(),
        buySignature: result.signature,
        dryRun: result.dryRun,
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
      solSpent: config.positionSizeSol,
      signature: result.signature,
      dryRun: result.dryRun,
    });
  } finally {
    mintsInFlight.delete(mint);
  }
}

startLaunchMonitor(handleSignal);
startExitMonitor();
