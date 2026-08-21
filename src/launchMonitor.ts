import WebSocket from 'ws';
import { config } from './config';
import { BuySignal } from './walletMonitor';

type SignalHandler = (signal: BuySignal) => void | Promise<void>;
type Source = 'launch' | 'migration';

const WS_URL = `wss://pumpportal.fun/api/data?api-key=${config.pumpPortalApiKey}`;

interface WalletActivity {
  buys: number;
  sells: number;
  buyVolumeSol: number;
}

interface Candidate {
  mint: string;
  source: Source;
  creator: string;
  startedAt: number;
  buyCount: number;
  volumeSol: number;
  triggered: boolean;
  windowTimer: ReturnType<typeof setTimeout>;
  // Per-wallet buy/sell activity within the window, keyed by trader
  // pubkey — used at trigger time to compute unique buyer count and the
  // round-trip (buy-then-sell-same-wallet) wash-trading signal.
  wallets: Map<string, WalletActivity>;
}

interface Thresholds {
  windowSec: number;
  minBuys: number;
  minVolumeSol: number;
  maxConcurrent: number;
}

function thresholdsFor(source: Source): Thresholds {
  return source === 'launch'
    ? {
        windowSec: config.momentumWindowSec,
        minBuys: config.momentumMinBuys,
        minVolumeSol: config.momentumMinVolumeSol,
        maxConcurrent: config.momentumMaxConcurrent,
      }
    : {
        windowSec: config.stableMomentumWindowSec,
        minBuys: config.stableMomentumMinBuys,
        minVolumeSol: config.stableMomentumMinVolumeSol,
        maxConcurrent: config.stableMaxConcurrent,
      };
}

/**
 * Watches pump.fun in real time via a single PumpPortal websocket connection
 * (per PumpPortal's own guidance: one connection, many subscriptions — not
 * one connection per thing being watched) and generates buy signals from two
 * independent sources, both feeding the same downstream pipeline (conviction
 * scoring, risk checks, executor, position tracking, exit logic) unchanged:
 *
 *  1. "launch" — a brand-new token, seconds old, showing a burst of buys and
 *     SOL volume (subscribeNewToken + subscribeTokenTrade).
 *  2. "migration" — a token that already migrated off the bonding curve to a
 *     real AMM (subscribeMigration) — proof it raised enough genuine buy
 *     pressure to graduate — then shows a fresh burst of renewed momentum on
 *     that now-real pool. Looser per-signal thresholds and a longer window
 *     than "launch" (see stableMomentum* in config.ts), since a migrated
 *     pool's baseline activity is bigger and less frantic than a token's
 *     first seconds.
 *
 * `signal.walletAddress` is repurposed to carry the token's *creator* wallet
 * (when known) rather than a copied wallet — kept for logging/position
 * provenance, not because we're following that wallet's trades.
 * `signal.tokensReceivedRaw` is deliberately left unset: there's no "source
 * wallet's fill price" to compare against in this strategy, so
 * riskChecks.ts's entry-momentum check correctly skips itself.
 */
