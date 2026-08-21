import express from 'express';
import { config } from './config';

export interface BuySignal {
  walletAddress: string;
  mint: string;
  solSpent: number; // approx SOL amount spent by the target wallet
  signature: string;
  timestamp: number;
  // Raw (base-unit) amount of the token the source wallet actually received,
  // when Helius reports it. Used to derive the source wallet's effective
  // fill price so we can tell if the price already ran up before our own
  // buy lands (see checkEntryMomentum in riskChecks.ts). Optional because
  // not every tx shape includes it — the momentum check skips itself
  // cleanly when this is missing rather than blocking on data we don't have.
  tokensReceivedRaw?: string;
  // ==== Populated by launchMonitor.ts only — used by conviction.ts to
  // score the entry and size the position. Left undefined for signals from
  // other sources (e.g. a future re-enabled wallet-copy path), which fall
  // back to a neutral/minimum-size conviction treatment. ====
  momentum?: {
    buyCount: number;
    volumeSol: number;
    uniqueBuyers: number;
    // Fraction (0-1) of buy volume in the momentum window that came from
    // wallets which also sold within the same window — see
    // maxRoundTripVolumeSharePct in config.ts.
    roundTripVolumeShare: number;
    // Which of launchMonitor.ts's two detection paths produced this signal
    // — a brand-new pump.fun launch, or a token that already migrated to a
    // real AMM showing fresh renewed momentum. Purely for logging/position
    // provenance; conviction.ts scores both identically.
    source: 'launch' | 'migration';
  };
}

type SignalHandler = (signal: BuySignal) => void | Promise<void>;

const SOL_MINT = 'So11111111111111111111111111111111111111112';

function isTargetWallet(address: string): boolean {
  return config.targetWallets.includes(address);
}

/**
 * Parses a single Helius "enhanced" webhook transaction and extracts a
 * SOL -> SPL token buy performed by one of our target wallets, if present.
 *
 * We deliberately only look for buys (SOL leaving the wallet, a token
 * arriving). Sells are ignored on purpose — exit logic is a separate,
 * not-yet-built decision.
 */
export function extractBuySignal(tx: any): BuySignal | null {
  const walletAddress: string | undefined = tx.feePayer;
  if (!walletAddress || !isTargetWallet(walletAddress)) return null;

  // Helius enhanced webhooks attach a normalized `events.swap` object for
  // DEX/AMM transactions (Jupiter, Raydium, pump.fun bonding curve, etc.)
  const swap = tx.events?.swap;
  if (swap) {
    const nativeInput = swap.nativeInput; // { account, amount } lamports
    const tokenOutputs = swap.tokenOutputs as
      | Array<{
          mint: string;
          userAccount: string;
          rawTokenAmount?: { tokenAmount: string; decimals: number };
        }>
      | undefined;

    if (nativeInput && nativeInput.account === walletAddress && tokenOutputs?.length) {
      const out = tokenOutputs.find((o) => o.userAccount === walletAddress) ?? tokenOutputs[0];
      const lamports = Number(nativeInput.amount ?? 0);
      if (out?.mint && lamports > 0) {
        return {
          walletAddress,
          mint: out.mint,
          solSpent: lamports / 1e9,
          signature: tx.signature,
          timestamp: (tx.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
          tokensReceivedRaw: out.rawTokenAmount?.tokenAmount,
        };
      }
    }
    return null; // has a swap event but it's not a SOL->token buy by this wallet (e.g. a sell)
  }

  // Fallback: infer from raw nativeTransfers + tokenTransfers when Helius
  // doesn't classify the tx as a recognized swap type.
  const nativeTransfers = tx.nativeTransfers ?? [];
  const tokenTransfers = tx.tokenTransfers ?? [];

  const solOut = nativeTransfers.find(
    (t: any) => t.fromUserAccount === walletAddress && t.amount > 0
  );
  const tokenIn = tokenTransfers.find(
    (t: any) => t.toUserAccount === walletAddress && t.mint && t.mint !== SOL_MINT
  );

  if (solOut && tokenIn) {
    return {
      walletAddress,
      mint: tokenIn.mint,
      solSpent: Number(solOut.amount) / 1e9,
      signature: tx.signature,
      timestamp: (tx.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
      tokensReceivedRaw:
        tokenIn.rawTokenAmount?.tokenAmount ??
        (tokenIn.tokenAmount != null && tokenIn.decimals != null
          ? String(Math.round(Number(tokenIn.tokenAmount) * 10 ** tokenIn.decimals))
          : undefined),
    };
  }

  return null;
}

export function startWalletMonitor(onSignal: SignalHandler) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.post('/webhook/helius', async (req, res) => {
    if (config.heliusWebhookSecret) {
      const auth = req.header('Authorization');
      if (auth !== config.heliusWebhookSecret) {
        console.warn('[walletMonitor] rejected webhook: bad auth header');
        res.status(401).send('unauthorized');
        return;
      }
    }

    const txs = Array.isArray(req.body) ? req.body : [req.body];
    res.status(200).send('ok'); // ack immediately, process async

    for (const tx of txs) {
      try {
        const signal = extractBuySignal(tx);
        if (signal) {
          console.log(
            `[walletMonitor] buy signal: ${signal.walletAddress} bought ${signal.mint} for ${signal.solSpent} SOL (sig ${signal.signature})`
          );
          await onSignal(signal);
        }
      } catch (err) {
        console.error('[walletMonitor] failed to process tx from webhook', err);
      }
    }
  });

  app.get('/health', (_req, res) => res.status(200).send('ok'));

  app.listen(config.webhookPort, () => {
    console.log(`[walletMonitor] listening on port ${config.webhookPort} for Helius webhooks`);
    console.log(`[walletMonitor] watching ${config.targetWallets.length} target wallet(s)`);
  });
}
