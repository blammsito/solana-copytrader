import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from './config';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
// A growing share of newer pump.fun launches mint under Token-2022
// (transfer-fee-capable tokens) rather than the legacy SPL Token program.
// Checking only the legacy program produced false "wallet holds no tokens"
// errors for any Token-2022 mint, permanently blocking real sells even
// though the wallet genuinely held the balance — this was traced directly
// to real stuck positions (Token-2022 mints) that could never be sold.
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

const connection = new Connection(config.heliusRpcUrl, 'confirmed');

/**
 * Reads the wallet's actual current balance of `mint` directly from the
 * chain. The amount recorded when a position was opened is only ever an
 * estimate from the buy-time quote — real settlement can land lower (price
 * impact between quote and execution, or a transfer tax some pump.fun tokens
 * charge) — so selling against that stale estimate can ask for more than the
 * wallet actually holds, which fails identically on every route. Checks both
 * the legacy SPL Token program and Token-2022, since a mint only ever lives
 * under one of the two and we don't know which ahead of time. Returns null
 * if no token account for this mint exists under either program.
 */
async function getActualTokenBalance(owner: PublicKey, mint: string): Promise<string | null> {
  const mintKey = new PublicKey(mint);
  let total = 0n;
  let foundAny = false;

  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const { value } = await connection.getParsedTokenAccountsByOwner(owner, {
        mint: mintKey,
        programId,
      });
      for (const acc of value) {
        foundAny = true;
        total += BigInt(acc.account.data.parsed.info.tokenAmount.amount);
      }
    } catch {
      // Ignore and try the other program — a lookup failure on one program
      // shouldn't mask a valid balance held under the other.
    }
  }

  if (!foundAny) return null;
  return total.toString();
}

function jupiterHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    ...(config.jupiterApiKey ? { 'x-api-key': config.jupiterApiKey } : {}),
    ...(extra ?? {}),
  };
}

function getSigner(): Keypair | null {
  if (!config.walletPrivateKey) return null;
  return Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey));
}

export interface ExecutionResult {
  dryRun: boolean;
  mint: string;
  amountSol: number;
  signature?: string;
  simulatedQuote?: unknown;
  // Raw (base-unit) amount of the OUTPUT token from the quote, regardless of
  // dry-run/live. For a buy this is tokens received; for a sell it's lamports
  // of SOL received. Used by callers to track/close positions.
  outAmountRaw?: string;
  error?: string;
}

async function getQuote(
  inputMint: string,
  outputMint: string,
  amountRaw: string | number,
  excludeDexes?: string
): Promise<{ quote: any; error?: string }> {
  const url =
    `${config.jupiterApiUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amountRaw}&slippageBps=${config.maxSlippageBps}` +
    (excludeDexes ? `&excludeDexes=${encodeURIComponent(excludeDexes)}` : '');
  try {
    const res = await fetch(url, { headers: jupiterHeaders() });
    if (!res.ok) {
      return { quote: null, error: `quote failed (${res.status})` };
    }
    const quote = (await res.json()) as any;
    if (!quote || quote.error) {
      return { quote: null, error: `quote error: ${quote?.error ?? 'unknown'}` };
    }
    return { quote };
  } catch (err) {
    return { quote: null, error: `quote request failed: ${(err as Error).message}` };
  }
}