export function startLaunchMonitor(onSignal: SignalHandler) {
  if (!config.pumpPortalApiKey) {
    throw new Error(
      'PUMPPORTAL_API_KEY is not set — the bot has no entry signal source without it. ' +
        'Get a free API key at https://pumpportal.fun and set it before starting the bot ' +
        '(standalone scripts like report.ts don\'t need this — only the live bot does).'
    );
  }

  const candidates = new Map<string, Candidate>();
  let ws: WebSocket | null = null;
  let reconnectDelayMs = 1000;
  let rawMessagesLogged = 0;
  let unrecognizedMessagesLogged = 0;

  function countBySource(source: Source): number {
    let n = 0;
    for (const c of candidates.values()) if (c.source === source) n += 1;
    return n;
  }

  function send(payload: unknown) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function dropCandidate(mint: string, reason: string) {
    const c = candidates.get(mint);
    if (!c) return;
    clearTimeout(c.windowTimer);
    candidates.delete(mint);
    send({ method: 'unsubscribeTokenTrade', keys: [mint] });
    console.log(`[launchMonitor] dropped ${mint} (${c.source}): ${reason}`);
  }

  async function trigger(c: Candidate) {
    if (c.triggered) return;
    c.triggered = true;
    clearTimeout(c.windowTimer);
    candidates.delete(c.mint);
    send({ method: 'unsubscribeTokenTrade', keys: [c.mint] });

    const elapsedSec = (Date.now() - c.startedAt) / 1000;

    let uniqueBuyers = 0;
    let roundTripVolumeSol = 0;
    for (const activity of c.wallets.values()) {
      if (activity.buys > 0) uniqueBuyers += 1;
      if (activity.buys > 0 && activity.sells > 0) roundTripVolumeSol += activity.buyVolumeSol;
    }
    const roundTripVolumeShare = c.volumeSol > 0 ? roundTripVolumeSol / c.volumeSol : 0;

    console.log(
      `[launchMonitor] MOMENTUM signal (${c.source}): ${c.mint} — ${c.buyCount} buys / ${c.volumeSol.toFixed(3)} SOL / ` +
        `${uniqueBuyers} unique buyers / ${(roundTripVolumeShare * 100).toFixed(0)}% round-trip volume ` +
        `within ${elapsedSec.toFixed(1)}s of ${c.source === 'launch' ? 'launch' : 'migration'}`
    );

    const signal: BuySignal = {
      walletAddress: c.creator,
      mint: c.mint,
      solSpent: c.volumeSol,
      signature: '',
      timestamp: Date.now(),
      momentum: {
        buyCount: c.buyCount,
        volumeSol: c.volumeSol,
        uniqueBuyers,
        roundTripVolumeShare,
        source: c.source,
      },
    };

    try {
      await onSignal(signal);
    } catch (err) {
      console.error(`[launchMonitor] signal handler failed for ${c.mint}`, err);
    }
  }

  function startTracking(mint: string, creator: string, source: Source) {
    if (candidates.has(mint)) return;

    const t = thresholdsFor(source);
    if (countBySource(source) >= t.maxConcurrent) {
      console.log(
        `[launchMonitor] SKIPPED ${mint} (${source}): already tracking ${countBySource(source)} ${source} candidates (max ${t.maxConcurrent})`
      );
      return;
    }

    const c: Candidate = {
      mint,
      source,
      creator,
      startedAt: Date.now(),
      buyCount: 0,
      volumeSol: 0,
      triggered: false,
      wallets: new Map(),
      windowTimer: setTimeout(
        () => dropCandidate(mint, `momentum window (${t.windowSec}s) elapsed without threshold`),
        t.windowSec * 1000
      ),
    };
    candidates.set(mint, c);
    send({ method: 'subscribeTokenTrade', keys: [mint] });
  }

  function handleNewToken(msg: any) {
    const mint = msg.mint;
    if (!mint) return;
    startTracking(mint, msg.traderPublicKey ?? '', 'launch');
  }

  /**
   * Field names here are a best-effort guess: PumpPortal's docs confirm
   * `subscribeMigration` exists and is free, but don't publish a sample
   * payload shape. Mirrors the `mint` field convention used consistently by
   * their `create`/`buy`/`sell` events. Any message that doesn't match a
   * known txType gets logged (see the unrecognized-message handling in the
   * websocket 'message' listener below) specifically so the real shape is
   * visible in production logs and this can be corrected quickly if the
   * field names turn out wrong, without guessing further.
   */
  function handleMigration(msg: any) {
    const mint = msg.mint;
    if (!mint) {
      console.warn(`[launchMonitor] migration event had no recognizable mint field: ${JSON.stringify(msg).slice(0, 300)}`);
      return;
    }
    startTracking(mint, msg.traderPublicKey ?? msg.creator ?? '', 'migration');
  }

  function handleTrade(msg: any) {
    const mint = msg.mint;
    const trader = msg.traderPublicKey;
    if (!mint) return;
    const c = candidates.get(mint);
    if (!c || c.triggered) return;

    if (msg.txType === 'sell') {
      // Sells don't count toward momentum (the bot's own exit logic
      // handles selling later), but we still track them per-wallet so a
      // buy-then-sell-same-wallet round trip can be detected as a
      // wash-trading signal — see trigger()'s roundTripVolumeSol calc.
      if (trader) {
        const activity = c.wallets.get(trader) ?? { buys: 0, sells: 0, buyVolumeSol: 0 };
        activity.sells += 1;
        c.wallets.set(trader, activity);
      }
      return;
    }

    if (msg.txType !== 'buy') return;

    const solAmount = Number(msg.solAmount ?? 0);
    c.buyCount += 1;
    c.volumeSol += solAmount;

    if (trader) {
      const activity = c.wallets.get(trader) ?? { buys: 0, sells: 0, buyVolumeSol: 0 };
      activity.buys += 1;
      activity.buyVolumeSol += solAmount;
      c.wallets.set(trader, activity);
    }

    const t = thresholdsFor(c.source);
    if (c.buyCount >= t.minBuys && c.volumeSol >= t.minVolumeSol) {
      void trigger(c);
    }
  }

  function connect() {
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
      console.log('[launchMonitor] connected to PumpPortal');
      reconnectDelayMs = 1000;
      send({ method: 'subscribeNewToken' });
      send({ method: 'subscribeMigration' });

      // A reconnect means we missed however many trade events happened
      // during the gap — any in-progress candidate's buy/volume count is
      // now unreliable, so start fresh rather than risk under-counting and
      // never triggering, or over-counting off a stale window.
      for (const mint of [...candidates.keys()]) dropCandidate(mint, 'connection reset');
    });

    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Log the first few raw messages so the actual PumpPortal payload
      // shape is visible in production logs — useful for a quick sanity
      // check without needing another deploy if field names ever shift.
      if (rawMessagesLogged < 5) {
        rawMessagesLogged += 1;
        console.log(`[launchMonitor] sample message: ${raw.toString().slice(0, 500)}`);
      }

      if (msg.txType === 'create') {
        handleNewToken(msg);
      } else if (msg.txType === 'buy' || msg.txType === 'sell') {
        handleTrade(msg);
      } else if (msg.txType === 'migrate' || msg.txType === 'migration') {
        handleMigration(msg);
      } else if (unrecognizedMessagesLogged < 5) {
        // Catches migration events if PumpPortal uses a txType value other
        // than 'migrate'/'migration' (or no txType at all) — logged
        // separately and unconditionally (not gated by rawMessagesLogged,
        // which the much-higher-volume create/trade events exhaust almost
        // immediately) so the real shape is actually visible after deploy.
        unrecognizedMessagesLogged += 1;
        console.log(`[launchMonitor] unrecognized message shape (possible migration event?): ${raw.toString().slice(0, 500)}`);
      }
    });

    ws.on('close', () => {
      console.warn(`[launchMonitor] disconnected — reconnecting in ${reconnectDelayMs}ms`);
      setTimeout(connect, reconnectDelayMs);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
    });

    ws.on('error', (err) => {
      console.error('[launchMonitor] websocket error:', (err as Error).message);
    });
  }

  console.log(
    `[launchMonitor] starting — launch: window ${config.momentumWindowSec}s, threshold ${config.momentumMinBuys} buys + ` +
      `${config.momentumMinVolumeSol} SOL, max ${config.momentumMaxConcurrent} candidates | ` +
      `migration: window ${config.stableMomentumWindowSec}s, threshold ${config.stableMomentumMinBuys} buys + ` +
      `${config.stableMomentumMinVolumeSol} SOL, max ${config.stableMaxConcurrent} candidates`
  );
  connect();
}
