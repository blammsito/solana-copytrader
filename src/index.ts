import { config } from './config';
import { startWalletMonitor, BuySignal } from './walletMonitor';
import { runRiskChecks } from './riskChecks';
import { checkSpendAllowed, recordBuy } from './spendTracker';
import { executeBuy } from './executor';
import { addPosition, hasOpenPosition } from './positionTracker';
import { startExitMonitor } from './exitManager';

console.log('='.repeat(60));
console.log('Solana copy-trading bot starting');
console.log(`Mode: ${config.dryRun ? 'DRY RUN (no real trades)' : 'LIVE — real SOL will be spent'}`);
console.log(`Target wallets: ${config.targetWallets.length}`);
console.log(`Position size: ${config.positionSizeSol} SOL | Daily cap: ${config.dailySpendCapSol} SOL`);
console.log(
  `Exit strategy: take-profit +${(config.takeProfitPct * 100).toFixed(0)}% | ` +
    `stop-loss -${(config.stopLossPct * 100).toFixed(0)}% | ` +
    `max hold ${config.maxHoldMinutes} min`
);
console.log('='.repeat(60));

async function handleSignal(signal: BuySignal) {
  const { mint } = signal;

  if (hasOpenPosition(mint)) {
    console.log(`[index] SKIPPED ${mint}: already holding an open position in this token`);
    return;
  }

  const spendCheck = checkSpendAllowed(mint, config.positionSizeSol);
  if (!spendCheck.allowed) {
    console.log(`[index] SKIPPED ${mint}: ${spendCheck.reason}`);
    return;
  }

  const risk = await runRiskChecks(mint, config.positionSizeSol);
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
}

startWalletMonitor(handleSignal);
startExitMonitor();
