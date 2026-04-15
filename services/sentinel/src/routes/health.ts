import { Router } from 'express';
import { Poller } from '../lib/poller';
import { GuardianAgent } from '../lib/guardian';
import { HealthResponse } from '../types';

const startTime = Date.now();

export function healthRouter(poller: Poller, guardian?: GuardianAgent): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    const collectors = poller.getHealth();
    const hasError = Object.values(collectors).some(c => c.status === 'error');

    const response: HealthResponse & { extension?: ReturnType<GuardianAgent['getStatus']> } = {
      status: hasError ? 'degraded' : 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      collectors: collectors as HealthResponse['collectors'],
    };

    if (guardian) {
      response.extension = guardian.getStatus();
    }

    res.json(response);
  });

  // POST /api/extension/heartbeat — called by Edge Sentinel extension to prove it's alive
  router.post('/extension/heartbeat', (req, res) => {
    if (!guardian) return res.status(503).json({ error: 'Guardian not enabled' });

    const extensionId = (req.body?.extensionId as string | undefined) || 'default';
    const userAgent = req.headers['user-agent'];
    const version = req.body?.version as string | undefined;

    guardian.updateHeartbeat(extensionId, userAgent, version);

    const status = guardian.getStatus();
    res.json({ ok: true, reconnectRequested: status.reconnectRequested });
  });

  // GET /api/extension/status — extension polls this to check for reconnect requests
  router.get('/extension/status', (_req, res) => {
    if (!guardian) return res.json({ status: 'guardian_disabled' });

    const status = guardian.getStatus();
    res.json(status);
  });

  // POST /api/extension/reconnect-done — extension signals it has re-initialized
  router.post('/extension/reconnect-done', (_req, res) => {
    if (!guardian) return res.status(503).json({ error: 'Guardian not enabled' });
    guardian.clearReconnect();
    res.json({ ok: true });
  });

  return router;
}
