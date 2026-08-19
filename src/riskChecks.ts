import { Connection, PublicKey } from '@solana/web3.js';
import { config } from './config';

const connection = new Connection(config.heliusRpcUrl, 'confirmed');

export interface RiskCheckResult {
  passed: boolean;
  reason?: string;
  details: Record<string, unknown>;
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Fill data from the source wallet's own buy, passed through so the
// momentum check can compare our entry price against theirs.
export interface EntrySignalContext {
  solSpentLamports: number;
  tokensReceivedRaw?: string;
}

function jupiterHeaders(): Record<string, string> {
  return config.jupiterApiKey ? { 'x-api-key': config.jupiterApiKey } : {};
}

async function getQuote(
  inputMint: string,
  outputMint: string,
  amountRaw: string | number
): Promise<{ quote: any; error?: string; status?: number }> {
  const url =
    `${config.jupiterApiUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amountRaw}&slippageBps=${config.maxSlippageBps}&onlyDirectRoutes=false`;
  try {
    const res = await fetch(url, { headers: jupiterHeaders() });
    if (!res.ok) {
      return { quote: null, error: `request failed (${res.status})`, status: res.status };
    }
    const quote = (await res.json()) as any;
    if (!quote || quote.error || !quote.routePlan?.length) {
      return { quote: null, error: 'no route available' };
    }
    return { quote };
  } catch (err) {
    return { quote: null, error: (err as Error).message };
  }
}

/**
 * Checks that mint authority and freeze authority have both been renounced.
 * A live mint authority means the deployer can mint unlimited new supply.
 * A live freeze authority means the deployer can freeze your token account
 * so you can never sell. Either one is disqualifying.
 */
async function checkMintAuthority(mint: string): Promise<RiskCheckResult> {
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    const data = info.value?.data;

    if (!data || typeof data === 'string' || !('parsed' in data)) {
      return { passed: false, reason: 'could not parse mint account', details: {} };
    }

    const parsed = (data as any).parsed;
    const mintAuthority = parsed?.info?.mintAuthority ?? null;
    const freezeAuthority = parsed?.info?.freezeAuthority ?? null;

    if (mintAuthority !== null) {
      return {
        passed: false,
        reason: 'mint authority not renounced',
        details: { mintAuthority },
      };
    }
    if (freezeAuthority !== null) {
      return {
        passed: false,
        reason: 'freeze authority not renounced',
        details: { freezeAuthority },
      };
    }

    return { passed: true, details: { mintAuthority, freezeAuthority } };
  } catch (err) {
    return {
      passed: false,
      reason: `mint authority lookup failed: ${(err as Error).message}`,
      details: {},
    };
  }
}

/**
 * Honeypot check: ask Jupiter for a quote to sell the token back into SOL.
 * If no route exists, the token can be bought but not sold — classic
 * honeypot / no-liquidity-on-the-sell-side pattern. Beyond just "does a
 * route exist," this also rejects routes with excessive price impact —
 * technically sellable but you'd lose most of the value isn't much better
 * than not being sellable at all.
 *
 * Uses a raw test amount of 1,000,000 base units rather than 1 — Jupiter
 * rejects quote requests for dust-sized amounts with a 400, which isn't
 * a honeypot signal, just too small a request.
 */
async function checkSellRoute(mint: string, testAmountRaw = 1_000_000): Promise<RiskCheckResult> {
  const { quote, error } = await getQuote(mint, SOL_MINT, testAmountRaw);

  if (!quote) {
    return {
      passed: false,
      reason: `no sell route available (possible honeypot): ${error}`,
      details: {},
    };
  }

  const sellImpactPct = Number(quote.priceImpactPct ?? 1);
  if (sellImpactPct > config.maxSellPriceImpactPct) {
    return {
      passed: false,
      reason: `sell price impact too high (${(sellImpactPct * 100).toFixed(2)}%, max ${(
        config.maxSellPriceImpactPct * 100
      ).toFixed(1)}%) — technically sellable but not cleanly`,
      details: { sellImpactPct },
    };
  }

  return { passed: true, details: { routeSteps: quote.routePlan.length, sellImpactPct } };
}

/**
 * Liquidity depth check, tightened beyond a single price-impact reading:
 *
 * 1. Reject if buying our actual position size moves price more than
 *    maxPriceImpactPct (default 3%, down from the original 5%).
 * 2. Reject if the pool can't even quote 3x our position size, or if
 *    tripling the size causes a disproportionate jump in impact — both are
 *    signs of thin, easily-manipulated liquidity that might look fine at
 *    our exact size but falls apart under any real pressure (including our
 *    own exit later).
 */
