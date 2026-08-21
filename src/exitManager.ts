import { config } from './config';
import {
  getOpenPositions,
  removePosition,
  recordNoBalanceStrike,
  updatePosition,
  Position,
} from './positionTracker';
import { executeSell } from './executor';
import { recordClosedTrade } from './tradeLedger';
import { notifySell } from './notify';

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
 * Splits a raw (base-unit) token amount by a fraction using BigInt math
 * throughout, so large raw amounts never lose precision the way a
 * Number-based multiply/divide could. Rounds down (floor) on the sold
 * portion so a scale-out can never accidentally request more than the
 * position actually holds.
 */
function fractionOfRaw(raw: string, fraction: number): string {
  const total = BigInt(raw);
  const bpsFraction = BigInt(Math.round(fraction * 10_000));
  return ((total * bpsFraction) / 10_000n).toString();
}

/**
 * Sells `config.partialScaleOutFraction` of a position once it first
 * reaches `config.partialTakeProfitPct` profit, banking that portion's
 * profit for real instead of leaving the whole position exposed to a
 * reversal while waiting for a bigger move. Records the partial sell as its
 * own closed-trade ledger entry (proportional share of the entry cost) and
 * shrinks the tracked position down to what's left, marking it `scaledOut`
 * so this can only fire once. On failure, logs and returns false — the full
 * position stays intact and every exit check (including a full close) is
 * still evaluated normally next cycle.
 */
async function attemptPartialScaleOut(pos: Position, now: number, pnlRatio: number): Promise<boolean> {
  const sellRaw = fractionOfRaw(pos.tokensAmountRaw, config.partialScaleOutFraction);
  if (sellRaw === '0' || BigInt(sellRaw) >= BigInt(pos.tokensAmountRaw)) return false;

  console.log(
    `[exitManager] SCALING OUT ${pos.mint}${pos.dryRun ? ' (dry run position)' : ''} — ` +
      `partial take-profit +${((pnlRatio - 1) * 100).toFixed(1)}%, selling ` +
      `${(config.partialScaleOutFraction * 100).toFixed(0)}% of the position`
  );

  const sellResult = await executeSell(pos.mint, sellRaw, pos.dryRun, { exactAmount: true });
  if (sellResult.error) {
    console.warn(`[exitManager] partial scale-out for ${pos.mint} failed (${sellResult.error}) — will try again next cycle`);
    return false;
  }

  const remainingRaw = (BigInt(pos.tokensAmountRaw) - BigInt(sellRaw)).toString();
  const soldFraction = Number(sellRaw) / Number(pos.tokensAmountRaw);
  const entryPortion = pos.entrySolSpent * soldFraction;
  const remainingEntry = pos.entrySolSpent - entryPortion;

  const exitSolReceived = sellResult.amountSol;
  const pnlSol = exitSolReceived - entryPortion;
  const pnlPct = entryPortion > 0 ? (exitSolReceived / entryPortion - 1) * 100 : 0;
  const exitReason = `partial take-profit: scaled out ${(config.partialScaleOutFraction * 100).toFixed(0)}% at +${(
    (pnlRatio - 1) *
    100
  ).toFixed(1)}%`;

  recordClosedTrade({
    mint: pos.mint,
    sourceWallet: pos.sourceWallet,
    entrySolSpent: entryPortion,
    exitSolReceived,
    pnlSol,
    pnlPct,
    exitReason,
    boughtAt: pos.boughtAt,
    soldAt: now,
    holdMinutes: (now - pos.boughtAt) / 60_000,
    buySignature: pos.buySignature,
    sellSignature: sellResult.signature,
    dryRun: sellResult.dryRun,
    conviction: pos.conviction,
  });

  updatePosition(pos.mint, {
    tokensAmountRaw: remainingRaw,
    entrySolSpent: remainingEntry,
    scaledOut: true,
    // Reset the trailing-stop peak against the runner's new (smaller) cost
    // basis rather than carrying over a peak computed against the old one.
    peakPnlRatio: 1,
  });

  console.log(
    `[exitManager] scaled out ${pos.mint}${sellResult.dryRun ? ' (dry run)' : ` — sig ${sellResult.signature}`} — ` +
      `realized ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL on the partial (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(
        1
      )}%), letting the remaining ${((1 - config.partialScaleOutFraction) * 100).toFixed(0)}% ride with a breakeven-or-better floor`
  );

  notifySell({
    mint: pos.mint,
    pnlSol,
    pnlPct,
    exitReason,
    signature: sellResult.signature,
    dryRun: sellResult.dryRun,
  });

  return true;
}

