import { Router } from 'express';
import { NotificationStore } from '../lib/store';

export interface NotificationSettings {
  sounds: Record<string, boolean>;
  thresholds: Record<string, number>;
  enabledSources: Record<string, boolean>;
  snoozeMinutes: number;
  fusionMode?: boolean;
}

const DEFAULT_SETTINGS: NotificationSettings = {
  sounds: {
    critical: true,
    high: true,
    medium: false,
    low: false,
  },
  thresholds: {
    critical: 0,
    high: 0,
    medium: 5,
    low: 10,
  },
  enabledSources: {
    task_queue: true,
    home_assistant: true,
    discord: true,
    grafana: true,
    services: true,
    agent_health: true,
    goals: true,
  },
  snoozeMinutes: 30,
  fusionMode: false,
};

export function settingsRouter(store: NotificationStore): Router {
  const router = Router();

  // GET /settings — retrieve current notification preferences
  router.get('/settings', async (req, res) => {
    try {
      const settings = await store.getSettings();
      res.json(settings || DEFAULT_SETTINGS);
    } catch (err) {
      console.error('[settings] failed to load:', err);
      res.json(DEFAULT_SETTINGS);
    }
  });

  // POST /settings — update notification preferences
  router.post('/settings', async (req, res) => {
    try {
      const settings = req.body as NotificationSettings;
      await store.saveSettings(settings);
      res.json({ ok: true, settings });
    } catch (err) {
      console.error('[settings] failed to save:', err);
      res.status(500).json({ error: 'Failed to save settings' });
    }
  });

  // GET /settings/export — JSON export of all preferences
  router.get('/settings/export', async (req, res) => {
    try {
      const settings = await store.getSettings();
      const exported = {
        version: '2.0.0',
        exportedAt: new Date().toISOString(),
        settings: settings || DEFAULT_SETTINGS,
      };
      res.json(exported);
    } catch (err) {
      console.error('[settings/export] failed:', err);
      res.status(500).json({ error: 'Export failed' });
    }
  });

  // POST /settings/import — JSON import of preferences
  router.post('/settings/import', async (req, res) => {
    try {
      const { settings } = req.body;
      if (!settings) {
        return res.status(400).json({ error: 'Missing settings in request body' });
      }
      await store.saveSettings(settings);
      res.json({ ok: true, message: 'Settings imported successfully', settings });
    } catch (err) {
      console.error('[settings/import] failed:', err);
      res.status(500).json({ error: 'Import failed' });
    }
  });

  // POST /settings/fusion/verify — verify extension connection is alive
  router.post('/settings/fusion/verify', async (req, res) => {
    try {
      const extensionId = req.body?.extensionId as string | undefined;
      const isConnected = extensionId ? await store.checkExtensionHealth(extensionId) : false;
      res.json({ ok: true, connected: isConnected, timestamp: Date.now() });
    } catch (err) {
      console.error('[fusion/verify] failed:', err);
      res.status(500).json({ error: 'Verification failed' });
    }
  });

  // POST /settings/fusion/enable — enable fusion mode
  router.post('/settings/fusion/enable', async (req, res) => {
    try {
      const settings = await store.getSettings();
      const updated = { ...settings, fusionMode: true };
      await store.saveSettings(updated);
      res.json({ ok: true, fusionMode: true });
    } catch (err) {
      console.error('[fusion/enable] failed:', err);
      res.status(500).json({ error: 'Failed to enable fusion mode' });
    }
  });

  return router;
}
