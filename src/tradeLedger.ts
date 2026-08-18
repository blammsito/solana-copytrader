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
