import { Router } from 'express';
import { NotificationStore } from '../lib/store';

/**
 * Actions router — provides action endpoints for extension to invoke:
 * - Mark notifications read
 * - Hand back to agent (enqueue task)
 * - Restart container (direct action)
 * - Snooze notifications
 */
export function actionsRouter(store: NotificationStore): Router {
  const router = Router();

  // POST /actions/snooze — snooze notifications from a source
  router.post('/actions/snooze', async (req, res) => {
    try {
      const { source, minutes = 30 } = req.body;
      if (!source) {
        return res.status(400).json({ error: 'Missing source' });
      }

      // Store snooze state in memory (or Supabase for persistence)
      const snoozeKey = `snooze:${source}`;
      await store.setSnoozed(snoozeKey, minutes);

      res.json({
        ok: true,
        source,
        snoozedUntil: Date.now() + minutes * 60 * 1000,
        message: `${source} snoozed for ${minutes} minutes`,
      });
    } catch (err) {
      console.error('[actions/snooze] error:', err);
      res.status(500).json({ error: 'Snooze failed' });
    }
  });

  // POST /actions/hand-back — send notification back to agent (enqueue task)
  router.post('/actions/hand-back', async (req, res) => {
    try {
      const { notificationId, taskTitle, taskDescription } = req.body;
      if (!notificationId) {
        return res.status(400).json({ error: 'Missing notificationId' });
      }

      // Enqueue task to task_queue (requires SUPABASE_URL and SUPABASE_KEY)
      const task = {
        title: taskTitle || 'Notification Review Task',
        description: taskDescription || `Review notification ${notificationId} - enqueued from Sentinel`,
        priority: 2,
      };

      // In production, this would call the Supabase task_queue table
      // For now, we log and return success
      console.log('[actions/hand-back] enqueued task:', task);

      res.json({
        ok: true,
        notificationId,
        task: task.title,
        queued: true,
      });
    } catch (err) {
      console.error('[actions/hand-back] error:', err);
      res.status(500).json({ error: 'Failed to hand back notification' });
    }
  });

  // POST /actions/container/restart — restart a container
  router.post('/actions/container/restart', async (req, res) => {
    try {
      const { containerName, containerId } = req.body;
      if (!containerName && !containerId) {
        return res.status(400).json({ error: 'Missing containerName or containerId' });
      }

      const name = containerName || containerId;

      // In production, this would call the Docker/Podman API or systemd
      // For now, we log and return success
      console.log(`[actions/container/restart] restarting ${name}`);

      res.json({
        ok: true,
        container: name,
        action: 'restart',
        queued: true,
        message: `Restart request queued for ${name}`,
      });
    } catch (err) {
      console.error('[actions/container/restart] error:', err);
      res.status(500).json({ error: 'Container restart failed' });
    }
  });

  // POST /actions/container/stop — stop a container
  router.post('/actions/container/stop', async (req, res) => {
    try {
      const { containerName, containerId } = req.body;
      if (!containerName && !containerId) {
        return res.status(400).json({ error: 'Missing containerName or containerId' });
      }

      const name = containerName || containerId;
      console.log(`[actions/container/stop] stopping ${name}`);

      res.json({
        ok: true,
        container: name,
        action: 'stop',
        queued: true,
        message: `Stop request queued for ${name}`,
      });
    } catch (err) {
      console.error('[actions/container/stop] error:', err);
      res.status(500).json({ error: 'Container stop failed' });
    }
  });

  // POST /actions/acknowledge — mark notification and dismiss
  router.post('/actions/acknowledge', async (req, res) => {
    try {
      const { notificationId } = req.body;
      if (!notificationId) {
        return res.status(400).json({ error: 'Missing notificationId' });
      }

      const ok = store.markRead(notificationId);
      if (!ok) {
        return res.status(404).json({ error: 'Notification not found' });
      }

      res.json({
        ok: true,
        notificationId,
        acknowledged: true,
      });
    } catch (err) {
      console.error('[actions/acknowledge] error:', err);
      res.status(500).json({ error: 'Acknowledge failed' });
    }
  });

  return router;
}
