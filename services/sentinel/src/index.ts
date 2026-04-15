import express from 'express';
import { config, isCollectorEnabled } from './config';
import { runMigrations } from './lib/migrate';
import { NotificationStore } from './lib/store';
import { Poller } from './lib/poller';
import { DigestScheduler } from './lib/digest';
import { DiscordAlerter } from './lib/discord-alert';
import { GuardianAgent } from './lib/guardian';
import { SoundDirector } from './lib/sound-director';
import { HealthReportScheduler } from './lib/health-report';
import { healthRouter } from './routes/health';
import { notificationsRouter } from './routes/notifications';
import { settingsRouter } from './routes/settings';
import { extensionRouter } from './routes/extension';
import { actionsRouter } from './routes/actions';
import { CollectorConfig } from './types';

// Collectors
import { createTaskQueueCollector } from './collectors/task-queue';
import { createHACollector } from './collectors/home-assistant';
import { createDiscordCollector } from './collectors/discord';
import { createGrafanaCollector } from './collectors/grafana';
import { createServicesCollector } from './collectors/services';
import { createAgentHealthCollector } from './collectors/agent-health';
import { createGoalsCollector } from './collectors/goals';

const app = express();
app.use(express.json());

// CORS
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Sentinel-Key');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// API key auth (optional — skip if no key configured)
if (config.apiKey) {
  app.use('/api', (req, res, next) => {
    if (req.path === '/health') return next(); // health is public
    const key = req.headers['x-sentinel-key'];
    if (key !== config.apiKey) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    next();
  });
}

// Initialize store
const store = new NotificationStore();
store.start();

// Breaking-news Discord alerts: fire when a critical (or warning) notification arrives
const alerter = new DiscordAlerter();
if (config.discord.breakingAlertsEnabled && config.discord.alertChannelId) {
  const minSeverity = config.discord.breakingSeverity;
  const severityRank: Record<string, number> = { info: 1, warning: 2, critical: 3 };
  const threshold = severityRank[minSeverity] ?? 3;

  store.onNew(n => {
    if ((severityRank[n.severity] ?? 0) >= threshold) {
      alerter.sendAlert(n).catch(err =>
        console.error('[breaking-alert] failed to send:', err.message),
      );
    }
  });

  console.log(`[breaking-alert] enabled — threshold: ${minSeverity}+`);
}

// Build collectors
const collectors = [
  {
    name: 'task_queue',
    fn: createTaskQueueCollector(),
    intervalMs: config.supabase.pollInterval,
    enabled: isCollectorEnabled('task_queue'),
  },
  {
    name: 'home_assistant',
    fn: createHACollector(),
    intervalMs: config.ha.pollInterval,
    enabled: isCollectorEnabled('home_assistant'),
  },
  {
    name: 'discord',
    fn: createDiscordCollector(),
    intervalMs: config.discord.pollInterval,
    enabled: isCollectorEnabled('discord'),
  },
  {
    name: 'grafana',
    fn: createGrafanaCollector(),
    intervalMs: config.grafana.pollInterval,
    enabled: isCollectorEnabled('grafana'),
  },
  {
    name: 'services',
    fn: createServicesCollector(),
    intervalMs: config.prometheus.pollInterval,
    enabled: isCollectorEnabled('services'),
  },
  {
    name: 'agent_health',
    fn: createAgentHealthCollector(),
    intervalMs: 60_000, // every 60 seconds
    enabled: isCollectorEnabled('agent_health'),
  },
  {
    name: 'goals',
    fn: createGoalsCollector(),
    intervalMs: 5 * 60_000, // every 5 minutes
    enabled: isCollectorEnabled('goals'),
  },
];

const poller = new Poller(collectors, store);
poller.start();

// Daily digest scheduler
const digest = new DigestScheduler(store, alerter);
digest.start();

// Guardian Agent — monitors extension heartbeat, self-heals, alerts Discord
const guardian = new GuardianAgent(store, alerter);
if (config.guardian.enabled) {
  guardian.start();
  console.log('[guardian] extension watchdog started');
}

// Sound Director — weekly sound suggestion analysis
const soundDirector = new SoundDirector();

// Weekly health report scheduler (Sundays 8 AM)
const healthReport = new HealthReportScheduler(store, alerter, poller, soundDirector);
healthReport.start();

// Routes
app.use('/api', healthRouter(poller, guardian));
app.use('/api', notificationsRouter(store, digest));
app.use('/api', settingsRouter(store));
app.use('/api', extensionRouter(store));
app.use('/api', actionsRouter(store));

// Run startup migrations (non-blocking)
runMigrations().catch(err => console.error('[migrate] startup error:', err.message));

// Start
app.listen(config.port, () => {
  const enabled = collectors.filter(c => c.enabled).map(c => c.name);
  const disabled = collectors.filter(c => !c.enabled).map(c => c.name);
  console.log(`[sentinel-api] v2.0.0 listening on :${config.port}`);
  console.log(`[sentinel-api] collectors enabled: ${enabled.join(', ') || 'none'}`);
  if (disabled.length) console.log(`[sentinel-api] collectors disabled (missing config): ${disabled.join(', ')}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[sentinel-api] shutting down...');
  poller.stop();
  digest.stop();
  guardian.stop();
  healthReport.stop();
  store.stop();
  process.exit(0);
});
