import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from './config';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

const connection = new Connection(config.heliusRpcUrl, 'confirmed');

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
  amountRaw: string | number
): Promise<{ quote: any; error?: string }> {
  const url =
    `${config.jupiterApiUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amountRaw}&slippageBps=${config.maxSlippageBps}`;
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

    await connection.confirmTransaction(signature, 'confirmed');
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
  const { quote, error: quoteError } = await getQuote(mint, SOL_MINT, tokensAmountRaw);
  if (!quote) {
    return { dryRun, mint, amountSol: 0, error: quoteError };
  }

  const expectedSol = Number(quote.outAmount) / 1e9;

  if (dryRun) {
    console.log(
      `[executor] DRY RUN — would sell ${tokensAmountRaw} raw units of ${mint} for ~${expectedSol.toFixed(
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

  const signer = getSigner();
  if (!signer) {
    return {
      dryRun: false,
      mint,
      amountSol: expectedSol,
      error: 'no WALLET_PRIVATE_KEY configured for live trading',
    };
  }

  const { signature, error } = await performSwap(quote, signer);
  if (error) {
    return { dryRun: false, mint, amountSol: expectedSol, error };
  }

  console.log(`[executor] LIVE sell executed: ${signature}`);
  return { dryRun: false, mint, amountSol: expectedSol, signature, outAmountRaw: quote.outAmount };
}
