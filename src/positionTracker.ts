import fs from 'fs';
import path from 'path';
import { config } from './config';

export interface Position {
  mint: string;
  // Which target wallet's buy triggered this position — needed to attribute
  // realized P&L back to a specific wallet in the performance report.
  sourceWallet: string;
  entrySolSpent: number;
  // Raw (base-unit) token amount received at buy time, as a string to avoid
  // JS number precision issues with large raw amounts.
  tokensAmountRaw: string;
  boughtAt: number; // ms epoch
  buySignature?: string;
  // Whether the BUY that opened this position was a dry-run simulation or a
  // real trade. This is fixed at open time and must be respected for the
  // life of the position, independent of whatever DRY_RUN is set to later —
  // otherwise a position opened while paper-trading gets a real sell attempt
  // fired at it the moment the bot is flipped live, for a token the wallet
  // never actually holds.
  dryRun: boolean;
  // Consecutive exit-check cycles in a row where a sell attempt failed
  // because the wallet's on-chain balance for this mint was confirmed empty
  // (checked directly against the chain) despite this position still being
  // tracked as open. A single empty reading can be transient indexer lag;
  // several in a row is strong evidence the position was already sold and
  // closed outside the normal flow — most likely the process crashed or
  // restarted between a swap landing on-chain and this file being updated
  // to remove it — and can never be sold again. See recordNoBalanceStrike.
  noBalanceStreak?: number;
  // Snapshot of the conviction score that sized this buy (see conviction.ts),
  // carried through to the closed trade record on exit. This is what lets
  // convictionReport.ts empirically check whether the score actually
  // predicts outcomes, instead of the thresholds just being permanent
  // guesses. Optional — positions opened before this field existed, or from
  // a signal source with no conviction data, won't have it.
  conviction?: {
    score: number;
    momentum: number;
    holderHealth: number;
    washHealth: number;
    creatorPct: number | null;
    top10Pct: number | null;
  };
  // Best pnlRatio (currentValue / entrySolSpent) ever observed for this
  // position, persisted so a trailing stop has a peak to trail behind that
  // survives process restarts. 1 = breakeven; undefined is treated as 1 (no
  // peak recorded yet). Reset to 1 after a partial scale-out since the
  // remaining runner's cost basis changes at that point.
  peakPnlRatio?: number;
  // Set once a partial scale-out has sold part of this position (see
  // exitManager.ts). Prevents scaling out twice and switches the remaining
  // runner's downside floor from the fixed stop-loss to breakeven-or-better.
  scaledOut?: boolean;
}

interface PositionsState {
  positions: Position[];
}

const STATE_PATH = path.resolve(process.cwd(), config.positionsStateFile);

function loadState(): PositionsState {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const positions: Position[] = (parsed.positions ?? []).map((p: any) => ({
      // Fail safe: any position persisted before this field existed (or
      // missing it for any other reason) is treated as dry-run so it can
      // never trigger a real sell of a token we don't actually hold.
      dryRun: true,
      ...p,
    }));
    return { positions };
  } catch {
    return { positions: [] };
  }
}

function saveState(state: PositionsState) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function getOpenPositions(): Position[] {
  return loadState().positions;
}

export function hasOpenPosition(mint: string): boolean {
  return loadState().positions.some((p) => p.mint === mint);
}

export function addPosition(position: Position) {
  const state = loadState();
  // Guard against double-tracking the same mint (shouldn't happen given the
  // duplicate-buy guard in spendTracker, but keep this file internally
  // consistent regardless).
  state.positions = state.positions.filter((p) => p.mint !== position.mint);
  state.positions.push(position);
  saveState(state);
}

export function removePosition(mint: string) {
  const state = loadState();
  state.positions = state.positions.filter((p) => p.mint !== mint);
  saveState(state);
}

/**
 * Merges `patch` into a tracked position's stored fields — used by
 * exitManager.ts to persist the running peak pnlRatio (for the trailing
 * stop) and to shrink a position down to its remaining size/cost-basis
 * after a partial scale-out. No-op if the mint isn't currently tracked.
 */
export function updatePosition(mint: string, patch: Partial<Position>) {
  const state = loadState();
  const pos = state.positions.find((p) => p.mint === mint);
  if (!pos) return;
  Object.assign(pos, patch);
  saveState(state);
}

/**
 * Records one more consecutive "confirmed zero on-chain balance" reading for
 * a tracked position and returns the updated streak count. Called by
 * exitManager when a sell attempt fails specifically because the wallet
 * genuinely holds none of the mint right now — as opposed to a quote
 * failure, slippage revert, or other ordinary retry-worthy error.
 *
 * Persisted to disk (not kept in memory) so the streak survives process
 * restarts — otherwise a crash-loop could reset the counter every time and
 * a position that's actually gone forever would never get reconciled.
 */
export function recordNoBalanceStrike(mint: string): number {
  const state = loadState();
  const pos = state.positions.find((p) => p.mint === mint);
  if (!pos) return 0;
  pos.noBalanceStreak = (pos.noBalanceStreak ?? 0) + 1;
  saveState(state);
  return pos.noBalanceStreak;
}
