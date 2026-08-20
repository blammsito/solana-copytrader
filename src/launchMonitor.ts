import WebSocket from 'ws';
import { config } from './config';
import { BuySignal } from './walletMonitor';

type SignalHandler = (signal: BuySignal) => void | Promise<void>;

const WS_URL = `wss://pumpportal.fun/api/data?api-key=${config.pumpPortalApiKey}`;

interface Candidate {
  mint: string;
  creator: string;
  launchedAt: number;
  buyCount: number;
  volumeSol: number;
  triggered: boolean;
  windowTimer: ReturnType<typeof setTimeout>;
}

/**
 * Watches every new pump.fun launch in real time via PumpPortal's websocket
 * feed and generates a buy signal for tokens that show real early momentum
 * — a burst of buys and SOL volume within seconds of launch — rather than
 * mirroring any specific wallet's trades. Emits the same BuySignal shape
 * walletMonitor.ts used, so it plugs into the exact same downstream
 * pipeline (risk checks, executor, position tracking, exit logic)
 * unchanged.
 *
 * `signal.walletAddress` is repurposed here to carry the token's *creator*
 * wallet rather than a copied wallet — kept for logging/position
 * provenance, not because we're following that wallet's trades.
 * `signal.tokensReceivedRaw` is deliberately left unset: there's no
 * "source wallet's fill price" to compare against in this strategy, so
 * riskChecks.ts's entry-momentum check correctly skips itself.
 */
export function startLaunchMonitor(onSignal: SignalHandler) {
  const candidates = new Map<string, Candidate>();
  let ws: WebSocket | null = null;
  let reconnectDelayMs = 1000;
  let rawMessagesLogged = 0;

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
    console.log(`[launchMonitor] dropped ${mint}: ${reason}`);
  }

  async function trigger(c: Candidate) {
    if (c.triggered) return;
    c.triggered = true;
    clearTimeout(c.windowTimer);
    candidates.delete(c.mint);
    send({ method: 'unsubscribeTokenTrade', keys: [c.mint] });

    const elapsedSec = (Date.now() - c.launchedAt) / 1000;
    console.log(
      `[launchMonitor] MOMENTUM signal: ${c.mint} — ${c.buyCount} buys / ${c.volumeSol.toFixed(3)} SOL ` +
        `within ${elapsedSec.toFixed(1)}s of launch`
    );

    const signal: BuySignal = {
      walletAddress: c.creator,
      mint: c.mint,
      solSpent: c.volumeSol,
      signature: '',
      timestamp: Date.now(),
    };

    try {
      await onSignal(signal);
    } catch (err) {
      console.error(`[launchMonitor] signal handler failed for ${c.mint}`, err);
    }
  }

  function handleNewToken(msg: any) {
    const mint = msg.mint;
    if (!mint || candidates.has(mint)) return;

    if (candidates.size >= config.momentumMaxConcurrent) {
      console.log(
        `[launchMonitor] SKIPPED ${mint}: already tracking ${candidates.size} candidates (max ${config.momentumMaxConcurrent})`
      );
      return;
    }

    const c: Candidate = {
      mint,
      creator: msg.traderPublicKey ?? '',
      launchedAt: Date.now(),
      buyCount: 0,
      volumeSol: 0,
      triggered: false,
      windowTimer: setTimeout(
        () => dropCandidate(mint, `momentum window (${config.momentumWindowSec}s) elapsed without threshold`),
        config.momentumWindowSec * 1000
      ),
    };
    candidates.set(mint, c);
    send({ method: 'subscribeTokenTrade', keys: [mint] });
  }

  function handleTrade(msg: any) {
    const mint = msg.mint;
    if (!mint) return;
    const c = candidates.get(mint);
    if (!c || c.triggered) return;

    // Only buys count toward momentum — sells are the opposite signal and
    // are ignored here (the bot's own exit logic handles selling later).
    if (msg.txType !== 'buy') return;

    c.buyCount += 1;
    c.volumeSol += Number(msg.solAmount ?? 0);

    if (c.buyCount >= config.momentumMinBuys && c.volumeSol >= config.momentumMinVolumeSol) {
      void trigger(c);
    }
  }

  function connect() {
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
      console.log('[launchMonitor] connected to PumpPortal');
      reconnectDelayMs = 1000;
      send({ method: 'subscribeNewToken' });

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
    `[launchMonitor] starting — momentum window ${config.momentumWindowSec}s, ` +
      `threshold ${config.momentumMinBuys} buys + ${config.momentumMinVolumeSol} SOL volume, ` +
      `max ${config.momentumMaxConcurrent} concurrent candidates`
  );
  connect();
}
