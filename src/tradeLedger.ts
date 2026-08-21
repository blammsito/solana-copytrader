import fs from 'fs';
import path from 'path';
import { config } from './config';

export interface ClosedTrade {
  mint: string;
  sourceWallet: string;
  entrySolSpent: number;
  exitSolReceived: number;
  pnlSol: number;
  pnlPct: number;
  exitReason: string;
  boughtAt: number;
  soldAt: number;
  holdMinutes: number;
  buySignature?: string;
  sellSignature?: string;
  dryRun: boolean;
  // Carried over from Position.conviction (see positionTracker.ts) — the
  // conviction score/breakdown that sized this trade at entry, so
  // convictionReport.ts can check whether it actually predicted the
  // outcome. Optional for the same reason it's optional on Position.
  conviction?: {
    score: number;
    momentum: number;
    holderHealth: number;
    washHealth: number;
    creatorPct: number | null;
    top10Pct: number | null;
  };
}

interface LedgerState {
  trades: ClosedTrade[];
}

const LEDGER_PATH = path.resolve(process.cwd(), config.tradeLedgerFile);

function loadLedger(): LedgerState {
  try {
    const raw = fs.readFileSync(LEDGER_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return { trades: parsed.trades ?? [] };
  } catch {
    return { trades: [] };
  }
}

function saveLedger(state: LedgerState) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(state, null, 2));
}

/**
 * Appends a closed trade (a completed buy -> sell round trip) to the
 * permanent ledger. This is the source of truth for the performance report
 * — real realized numbers, not on-chain vanity stats from the wallets we're
 * copying.
 */
export function recordClosedTrade(trade: ClosedTrade): void {
  const state = loadLedger();
  state.trades.push(trade);
  saveLedger(state);
}

export function getAllTrades(): ClosedTrade[] {
  return loadLedger().trades;
}

/**
 * Returns the most recently closed trade for a given mint (by soldAt), or
 * null if we've never traded it before. Used by index.ts's re-entry gate to
 * stop the bot from immediately buying back into a mint it just lost money
 * on — without this, a token chopping sideways can get bought, held to
 * max-hold or a stop-loss, sold at a small loss, and then immediately
 * re-qualify as a fresh trend signal and get bought right back into, over
 * and over, bleeding a little more (plus fees/slippage) on every cycle.
 */
export function getLastTradeForMint(mint: string): ClosedTrade | null {
  const trades = getAllTrades().filter((t) => t.mint === mint);
  if (trades.length === 0) return null;
  return trades.reduce((latest, t) => (t.soldAt > latest.soldAt ? t : latest));
}
