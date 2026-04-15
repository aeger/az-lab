import { Router, Request, Response } from 'express';
import { NotificationStore } from '../lib/store';

interface ExtensionClient {
  id: string;
  type: 'extension' | 'device';
  lastHeartbeat: number;
  listenersActive: boolean;
}

const extensionClients = new Map<string, ExtensionClient>();

// Heartbeat cleanup: remove stale clients every 5 minutes
setInterval(() => {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; // 5 minutes
  for (const [id, client] of extensionClients.entries()) {
    if (now - client.lastHeartbeat > timeout) {
      extensionClients.delete(id);
      console.log(`[extension] removed stale client: ${id}`);
    }
  }
}, 5 * 60 * 1000);

export function extensionRouter(store: NotificationStore): Router {
  const router = Router();

  // POST /extension/register — register extension/device client
  router.post('/extension/register', (req, res) => {
    try {
      const { id, type = 'extension' } = req.body;
      if (!id) return res.status(400).json({ error: 'Missing client id' });

      extensionClients.set(id, {
        id,
        type: type === 'device' ? 'device' : 'extension',
        lastHeartbeat: Date.now(),
        listenersActive: false,
      });

      res.json({ ok: true, clientId: id, registered: true });
    } catch (err) {
      console.error('[extension/register] error:', err);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  // POST /extension/heartbeat — keep client alive
  router.post('/extension/heartbeat', (req, res) => {
    try {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'Missing client id' });

      const client = extensionClients.get(id);
      if (client) {
        client.lastHeartbeat = Date.now();
      } else {
        extensionClients.set(id, {
          id,
          type: 'extension',
          lastHeartbeat: Date.now(),
          listenersActive: false,
        });
      }

      res.json({ ok: true, clientId: id });
    } catch (err) {
      console.error('[extension/heartbeat] error:', err);
      res.status(500).json({ error: 'Heartbeat failed' });
    }
  });

  // GET /extension/health — check extension connection status
  router.get('/extension/health', (req, res) => {
    try {
      const clients = Array.from(extensionClients.values());
      const connected = clients.filter(c => Date.now() - c.lastHeartbeat < 2 * 60 * 1000);

      res.json({
        ok: true,
        totalClients: clients.length,
        connectedClients: connected.length,
        clients: clients.map(c => ({
          id: c.id,
          type: c.type,
          lastHeartbeat: c.lastHeartbeat,
          stale: Date.now() - c.lastHeartbeat > 2 * 60 * 1000,
          listenersActive: c.listenersActive,
        })),
      });
    } catch (err) {
      console.error('[extension/health] error:', err);
      res.status(500).json({ error: 'Health check failed' });
    }
  });

  // POST /extension/mirror — register for cross-device mirroring (SSE or polling fallback)
  router.post('/extension/mirror', (req, res) => {
    try {
      const { clientId } = req.body;
      if (!clientId) return res.status(400).json({ error: 'Missing clientId' });

      const client = extensionClients.get(clientId);
      if (client) {
        client.listenersActive = true;
      }

      // Return latest notifications for initial sync
      const notifications = store.query({ limit: 100 });
      res.json({ ok: true, clientId, notifications: notifications.notifications });
    } catch (err) {
      console.error('[extension/mirror] error:', err);
      res.status(500).json({ error: 'Mirror registration failed' });
    }
  });

  // POST /extension/listeners/repair — attempt to repair broken event listeners
  router.post('/extension/listeners/repair', (req, res) => {
    try {
      const { clientId } = req.body;
      if (!clientId) return res.status(400).json({ error: 'Missing clientId' });

      const client = extensionClients.get(clientId);
      if (!client) {
        return res.status(404).json({ error: 'Client not found' });
      }

      // Force re-registration of listeners
      client.listenersActive = true;
      client.lastHeartbeat = Date.now();

      res.json({
        ok: true,
        clientId,
        repaired: true,
        message: 'Listeners repaired and re-registered',
      });
    } catch (err) {
      console.error('[extension/listeners/repair] error:', err);
      res.status(500).json({ error: 'Repair failed' });
    }
  });

  // POST /extension/unregister — unregister extension/device client
  router.post('/extension/unregister', (req, res) => {
    try {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'Missing client id' });

      extensionClients.delete(id);
      res.json({ ok: true, clientId: id, unregistered: true });
    } catch (err) {
      console.error('[extension/unregister] error:', err);
      res.status(500).json({ error: 'Unregistration failed' });
    }
  });

  return router;
}