async function performSwap(
  quote: any,
  signer: Keypair
): Promise<{ signature?: string; error?: string }> {
  try {
    const swapRes = await fetch(`${config.jupiterApiUrl}/swap`, {
      method: 'POST',
      headers: jupiterHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: signer.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    });

    if (!swapRes.ok) {
      return { error: `swap build failed (${swapRes.status})` };
    }

    const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };
    const txBuf = Buffer.from(swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([signer]);

    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    const { value } = await connection.confirmTransaction(signature, 'confirmed');
    // Landing in a block is not the same as succeeding. A transaction can be
    // included and still revert on-chain (e.g. slippage tolerance exceeded
    // because the price moved between quote and landing, which happens
    // constantly on fast-moving pump.fun tokens) — the network fee is paid
    // but no swap occurs. Treating a reverted-but-landed tx as a success is
    // exactly what caused phantom positions to be tracked for buys that
    // never actually happened. Must check `err` explicitly.
    if (value.err) {
      return {
        error: `transaction landed but reverted on-chain: ${JSON.stringify(value.err)} (sig ${signature})`,
      };
    }
    return { signature };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * Executes (or, in dry-run mode, simulates and logs) a SOL -> token buy
 * of `amountSol` SOL worth of `mint` via the Jupiter Swap API.
 */
export async function executeBuy(mint: string, amountSol: number): Promise<ExecutionResult> {
  const lamports = Math.floor(amountSol * 1e9);

  const { quote, error: quoteError } = await getQuote(SOL_MINT, mint, lamports);
  if (!quote) {
    return { dryRun: config.dryRun, mint, amountSol, error: quoteError };
  }

  if (config.dryRun) {
    console.log(
      `[executor] DRY RUN — would buy ${amountSol} SOL of ${mint}. ` +
        `Quote out amount: ${quote?.outAmount ?? 'unknown'}, price impact: ${
          quote?.priceImpactPct ?? 'unknown'
        }`
    );
    return { dryRun: true, mint, amountSol, simulatedQuote: quote, outAmountRaw: quote.outAmount };
  }

  const signer = getSigner();
  if (!signer) {
    return {
      dryRun: false,
      mint,
      amountSol,
      error: 'no WALLET_PRIVATE_KEY configured for live trading',
    };
  }

  const { signature, error } = await performSwap(quote, signer);
  if (error) {
    return { dryRun: false, mint, amountSol, error };
  }

  console.log(`[executor] LIVE buy executed: ${signature}`);
  return { dryRun: false, mint, amountSol, signature, outAmountRaw: quote.outAmount };
}

/**
 * Executes (or, in dry-run mode, simulates and logs) a token -> SOL sell of
 * `tokensAmountRaw` base units of `mint` via the Jupiter Swap API. Used by
 * the exit manager to close positions on take-profit, stop-loss, or max
 * hold time.
 *
 * `dryRun` is passed explicitly by the caller (reflecting the position's own
 * dryRun flag, not the live `config.dryRun`) so a position opened while
 * paper-trading always gets a simulated exit, even if the bot is later
 * flipped to live — and a real position always gets a real exit, even if the
 * bot is later flipped back to dry-run.
 */
export async function executeSell(
  mint: string,
  tokensAmountRaw: string,
  dryRun: boolean = config.dryRun
): Promise<ExecutionResult> {
  let signer: Keypair | null = null;
  let sellAmountRaw = tokensAmountRaw;

  if (!dryRun) {
    signer = getSigner();
    if (!signer) {
      return {
        dryRun: false,
        mint,
        amountSol: 0,
        error: 'no WALLET_PRIVATE_KEY configured for live trading',
      };
    }

    // The tracked amount is only ever an estimate from the buy-time quote —
    // sell against what the wallet actually holds right now instead, so a
    // lower real settlement (or a transfer tax) can never cause us to ask
    // for more tokens than we have.
    const actualBalance = await getActualTokenBalance(signer.publicKey, mint);
    if (actualBalance === null || actualBalance === '0') {
      return {
        dryRun: false,
        mint,
        amountSol: 0,
        error: `wallet holds no ${mint} tokens to sell right now (tracked amount was ${tokensAmountRaw}) — position may never have actually settled`,
      };
    }
    if (actualBalance !== tokensAmountRaw) {
      console.warn(
        `[executor] tracked sell amount for ${mint} (${tokensAmountRaw}) differs from actual on-chain balance (${actualBalance}) — selling the actual balance`
      );
    }
    sellAmountRaw = actualBalance;
  }

  const { quote, error: quoteError } = await getQuote(mint, SOL_MINT, sellAmountRaw);
  if (!quote) {
    return { dryRun, mint, amountSol: 0, error: quoteError };
  }

  const expectedSol = Number(quote.outAmount) / 1e9;

  if (dryRun) {
    console.log(
      `[executor] DRY RUN — would sell ${sellAmountRaw} raw units of ${mint} for ~${expectedSol.toFixed(
        6
      )} SOL.`
    );
    return {
      dryRun: true,
      mint,
      amountSol: expectedSol,
      simulatedQuote: quote,
      outAmountRaw: quote.outAmount,
    };
  }

  const primaryAttempt = await performSwap(quote, signer!);
  if (!primaryAttempt.error) {
    console.log(`[executor] LIVE sell executed: ${primaryAttempt.signature}`);
    return {
      dryRun: false,
      mint,
      amountSol: expectedSol,
      signature: primaryAttempt.signature,
      outAmountRaw: quote.outAmount,
    };
  }

  // Jupiter's router has a known issue building valid sell transactions
  // against the "Pump.fun Amm" venue specifically for some pools — the quote
  // looks fine but the transaction fails on-chain (getting out is what
  // matters here, not getting the best price), even though selling the same
  // token directly on pump.fun's own site works. If the primary route used
  // that venue, retry once against any other available route before giving
  // up, so a position isn't stuck forever against a single broken route.
  const usedPumpFunAmm = (quote.routePlan ?? []).some(
    (leg: any) => leg?.swapInfo?.label === 'Pump.fun Amm'
  );
  if (!usedPumpFunAmm) {
    return { dryRun: false, mint, amountSol: expectedSol, error: primaryAttempt.error };
  }

  console.warn(
    `[executor] sell via Pump.fun Amm route failed (${primaryAttempt.error}) — retrying with that venue excluded`
  );
  const fallback = await getQuote(mint, SOL_MINT, sellAmountRaw, 'Pump.fun Amm');
  if (!fallback.quote) {
    return {
      dryRun: false,
      mint,
      amountSol: expectedSol,
      error: `primary route failed (${primaryAttempt.error}); fallback quote also failed (${fallback.error})`,
    };
  }

  const fallbackExpectedSol = Number(fallback.quote.outAmount) / 1e9;
  const fallbackAttempt = await performSwap(fallback.quote, signer!);
  if (fallbackAttempt.error) {
    return {
      dryRun: false,
      mint,
      amountSol: expectedSol,
      error: `primary route failed (${primaryAttempt.error}); fallback route also failed (${fallbackAttempt.error})`,
    };
  }

  console.log(
    `[executor] LIVE sell executed via fallback route (Pump.fun Amm excluded): ${fallbackAttempt.signature}`
  );
  return {
    dryRun: false,
    mint,
    amountSol: fallbackExpectedSol,
    signature: fallbackAttempt.signature,
    outAmountRaw: fallback.quote.outAmount,
  };
}
