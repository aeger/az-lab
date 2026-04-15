import type { Router } from 'express';
import express from 'express';
import type { NotificationStore } from '../lib/store';

export function createNotificationsRouter(store: NotificationStore): Router {
  const router = express.Router();

  // GET /api/notifications — query in-memory store
  router.get('/notifications', (req, res) => {
    const { since, source, category, status, urgency, limit } = req.query;
    const result = store.query({
      since: since as string,
      source: source as string,
      category: category as string,
      status: status as any,
      urgency: urgency as any,
      limit: limit ? parseInt(limit as string, 10) : 100,
    });
    res.json(result);
  });

  // GET /api/notifications/history — query persistent Supabase history
  router.get('/notifications/history', async (req, res) => {
    const { source, category, status, limit, offset, days } = req.query;
    const result = await store.queryHistory({
      source: source as string,
      category: category as string,
      status: status as any,
      limit: limit ? parseInt(limit as string, 10) : 50,
      offset: offset ? parseInt(offset as string, 10) : 0,
      days: days ? parseInt(days as string, 10) : 30,
    });
    res.json(result);
  });

  // POST /api/notifications/:id/read
  router.post('/notifications/:id/read', (req, res) => {
    const ok = store.markRead(req.params.id);
    res.json({ success: ok });
  });

  // POST /api/notifications/read-all
  router.post('/notifications/read-all', (req, res) => {
    const { source, urgency } = req.body;
    const count = store.markAllRead({ source, urgency });
    res.json({ success: true, count });
  });

  // DELETE /api/notifications/:id
  router.delete('/notifications/:id', (req, res) => {
    const ok = store.dismiss(req.params.id);
    res.json({ success: ok });
  });

  // POST /api/notifications — push a notification from external sources
  router.post('/notifications', (req, res) => {
    const { source, severity, title, body, category, sourceId, metadata, urgency } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });

    const n = {
      id: crypto.randomUUID(),
      source: source || 'services',
      severity: severity || 'info',
      urgency: urgency || 'medium',
      status: 'unread' as const,
      title,
      body: body || '',
      category: category || 'external_push',
      sourceId: sourceId || `push:${Date.now()}`,
      metadata,
      timestamp: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
    };

    const added = store.add(n as any);
    res.status(added ? 201 : 200).json({ success: true, id: n.id, added });
  });

  // GET /api/stats
  router.get('/stats', (req, res) => {
    const { notifications, unreadCount, criticalCount } = store.query({ limit: 1000 });
    const bySource: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    for (const n of notifications) {
      bySource[n.source] = (bySource[n.source] || 0) + 1;
      byCategory[n.category] = (byCategory[n.category] || 0) + 1;
    }
    res.json({
      total: notifications.length,
      unread: unreadCount,
      critical: criticalCount,
      bySource,
      byCategory,
    });
  });

  return router;
}