/**
 * Checks every open position and sells it if any exit condition is met:
 *   - take-profit:    current value >= entry cost * (1 + TAKE_PROFIT_PCT)
 *   - partial scale-out: banks PARTIAL_SCALE_OUT_FRACTION of the position at
 *     PARTIAL_TAKE_PROFIT_PCT profit; the remainder stays open (see
 *     attemptPartialScaleOut above) rather than fully exiting.
 *   - trailing stop:  once profit has ever reached TRAILING_STOP_ARM_PCT,
 *     the fixed stop-loss stops applying and this fires instead if value
 *     falls back more than TRAILING_STOP_PCT from its peak-ever value.
 *   - stop-loss:      current value <= entry cost * (1 - STOP_LOSS_PCT) —
 *     only while the trailing stop hasn't armed yet.
 *   - max hold:       position has been open longer than MAX_HOLD_MINUTES —
 *     but only while it's never shown real profit (trailing stop never
 *     armed) and was never partially scaled out. A position that's actually
 *     proven itself (armed the trailing stop, or already banked a partial
 *     take-profit) is left to ride and exit only via take-profit/trailing
 *     stop/stop-loss above, instead of getting force-sold — sometimes at a
 *     loss — just because a clock ran out. Max-hold now only exists to cap
 *     how long a genuinely stagnant position (one that never got anywhere)
 *     sits open tying up capital.
 *
 * A position that's already been partially scaled out never uses the fixed
 * stop-loss again — its floor becomes breakeven (or the trailing stop, if
 * that's armed and higher), since the sold portion already locked in real
 * profit and the point of a runner is to not give that back.
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

    // Manual override via the control API (controlServer.ts) — skip this
    // position entirely, before it costs a Jupiter quote call or a stagger
    // delay slot. Overrides every exit condition, including max-hold-time,
    // by design: "held" means the bot's rules don't apply until released.
    if (pos.held) continue;

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

    // Track the best mark-to-market this position has ever shown, persisted
    // so a trailing stop has a real peak to trail behind even across
    // restarts. Never decreases on its own — only a scale-out resets it,
    // since that changes the cost basis the ratio is computed against.
    const peakPnlRatio = Math.max(pos.peakPnlRatio ?? 1, pnlRatio);
    if (peakPnlRatio !== pos.peakPnlRatio) {
      updatePosition(pos.mint, { peakPnlRatio });
    }

    // Bank part of the profit once the first target is hit, instead of an
    // all-or-nothing exit. Only evaluated once per position (scaledOut
    // guards re-triggering) and only when configured.
    if (
      !pos.scaledOut &&
      config.partialScaleOutFraction > 0 &&
      config.partialTakeProfitPct > 0 &&
      pnlRatio >= 1 + config.partialTakeProfitPct
    ) {
      const scaled = await attemptPartialScaleOut(pos, now, pnlRatio);
      if (scaled) continue; // re-price the smaller remaining position next cycle
    }

    const trailingArmed = peakPnlRatio >= 1 + config.trailingStopArmPct;
    const trailingFloor = trailingArmed ? peakPnlRatio * (1 - config.trailingStopPct) : null;

    let floorRatio: number | null = null;
    let floorLabel = '';
    if (pos.scaledOut) {
      // Already banked real profit on the sold portion — never let the
      // remaining runner close below its own breakeven, but still let a
      // trailing stop lock in more if it ran further from here.
      floorRatio = trailingFloor !== null ? Math.max(1, trailingFloor) : 1;
      floorLabel = trailingFloor !== null && trailingFloor > 1 ? 'trailing stop (runner)' : 'breakeven floor (runner)';
    } else if (trailingArmed) {
      floorRatio = trailingFloor;
      floorLabel = 'trailing stop';
    } else if (stopLossArmed) {
      floorRatio = 1 - config.stopLossPct;
      floorLabel = 'stop-loss';
    }

    let reason: string | null = null;
    if (pnlRatio >= 1 + config.takeProfitPct) {
      reason = `take-profit: +${((pnlRatio - 1) * 100).toFixed(1)}%`;
    } else if (floorRatio !== null && pnlRatio <= floorRatio) {
      reason = `${floorLabel}: ${((pnlRatio - 1) * 100).toFixed(1)}% (peak was +${((peakPnlRatio - 1) * 100).toFixed(1)}%)`;
    } else if (holdMinutes >= config.maxHoldMinutes && !trailingArmed && !pos.scaledOut) {
      // Only force-close on time if this position never proved itself —
      // never reached trailingStopArmPct profit and was never scaled out.
      // Once it has, trailingArmed/scaledOut being true routes it through
      // the floorRatio branch above instead: it keeps riding and only exits
      // when it actually pulls back, not because 60 minutes happened to
      // pass while it was sitting on a real gain.
      reason = `max hold time: ${holdMinutes.toFixed(1)} min (${((pnlRatio - 1) * 100).toFixed(1)}% at exit, never armed trailing stop)`;
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
      conviction: pos.conviction,
    });

    removePosition(pos.mint);
    console.log(
      `[exitManager] closed ${pos.mint}${
        sellResult.dryRun ? ' (dry run)' : ` — sig ${sellResult.signature}`
      } — realized P&L: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`
    );

    notifySell({
      mint: pos.mint,
      pnlSol,
      pnlPct,
      exitReason: reason,
      signature: sellResult.signature,
      dryRun: sellResult.dryRun,
    });
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

  const scaleOutNote =
    config.partialScaleOutFraction > 0 && config.partialTakeProfitPct > 0
      ? `, scale out ${(config.partialScaleOutFraction * 100).toFixed(0)}% at +${(
          config.partialTakeProfitPct * 100
        ).toFixed(0)}%`
      : '';
  console.log(
    `[exitManager] monitoring open positions every ${config.exitCheckIntervalSec}s ` +
      `(take-profit +${(config.takeProfitPct * 100).toFixed(0)}%, ` +
      `stop-loss -${(config.stopLossPct * 100).toFixed(0)}% until +${(config.trailingStopArmPct * 100).toFixed(0)}% ` +
      `then trailing -${(config.trailingStopPct * 100).toFixed(0)}% from peak${scaleOutNote}, ` +
      `max hold ${config.maxHoldMinutes} min for positions that never armed the trailing stop)`
  );
}
