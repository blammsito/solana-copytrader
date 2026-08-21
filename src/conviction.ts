import { Connection, PublicKey } from '@solana/web3.js';
import { config } from './config';
import { BuySignal } from './walletMonitor';

const connection = new Connection(config.heliusRpcUrl, 'confirmed');

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
// A growing share of pump.fun launches mint under Token-2022 rather than the
// legacy SPL Token program (same fact that forced executor.ts to check both
// programs for balances). getTokenSupply/getTokenLargestAccounts don't
// reliably support Token-2022 mints on every RPC provider — on Helius they
// throw "Invalid param: not a Token mint" for them, which was silently
// disabling the holder-concentration anti-rug check on essentially every
// recent signal. See getMintInfo/getLargestHolderAmounts below for the fix.
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

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
/**
 * Reads a mint's owning token program and total supply via getParsedAccountInfo
 * rather than getTokenSupply — the parsed-account path correctly identifies
 * and decodes both the legacy Token program and Token-2022 mint layouts,
 * where getTokenSupply has proven unreliable for the latter on this RPC.
 */
async function getMintInfo(mintPubkey: PublicKey): Promise<{ programId: PublicKey; supply: number } | null> {
  const info = await connection.getParsedAccountInfo(mintPubkey);
  const data = info.value?.data as any;
  if (!info.value || !data || typeof data !== 'object' || !('parsed' in data)) return null;
  const supply = Number(data.parsed?.info?.supply);
  if (!supply) return null;
  return { programId: info.value.owner, supply };
}

/**
 * Returns the raw token amount held by every account for `mintPubkey`.
 * getTokenLargestAccounts works fine for legacy-Token-program mints, but
 * isn't reliable for Token-2022 ones on this RPC (see the comment above
 * TOKEN_2022_PROGRAM_ID) — for those, enumerate holder accounts directly via
 * getParsedProgramAccounts filtered to this mint. A pump.fun launch is only
 * ever seconds old when this runs, so the holder count here is always small
 * in practice; this isn't the expensive full-token-history scan it would be
 * for an established token.
 */
async function getLargestHolderAmounts(mintPubkey: PublicKey, programId: PublicKey): Promise<number[]> {
  if (programId.equals(TOKEN_PROGRAM_ID)) {
    const largest = await connection.getTokenLargestAccounts(mintPubkey);
    return largest.value.map((a) => Number(a.amount));
  }

  const accounts = await connection.getParsedProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: mintPubkey.toBase58() } }],
  });
  return accounts
    .map((acc) => {
      const parsed = (acc.account.data as any)?.parsed;
      return Number(parsed?.info?.tokenAmount?.amount ?? 0);
    })
    .filter((n) => n > 0);
}

