import { Connection, PublicKey } from '@solana/web3.js';
import { config } from './config';
import { BuySignal } from './walletMonitor';

const connection = new Connection(config.heliusRpcUrl, 'confirmed');

export interface ConvictionResult {
  passed: boolean;
  reason?: string;
  positionSizeSol: number;
  score: number; // 0..1 overall conviction
  breakdown: {
    momentum: number;
    holderHealth: number;
    washHealth: number;
    creatorPct: number | null;
    top10Pct: number | null;
  };
}

/**
 * Checks how concentrated a token's holdings are.
 *
 * creatorPct: what fraction of total supply the token's creator wallet
 * holds directly. Widely cited as one of the strongest rug indicators —
 * a creator sitting on a large personal stash outside the bonding curve
 * can dump on buyers at will.
 *
 * top10Pct: fraction of total supply held by the largest holders, EXCLUDING
 * the single largest account. Pre-migration, the single largest holder is
 * almost always the bonding curve program's own reserve (the
 * not-yet-sold supply), not a real actor — including it would make nearly
 * every fresh token look ~100% concentrated and make this check useless.
 * This is a heuristic approximation, not a precise "real holders" figure.
 */
async function checkHolderConcentration(
  mint: string,
  creatorWallet: string
): Promise<{ creatorPct: number | null; top10Pct: number | null; error?: string }> {
  try {
    const mintPubkey = new PublicKey(mint);

    const [supplyInfo, largest] = await Promise.all([
      connection.getTokenSupply(mintPubkey),
      connection.getTokenLargestAccounts(mintPubkey),
    ]);

    const totalSupply = Number(supplyInfo.value.amount);
    if (!totalSupply) {
      return { creatorPct: null, top10Pct: null, error: 'zero or unavailable total supply' };
    }

    const accounts = largest.value
      .map((a) => Number(a.amount))
      .sort((a, b) => b - a);
    const top10Pct = accounts.slice(1, 11).reduce((s, v) => s + v, 0) / totalSupply;

    let creatorPct: number | null = null;
    if (creatorWallet) {
      try {
        const creatorAccounts = await connection.getTokenAccountsByOwner(new PublicKey(creatorWallet), {
          mint: mintPubkey,
        });
        const creatorBalance = creatorAccounts.value.reduce((sum, acc) => {
          // Raw SPL token account layout: amount is a u64 at byte offset 64.
          const amount = acc.account.data.readBigUInt64LE(64);
          return sum + Number(amount);
        }, 0);
        creatorPct = creatorBalance / totalSupply;
      } catch (err) {
        console.warn(`[conviction] creator balance lookup failed for ${mint}: ${(err as Error).message}`);
      }
    }

    return { creatorPct, top10Pct };
  } catch (err) {
    return { creatorPct: null, top10Pct: null, error: (err as Error).message };
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Scores a momentum-triggered entry signal and decides how much SOL to buy
 * with, or whether to skip it entirely.
 *
 * Two hard-reject gates run first, independent of everything else:
 * creator/top-holder concentration beyond config caps, and buy volume that's
 * mostly round-tripping (wash-trading) wallets. Anything that clears both
 * gates gets a continuous 0..1 conviction score — the average of three
 * components (momentum strength past the entry threshold, holder-
 * concentration health, wash-trading health) — which linearly scales
 * position size between minPositionSizeSol and maxPositionSizeSol.
 *
 * This is a heuristic, not a guarantee: pump.fun launches are adversarial —
 * the same volume/momentum signal this bot buys on is also what wash-trading
 * bots fabricate to look organic — and the vast majority of tokens on the
 * platform trend toward zero regardless of these checks. Treat this as
 * tilting the odds, not removing the risk.
 */
export async function evaluateConviction(signal: BuySignal): Promise<ConvictionResult> {
  const fallbackSize = config.minPositionSizeSol;

  if (!signal.momentum) {
    // Signal came from a path that doesn't provide momentum/wash data
    // (e.g. a future re-enabled wallet-copy source) — fall back to the
    // floor size rather than guessing, and skip the checks that need it.
    return {
      passed: true,
      positionSizeSol: fallbackSize,
      score: 0,
      breakdown: { momentum: 0, holderHealth: 1, washHealth: 1, creatorPct: null, top10Pct: null },
    };
  }

  const { buyCount, volumeSol, roundTripVolumeShare } = signal.momentum;

  if (roundTripVolumeShare > config.maxRoundTripVolumeSharePct) {
    return {
      passed: false,
      reason: `${(roundTripVolumeShare * 100).toFixed(0)}% of buy volume is round-tripping wallets (max ${(
        config.maxRoundTripVolumeSharePct * 100
      ).toFixed(0)}%) — looks like wash trading, not organic demand`,
      positionSizeSol: fallbackSize,
      score: 0,
      breakdown: { momentum: 0, holderHealth: 1, washHealth: 0, creatorPct: null, top10Pct: null },
    };
  }

  const { creatorPct, top10Pct, error } = await checkHolderConcentration(signal.mint, signal.walletAddress);

  if (creatorPct !== null && creatorPct > config.maxCreatorHoldingPct) {
    return {
      passed: false,
      reason: `creator wallet holds ${(creatorPct * 100).toFixed(1)}% of supply (max ${(
        config.maxCreatorHoldingPct * 100
      ).toFixed(1)}%) — outsized dump risk`,
      positionSizeSol: fallbackSize,
      score: 0,
      breakdown: { momentum: 0, holderHealth: 0, washHealth: 1, creatorPct, top10Pct },
    };
  }

  if (top10Pct !== null && top10Pct > config.maxTopHolderConcentrationPct) {
    return {
      passed: false,
      reason: `top holders (excl. bonding curve reserve) hold ${(top10Pct * 100).toFixed(1)}% of supply (max ${(
        config.maxTopHolderConcentrationPct * 100
      ).toFixed(1)}%) — structural dump risk`,
      positionSizeSol: fallbackSize,
      score: 0,
      breakdown: { momentum: 0, holderHealth: 0, washHealth: 1, creatorPct, top10Pct },
    };
  }

  if (error) {
    console.warn(`[conviction] holder-concentration check unavailable for ${signal.mint}: ${error} — proceeding without it`);
  }

  const momentumComponent = clamp01(
    ((buyCount / config.momentumMinBuys - 1) + (volumeSol / config.momentumMinVolumeSol - 1)) / 2
  );
  const holderHealthComponent =
    creatorPct === null && top10Pct === null
      ? 0.5 // no data either way — neutral, don't reward or punish
      : 1 -
        clamp01((creatorPct ?? 0) / config.maxCreatorHoldingPct) * 0.5 -
        clamp01((top10Pct ?? 0) / config.maxTopHolderConcentrationPct) * 0.5;
  const washHealthComponent = 1 - clamp01(roundTripVolumeShare / config.maxRoundTripVolumeSharePct);

  const score = clamp01((momentumComponent + holderHealthComponent + washHealthComponent) / 3);
  const positionSizeSol =
    config.minPositionSizeSol + score * (config.maxPositionSizeSol - config.minPositionSizeSol);

  return {
    passed: true,
    positionSizeSol,
    score,
    breakdown: { momentum: momentumComponent, holderHealth: holderHealthComponent, washHealth: washHealthComponent, creatorPct, top10Pct },
  };
}
