import { config } from './config';
import { getOpenPositions, removePosition, recordNoBalanceStrike } from './positionTracker';
import { executeSell } from './executor';
import { recordClosedTrade } from './tradeLedger';

// How many consecutive exit-check cycles a position must show a confirmed
// zero on-chain balance before we give up trying to sell it and drop it
// from tracking. A single empty reading can be transient indexer lag; this
// many in a row (roughly RECONCILE_AFTER_STRIKES * exitCheckIntervalSec) is
// treated as proof the position was already sold and closed outside the
// normal flow and can never be sold again.
const RECONCILE_AFTER_STRIKES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    if (i > 0) await sleep(config.exitCheckStaggerMs);

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
      if (sellResult.confirmedEmpty) {
        const streak = recordNoBalanceStrike(pos.mint);
        if (streak >= RECONCILE_AFTER_STRIKES) {
          console.warn(
            `[exitManager] ${pos.mint} has shown a confirmed zero on-chain balance for ${streak} consecutive ` +
              `checks — treating this as already sold/closed outside the normal flow (most likely the process ` +
              `was interrupted between a swap landing on-chain and this position being removed from tracking) ` +
              `and dropping it now to stop retrying an exit that can never succeed. This trade's P&L was NOT ` +
              `recorded automatically — check trades.json or on-chain history for the real sell signature if ` +
              `you need exact numbers.`
          );
          removePosition(pos.mint);
        } else {
          console.warn(
            `[exitManager] ${pos.mint} shows a confirmed zero on-chain balance (${streak}/${RECONCILE_AFTER_STRIKES} ` +
              `consecutive checks) — will reconcile and drop tracking if this persists`
          );
        }
      } else {
        console.error(`[exitManager] sell failed for ${pos.mint}: ${sellResult.error} — will retry next cycle`);
      }
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
  // setInterval doesn't wait for the previous callback to finish — with
  // several positions, each needing multiple Jupiter/RPC round trips, a
  // cycle can run longer than exitCheckIntervalSec. Without this guard the
  // next tick fires anyway and a second checkExits() runs concurrently
  // against its own stale snapshot of positions.json, which is exactly the
  // kind of overlap that can leave a position's file record out of sync
  // with what actually happened on-chain.
  let running = false;
  setInterval(() => {
    if (running) {
      console.warn('[exitManager] previous exit check still in progress — skipping this tick');
      return;
    }
    running = true;
    checkExits()
      .catch((err) => console.error('[exitManager] error during exit check', err))
      .finally(() => {
        running = false;
      });
  }, config.exitCheckIntervalSec * 1000);

  console.log(
    `[exitManager] monitoring open positions every ${config.exitCheckIntervalSec}s ` +
      `(take-profit +${(config.takeProfitPct * 100).toFixed(0)}%, ` +
      `stop-loss -${(config.stopLossPct * 100).toFixed(0)}%, ` +
      `max hold ${config.maxHoldMinutes} min)`
  );
}
