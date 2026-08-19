import { config } from './config';
import { getOpenPositions, removePosition } from './positionTracker';
import { executeSell } from './executor';
import { recordClosedTrade } from './tradeLedger';

/**
 * Checks every open position and sells it if any exit condition is met:
 *   - take-profit: current value >= entry cost * (1 + TAKE_PROFIT_PCT)
 *   - stop-loss:   current value <= entry cost * (1 - STOP_LOSS_PCT)
 *   - max hold:    position has been open longer than MAX_HOLD_MINUTES
 *
 * "Current value" is computed by asking Jupiter for a real sell quote of the
 * exact held amount, so it already reflects slippage/price impact rather
 * than a naive spot price.
 */
export async function checkExits(): Promise<void> {
  const positions = getOpenPositions();
  if (positions.length === 0) return;

  const now = Date.now();

  for (const pos of positions) {
    const result = await previewSellValue(pos.mint, pos.tokensAmountRaw);

    if (result === null) {
      console.warn(`[exitManager] could not price ${pos.mint} this cycle, skipping`);
      continue;
    }

    const pnlRatio = result / pos.entrySolSpent;
    const holdMs = now - pos.boughtAt;
    const holdMinutes = holdMs / 60_000;

    // Early on, a thin pump.fun pool can swing well past the stop-loss
    // threshold on pure noise (including the impact of our own entry buy)
    // and revert seconds later. Real reversals stay down; noise doesn't —
    // giving stop-loss a short grace period after entry filters out most of
    // the false triggers that were closing positions within 1-2 minutes.
    const stopLossArmed = holdMs >= config.stopLossGraceSec * 1000;

    let reason: string | null = null;
    if (pnlRatio >= 1 + config.takeProfitPct) {
      reason = `take-profit: +${((pnlRatio - 1) * 100).toFixed(1)}%`;
    } else if (stopLossArmed && pnlRatio <= 1 - config.stopLossPct) {
      reason = `stop-loss: ${((pnlRatio - 1) * 100).toFixed(1)}%`;
    } else if (holdMinutes >= config.maxHoldMinutes) {
      reason = `max hold time: ${holdMinutes.toFixed(1)} min (${((pnlRatio - 1) * 100).toFixed(1)}% at exit)`;
    }

    if (!reason) continue;

    console.log(
      `[exitManager] SELLING ${pos.mint}${pos.dryRun ? ' (dry run position)' : ''} — ${reason}. ` +
        `Entry ${pos.entrySolSpent.toFixed(4)} SOL, now worth ~${result.toFixed(4)} SOL`
    );

    const sellResult = await executeSell(pos.mint, pos.tokensAmountRaw, pos.dryRun);
    if (sellResult.error) {
      console.error(`[exitManager] sell failed for ${pos.mint}: ${sellResult.error} — will retry next cycle`);
      continue;
    }

    const exitSolReceived = sellResult.amountSol;
    const pnlSol = exitSolReceived - pos.entrySolSpent;
    const pnlPct = (exitSolReceived / pos.entrySolSpent - 1) * 100;

    recordClosedTrade({
      mint: pos.mint,
      sourceWallet: pos.sourceWallet,
      entrySolSpent: pos.entrySolSpent,
      exitSolReceived,
      pnlSol,
      pnlPct,
      exitReason: reason,
      boughtAt: pos.boughtAt,
      soldAt: now,
      holdMinutes,
      buySignature: pos.buySignature,
      sellSignature: sellResult.signature,
      dryRun: sellResult.dryRun,
    });

    removePosition(pos.mint);
    console.log(
      `[exitManager] closed ${pos.mint}${
        sellResult.dryRun ? ' (dry run)' : ` — sig ${sellResult.signature}`
      } — realized P&L: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`
    );
  }
}

async function previewSellValue(mint: string, tokensAmountRaw: string): Promise<number | null> {
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
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

export function startExitMonitor(): void {
  setInterval(() => {
    checkExits().catch((err) => console.error('[exitManager] error during exit check', err));
  }, config.exitCheckIntervalSec * 1000);

  console.log(
    `[exitManager] monitoring open positions every ${config.exitCheckIntervalSec}s ` +
      `(take-profit +${(config.takeProfitPct * 100).toFixed(0)}%, ` +
      `stop-loss -${(config.stopLossPct * 100).toFixed(0)}%, ` +
      `max hold ${config.maxHoldMinutes} min)`
  );
}
