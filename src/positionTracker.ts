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
}

interface PositionsState {
  positions: Position[];
}

const STATE_PATH = path.resolve(process.cwd(), config.positionsStateFile);

function loadState(): PositionsState {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return { positions: parsed.positions ?? [] };
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
