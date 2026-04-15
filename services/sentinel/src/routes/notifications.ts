import { Router } from 'express';
import { NotificationStore } from '../lib/store';
import { DigestScheduler } from '../lib/digest';
import { NotificationSource, NotificationStatus } from '../types';
import { parseSearchQuery } from '../lib/nemotron';

export function notificationsRouter(store: NotificationStore, digest?: DigestScheduler): Router {
  const router = Router();

  router.get('/notifications', (req, res) => {
    const since = req.query.since as string | undefined;
    const source = req.query.source as NotificationSource | undefined;
    const status = req.query.status as NotificationStatus | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

    const result = store.query({ since, source, status, limit });
    res.json(result);
  });

  // Persistent history from Supabase — survives API restarts
  router.get('/notifications/history', async (req, res) => {
    const source = req.query.source as NotificationSource | undefined;
    const status = req.query.status as string | undefined;
    const urgency = req.query.urgency as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    const days = req.query.days ? parseInt(req.query.days as string, 10) : 7;

    const result = await store.queryHistory({ source, status, urgency, limit, offset, days });
    res.json(result);
  });

  // POST /notifications/:id/read — mark a single notification read (persisted to Supabase)
  router.post('/notifications/:id/read', (req, res) => {
    const ok = store.markRead(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found or already read' });
    res.json({ ok: true });
  });

  // PATCH /notifications/:id/read — REST-friendly alias for POST
  router.patch('/notifications/:id/read', (req, res) => {
    const ok = store.markRead(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found or already read' });
    res.json({ ok: true });
  });

  router.post('/notifications/read-all', (req, res) => {
    const source = req.body?.source as NotificationSource | undefined;
    const count = store.markAllRead(source);
    res.json({ ok: true, count });
  });

  router.post('/notifications/:id/dismiss', (req, res) => {
    const ok = store.dismiss(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  // DELETE /notifications/archive — archive read notifications older than 30 days
  router.delete('/notifications/archive', async (_req, res) => {
    try {
      const count = await store.archiveOld();
      res.json({ ok: true, archived: count });
    } catch (err) {
      console.error('[route] archive failed:', (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/notifications/search — AI-powered natural language search via Nemotron
  router.post('/notifications/search', async (req, res) => {
    const query = req.body?.query as string | undefined;
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ error: 'query is required' });
    }

    try {
      // Parse natural language into structured filters using Nemotron
      const filters = await parseSearchQuery(query.trim());

      // Build history query options from parsed filters
      const days = filters.days
        ?? (filters.dateRange?.from
          ? Math.ceil((Date.now() - new Date(filters.dateRange.from).getTime()) / 86_400_000)
          : 30);

      const historyOpts = {
        source: filters.source as NotificationSource | undefined,
        severity: filters.severity,
        days: Math.min(days, 365),
        limit: 100,
        offset: 0,
      };

      let { notifications, total } = await store.queryHistory(historyOpts);

      // Post-filter by date range upper bound if specified
      if (filters.dateRange?.to) {
        const toMs = new Date(filters.dateRange.to).getTime();
        notifications = notifications.filter(n => new Date(n.timestamp).getTime() <= toMs);
        total = notifications.length;
      }

      // Post-filter by categories
      if (filters.categories && filters.categories.length > 0) {
        const cats = filters.categories.map(c => c.toLowerCase());
        notifications = notifications.filter(n => cats.some(c => n.category.toLowerCase().includes(c)));
        total = notifications.length;
      }

      // Post-filter by keywords (title/body)
      if (filters.keywords && filters.keywords.length > 0) {
        const kws = filters.keywords.map(k => k.toLowerCase());
        notifications = notifications.filter(n => {
          const text = `${n.title} ${n.body}`.toLowerCase();
          return kws.some(k => text.includes(k));
        });
        total = notifications.length;
      }

      res.json({ query, filters, notifications, total });
    } catch (err) {
      console.error('[search] failed:', (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/digest — build and return a digest summary (does NOT post to Discord)
  router.get('/digest', async (_req, res) => {
    if (!digest) return res.status(503).json({ error: 'Digest scheduler not available' });
    try {
      const summary = await digest.buildDigest();
      res.json(summary);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/digest/send — build digest and post it to Discord immediately
  router.post('/digest/send', async (_req, res) => {
    if (!digest) return res.status(503).json({ error: 'Digest scheduler not available' });
    try {
      const summary = await digest.runDigest();
      res.json({ ok: true, summary });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
