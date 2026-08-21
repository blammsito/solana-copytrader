import express from 'express';
import { config } from './config';
import { getOpenPositions, holdPosition, releasePosition } from './positionTracker';
import { CONTROL_PAGE_HTML } from './controlPage';

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

export function startControlServer(): void {
  const app = express();

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

  app.listen(config.webhookPort, () => {
    console.log(
      `[controlServer] listening on port ${config.webhookPort} ` +
        `(GET /control, GET /positions, POST /positions/:mint/hold, POST /positions/:mint/release)` +
        (config.controlApiSecret ? '' : ' — CONTROL_API_SECRET unset, all requests will be refused')
    );
  });
}
