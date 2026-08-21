import express from 'express';
import { config } from './config';
import { getOpenPositions, holdPosition, releasePosition } from './positionTracker';
import { CONTROL_PAGE_HTML } from './controlPage';
import { BuySignal } from './walletMonitor';

type SignalHandler = (signal: BuySignal) => void | Promise<void>;

/**
 * Small HTTP control API for manually overriding the bot's automatic exit
 * management on a specific position — "I want to keep holding this one
 * regardless of what take-profit/stop-loss/trailing/max-hold would
 * otherwise do." Doesn't pause new buys or touch any other position.
 *
 * Protected by a shared secret (CONTROL_API_SECRET) rather than any real
 * auth scheme, since this is a single-operator bot exposed on Railway's
 * public domain — every request must send it either as a Bearer token
 * (Authorization: Bearer <secret>) or a ?key= query param, whichever's more
 * convenient (a query param is easier to hit from a phone browser; a header
 * is easier from curl/scripts).
 *
 * Endpoints:
 *   GET  /control                   — mobile-friendly HTML control page
 *                                      (controlPage.ts); bookmark/Add to
 *                                      Home Screen the full URL including
 *                                      ?key=... for one-tap access
 *   GET  /positions                 — list open positions (mint, entry cost,
 *                                      bought-at, held/scaledOut/dryRun flags)
 *   POST /positions/:mint/hold      — set held=true; exitManager skips it
 *   POST /positions/:mint/release   — clear held; resumes normal management
 *   POST /signals/trend             — external trend-signal intake (see
 *                                      below) for a helper scanner running
 *                                      off-Railway (e.g. a Cloudflare Worker)
 *                                      that isn't subject to the same
 *                                      shared-IP GeckoTerminal throttling
 */
function checkAuth(req: express.Request, res: express.Response): boolean {
  if (!config.controlApiSecret) {
    res
      .status(503)
      .json({ error: 'CONTROL_API_SECRET is not configured on the server — set it and redeploy to enable this API.' });
    return false;
  }

  const authHeader = req.header('authorization') ?? '';
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
  const provided = bearerMatch ? bearerMatch[1] : String(req.query.key ?? '');

  if (provided !== config.controlApiSecret) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

export function startControlServer(onSignal: SignalHandler): void {
  const app = express();

  // Needed to parse the JSON body on POST /signals/trend below. The
  // hold/release routes don't take a body, so this was never needed until
  // now.
  app.use(express.json());

  // Allows a static HTML control page (opened directly from a phone, not
  // served from this domain) to call these endpoints via fetch(). Safe to
  // leave wide open — every route below is still gated by checkAuth() and
  // the shared secret above; CORS only controls which origins are allowed
  // to read the response, not who can guess the secret.
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
  });

  app.get('/health', (_req, res) => res.status(200).send('ok'));

  // Gated by the same shared-secret check as every other route — a visitor
  // without the correct ?key= gets the standard 401/503 JSON error, never
  // the page itself. This also means the page's own JS never needs the
  // secret hardcoded into it (see controlPage.ts) — it just reads the same
  // ?key= that got it past this check.
  app.get('/control', (req, res) => {
    if (!checkAuth(req, res)) return;
    res.type('html').send(CONTROL_PAGE_HTML);
  });

  app.get('/positions', (req, res) => {
    if (!checkAuth(req, res)) return;
    const positions = getOpenPositions().map((p) => ({
      mint: p.mint,
      entrySolSpent: p.entrySolSpent,
      boughtAt: p.boughtAt,
      dryRun: p.dryRun,
      held: !!p.held,
      scaledOut: !!p.scaledOut,
      peakPnlRatio: p.peakPnlRatio ?? null,
    }));
    res.json({ positions });
  });

  app.post('/positions/:mint/hold', (req, res) => {
    if (!checkAuth(req, res)) return;
    const { mint } = req.params;
    if (!holdPosition(mint)) {
      res.status(404).json({ error: `no open position tracked for ${mint}` });
      return;
    }
    console.log(`[controlServer] ${mint} placed ON HOLD via control API — exitManager will skip it until released`);
    res.json({ mint, held: true });
  });

  app.post('/positions/:mint/release', (req, res) => {
    if (!checkAuth(req, res)) return;
    const { mint } = req.params;
    if (!releasePosition(mint)) {
      res.status(404).json({ error: `no open position tracked for ${mint}` });
      return;
    }
    console.log(`[controlServer] ${mint} RELEASED from hold via control API — exitManager will resume managing it`);
    res.json({ mint, held: false });
  });

  // Intake for a trend signal found by a helper scanner running somewhere
  // that isn't Railway's throttled shared IP (e.g. a Cloudflare Worker on a
  // Cron Trigger, see workers/trend-scout in the repo root for that code).
  // Reuses the exact same BuySignal.trend shape trendScanner.ts produces
  // in-process, so it flows through the identical conviction/risk/execution
  // pipeline (handleSignal in index.ts) — mintsInFlight, hasOpenPosition,
  // the permanent re-entry-loss ban, and every conviction gate all apply
  // exactly as they do to a locally-found signal. Acks immediately and runs
  // onSignal async, same pattern as walletMonitor.ts's webhook, so a slow
  // conviction/risk check (RPC calls) doesn't hold the caller's connection
  // open or risk it timing out and retrying into a duplicate.
  app.post('/signals/trend', (req, res) => {
    if (!checkAuth(req, res)) return;

    const body = req.body ?? {};
    const mint = String(body.mint ?? '');
    const overallGainPct = Number(body.overallGainPct);
    const pullbackFromPeakPct = Number(body.pullbackFromPeakPct);
    const liquidityUsd = Number(body.liquidityUsd);
    const volume24hUsd = Number(body.volume24hUsd);

    if (
      !mint ||
      !Number.isFinite(overallGainPct) ||
      !Number.isFinite(pullbackFromPeakPct) ||
      !Number.isFinite(liquidityUsd) ||
      !Number.isFinite(volume24hUsd)
    ) {
      res.status(400).json({ error: 'expected { mint, overallGainPct, pullbackFromPeakPct, liquidityUsd, volume24hUsd }' });
      return;
    }

    res.json({ accepted: true });

    const signal: BuySignal = {
      walletAddress: 'trend-scanner-worker',
      mint,
      solSpent: 0,
      signature: '',
      timestamp: Date.now(),
      trend: { overallGainPct, pullbackFromPeakPct, liquidityUsd, volume24hUsd, source: 'trend' },
    };
    console.log(`[controlServer] received external trend signal for ${mint} from helper scanner`);
    Promise.resolve(onSignal(signal)).catch((err) =>
      console.error(`[controlServer] handling external trend signal for ${mint} failed`, err)
    );
  });

  app.listen(config.webhookPort, () => {
    console.log(
      `[controlServer] listening on port ${config.webhookPort} ` +
        `(GET /control, GET /positions, POST /positions/:mint/hold, POST /positions/:mint/release, POST /signals/trend)` +
        (config.controlApiSecret ? '' : ' — CONTROL_API_SECRET unset, all requests will be refused')
    );
  });
}
