import fs from 'fs';
import path from 'path';
import { config } from './config';

interface Spend {
  timestamp: number;
  amountSol: number;
  mint: string;
}

interface SpendState {
  spends: Spend[];
  recentBuys: Record<string, number>; // mint -> last buy timestamp ms
}

const STATE_PATH = path.resolve(process.cwd(), config.spendStateFile);

function loadState(): SpendState {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      spends: parsed.spends ?? [],
      recentBuys: parsed.recentBuys ?? {},
    };
  } catch {
    return { spends: [], recentBuys: {} };
  }
}

function saveState(state: SpendState) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function pruneOldSpends(state: SpendState): SpendState {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return { ...state, spends: state.spends.filter((s) => s.timestamp >= cutoff) };
}

export function getRolling24hSpend(): number {
  const state = pruneOldSpends(loadState());
  return state.spends.reduce((sum, s) => sum + s.amountSol, 0);
}

export function isDuplicateBuy(mint: string): boolean {
  const state = loadState();
  const last = state.recentBuys[mint];
  if (!last) return false;
  return Date.now() - last < config.duplicateBuyWindowMs;
}

export interface SpendCheckResult {
  allowed: boolean;
  reason?: string;
  currentSpendSol: number;
  capSol: number;
}

/**
 * Checks whether a new buy is allowed under the daily spend cap and
 * duplicate-buy guard, WITHOUT recording it. Call recordBuy() only after
 * the trade actually executes (or is dry-run logged).
 */
export function checkSpendAllowed(mint: string, amountSol: number): SpendCheckResult {
  if (isDuplicateBuy(mint)) {
    return {
      allowed: false,
      reason: `already bought ${mint} within the last ${config.duplicateBuyWindowMs / 60000} min`,
      currentSpendSol: getRolling24hSpend(),
      capSol: config.dailySpendCapSol,
    };
  }

  const currentSpend = getRolling24hSpend();
  if (currentSpend + amountSol > config.dailySpendCapSol) {
    return {
      allowed: false,
      reason: `daily spend cap would be exceeded (${currentSpend.toFixed(4)} + ${amountSol.toFixed(
        4
      )} > ${config.dailySpendCapSol})`,
      currentSpendSol: currentSpend,
      capSol: config.dailySpendCapSol,
    };
  }

  return { allowed: true, currentSpendSol: currentSpend, capSol: config.dailySpendCapSol };
}

export function recordBuy(mint: string, amountSol: number) {
  const state = pruneOldSpends(loadState());
  state.spends.push({ timestamp: Date.now(), amountSol, mint });
  state.recentBuys[mint] = Date.now();
  saveState(state);
}