async function checkHolderConcentration(
  mint: string,
  creatorWallet: string
): Promise<{ creatorPct: number | null; top10Pct: number | null; error?: string }> {
  try {
    const mintPubkey = new PublicKey(mint);

    const mintInfo = await getMintInfo(mintPubkey);
    if (!mintInfo) {
      return { creatorPct: null, top10Pct: null, error: 'mint account not found or not parseable' };
    }
    const { programId, supply: totalSupply } = mintInfo;

    const amounts = await getLargestHolderAmounts(mintPubkey, programId);
    const accounts = amounts.sort((a, b) => b - a);
    const top10Pct = accounts.slice(1, 11).reduce((s, v) => s + v, 0) / totalSupply;

    let creatorPct: number | null = null;
    if (creatorWallet) {
      try {
        // Same reasoning as executor.ts's balance checks: query both token
        // programs explicitly rather than relying on a mint-only filter to
        // resolve the right one, since that resolution has proven flaky for
        // Token-2022 accounts on this RPC.
        let creatorBalance = 0;
        for (const pid of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
          const creatorAccounts = await connection.getParsedTokenAccountsByOwner(new PublicKey(creatorWallet), {
            mint: mintPubkey,
            programId: pid,
          });
          for (const acc of creatorAccounts.value) {
            creatorBalance += Number(acc.account.data.parsed.info.tokenAmount.amount);
          }
        }
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

  const { buyCount, volumeSol, uniqueBuyers, roundTripVolumeShare, pullbackFromPeakPct, earlyBurstVolumeSharePct } =
    signal.momentum;

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

  // "Holder-backed" gate: momentumMinBuys alone can be hit by a couple of
  // wallets buying repeatedly (without ever selling, so the round-trip
  // wash-trading check above doesn't catch it). Requiring a minimum spread
  // of distinct buyers is what actually distinguishes broad-based organic
  // demand from a small number of wallets manufacturing the appearance of
  // it. Checked before the RPC-heavy holder-concentration lookup below
  // since it's free — data already on the signal — so a signal that's
  // going to be rejected anyway never costs an RPC round trip.
  if (uniqueBuyers < config.momentumMinUniqueBuyers) {
    return {
      passed: false,
      reason: `only ${uniqueBuyers} unique buyer(s) (min ${config.momentumMinUniqueBuyers}) — momentum looks concentrated in too few wallets to call it real holder-backed demand`,
      positionSizeSol: fallbackSize,
      score: 0,
      breakdown: { momentum: 0, holderHealth: 1, washHealth: 1, creatorPct: null, top10Pct: null },
    };
  }

  // "Buying the top" gate: clearing the buy-count/volume threshold only
  // means enough happened during the window — it says nothing about
  // whether price is still climbing right now. If the token's marketCapSol
  // has already fallen back from its peak-within-the-window by the time we'd
  // buy, the move is already fading and we'd be entering right as it
  // reverses — traced directly to real trades that stopped out within
  // 1-2 minutes of entry (see the live trade-ledger review this gate is a
  // response to: 64% of closed live trades exited via stop-loss). Checked
  // here (free — already computed by launchMonitor.ts) before the
  // RPC-heavy holder-concentration lookup below.
  if (pullbackFromPeakPct > config.maxEntryPullbackFromPeakPct) {
    return {
      passed: false,
      reason: `price already pulled back ${(pullbackFromPeakPct * 100).toFixed(1)}% off its peak within the momentum window (max ${(
        config.maxEntryPullbackFromPeakPct * 100
      ).toFixed(0)}%) — looks like buying a move that's already fading, not one still building`,
      positionSizeSol: fallbackSize,
      score: 0,
      breakdown: { momentum: 0, holderHealth: 1, washHealth: 1, creatorPct: null, top10Pct: null },
    };
  }

  // "Sniper burst" gate: research on Solana memecoin sniping found
  // deployer-funded sniper wallets routinely buy within the same block as
  // a token's creation — seconds before any organic interest could
  // plausibly exist — with one study finding 87% of these same-block
  // snipes profitable, extracted from later buyers. That pattern shows up
  // as buy volume heavily front-loaded into the first few seconds of the
  // window rather than accumulating over it, and it's invisible to the
  // wash-trading and unique-buyer checks above since sniper wallets are
  // usually genuinely distinct addresses that hold (not round-trip) within
  // the window. This is the closest a momentum-reactive bot can get to
  // spotting "we're buying from snipers already in profit."
  if (earlyBurstVolumeSharePct > config.maxEarlyBurstVolumeSharePct) {
    return {
      passed: false,
      reason: `${(earlyBurstVolumeSharePct * 100).toFixed(0)}% of buy volume landed within the first ${
        config.snipeBurstWindowSec
      }s (max ${(config.maxEarlyBurstVolumeSharePct * 100).toFixed(
        0
      )}%) — looks like a same-block sniper buy-in rather than organically building momentum`,
      positionSizeSol: fallbackSize,
      score: 0,
      breakdown: { momentum: 0, holderHealth: 1, washHealth: 1, creatorPct: null, top10Pct: null },
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

  // uniqueBuyers is included here (not just as the hard gate above) so
  // position size itself scales with how broad-based the buying is —
  // a signal with 20 distinct buyers should size up more than one that
  // barely cleared the momentumMinUniqueBuyers floor, all else equal.
  const momentumComponent = clamp01(
    ((buyCount / config.momentumMinBuys - 1) +
      (volumeSol / config.momentumMinVolumeSol - 1) +
      (uniqueBuyers / config.momentumMinUniqueBuyers - 1)) /
      3
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