async function checkLiquidityDepth(mint: string, solAmount: number): Promise<RiskCheckResult> {
  const lamports = Math.floor(solAmount * 1e9);

  const { quote: primary, error: primaryError } = await getQuote(SOL_MINT, mint, lamports);
  if (!primary) {
    return { passed: false, reason: `no buy route / liquidity quote available: ${primaryError}`, details: {} };
  }

  const priceImpactPct = Number(primary.priceImpactPct ?? 1);
  if (priceImpactPct > config.maxPriceImpactPct) {
    return {
      passed: false,
      reason: `price impact too high (${(priceImpactPct * 100).toFixed(2)}%, max ${(
        config.maxPriceImpactPct * 100
      ).toFixed(1)}%)`,
      details: { priceImpactPct },
    };
  }

  const scaledLamports = Math.floor(lamports * 3);
  const { quote: scaled } = await getQuote(SOL_MINT, mint, scaledLamports);
  if (!scaled) {
    return {
      passed: false,
      reason: 'liquidity too thin to quote 3x position size',
      details: { priceImpactPct },
    };
  }

  const scaledImpactPct = Number(scaled.priceImpactPct ?? 1);
  const maxScaledImpact = config.maxPriceImpactPct * 2.5;
  if (scaledImpactPct > maxScaledImpact) {
    return {
      passed: false,
      reason: `liquidity depth insufficient (3x size impact ${(scaledImpactPct * 100).toFixed(
        2
      )}%, max ${(maxScaledImpact * 100).toFixed(1)}%)`,
      details: { priceImpactPct, scaledImpactPct },
    };
  }

  return { passed: true, details: { priceImpactPct, scaledImpactPct } };
}

/**
 * Compares our own entry price against the source wallet's fill price for
 * the same mint. Copy-trading has a few seconds of unavoidable latency
 * between the source wallet's on-chain buy and our own — on a fast-moving
 * pump.fun token that's often enough time for the source wallet's own buy
 * to have already spiked the price, which then mean-reverts right after we
 * buy in. That "buying the top" pattern was traced directly to real trades
 * that stopped out within 1-2 minutes. This check estimates how much worse
 * our price is versus theirs and blocks the buy if it's run up too far.
 *
 * Skips itself (passes) rather than blocking whenever it doesn't have
 * enough data to make the comparison — a missing signal isn't evidence of
 * a bad entry, and this check shouldn't be a single point of failure for
 * buys that would otherwise be fine.
 */
async function checkEntryMomentum(
  mint: string,
  positionSizeSol: number,
  signal?: EntrySignalContext
): Promise<RiskCheckResult> {
  if (!signal || !signal.tokensReceivedRaw || signal.tokensReceivedRaw === '0') {
    return { passed: true, details: { skipped: 'no source wallet fill data available' } };
  }

  const lamports = Math.floor(positionSizeSol * 1e9);
  const { quote, error } = await getQuote(SOL_MINT, mint, lamports);
  if (!quote) {
    // Let checkLiquidityDepth be the check that fails the buy on a bad
    // quote — this check only has an opinion when it has a price to compare.
    return { passed: true, details: { skipped: `no quote available: ${error}` } };
  }

  const ourTokensRaw = Number(quote.outAmount);
  if (!ourTokensRaw) {
    return { passed: true, details: { skipped: 'quote returned zero tokens' } };
  }

  // Lamports spent per raw token unit received, computed the same way on
  // both sides — decimals cancel out since it's the same mint, so this
  // ratio is directly comparable without needing to know the token's
  // decimal count.
  const sourcePricePerToken = signal.solSpentLamports / Number(signal.tokensReceivedRaw);
  const ourPricePerToken = lamports / ourTokensRaw;
  const runUpPct = (ourPricePerToken - sourcePricePerToken) / sourcePricePerToken;

  if (runUpPct > config.maxEntryRunUpPct) {
    return {
      passed: false,
      reason: `price already ran up ${(runUpPct * 100).toFixed(1)}% since the source wallet's fill (max allowed ${(
        config.maxEntryRunUpPct * 100
      ).toFixed(0)}%) — likely chasing a spike that already happened`,
      details: { runUpPct, sourcePricePerToken, ourPricePerToken },
    };
  }

  return { passed: true, details: { runUpPct, sourcePricePerToken, ourPricePerToken } };
}

/**
 * Runs all pre-buy checks. Fails closed: any single failure blocks the
 * trade, and any unexpected error is treated as a failure rather than
 * silently passing.
 */
export async function runRiskChecks(
  mint: string,
  positionSizeSol: number,
  signal?: EntrySignalContext
): Promise<{ passed: boolean; results: Record<string, RiskCheckResult> }> {
  const [mintAuthority, sellRoute, liquidity, entryMomentum] = await Promise.all([
    checkMintAuthority(mint),
    checkSellRoute(mint),
    checkLiquidityDepth(mint, positionSizeSol),
    checkEntryMomentum(mint, positionSizeSol, signal),
  ]);

  const results = { mintAuthority, sellRoute, liquidity, entryMomentum };
  const passed = Object.values(results).every((r) => r.passed);

  if (!passed) {
    const failures = Object.entries(results)
      .filter(([, r]) => !r.passed)
      .map(([name, r]) => `${name}: ${r.reason}`)
      .join('; ');
    console.log(`[riskChecks] BLOCKED ${mint} — ${failures}`);
  } else {
    console.log(`[riskChecks] PASSED ${mint}`);
  }

  return { passed, results };
}
