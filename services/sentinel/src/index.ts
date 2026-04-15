import express from 'express';
import { config, isCollectorEnabled } from './config';
import { NotificationStore } from './lib/store';
import { Poller } from './lib/poller';
import { DigestScheduler } from './lib/digest';
import { DiscordAlerter } from './lib/discord-alert';
import { healthRouter } from './routes/health';
import { createNotificationsRouter } from './routes/notifications';

// Collectors
import { createTaskQueueCollector } from './collectors/task-queue';
import { createAgentHealthCollector } from './collectors/agent-health';
import { createContainersCollector } from './collectors/containers';
import { createGoalsCollector } from './collectors/goals';
import { createHACollector } from './collectors/home-assistant';
import { createDiscordCollector } from './collectors/discord';
import { createGrafanaCollector } from './collectors/grafana';
import { createServicesCollector } from './collectors/services';

const app = express();
app.use(express.json());

// CORS — allow dashboard and extension to hit this API
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Sentinel-Key');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// API key auth (skip /health)
if (config.apiKey) {
  app.use('/api', (req, res, next) => {
    if (req.path === '/health') return next();
    const key = req.headers['x-sentinel-key'];
    if (key !== config.apiKey) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    next();
  });
}

// Store + alerter
const store = new NotificationStore();
store.start();

const alerter = new DiscordAlerter();

// Breaking alerts
if (config.discord.breakingAlertsEnabled && config.discord.alertChannelId) {
  const minSeverity = config.discord.breakingSeverity;
  const severityRank: Record<string, number> = { info: 1, warning: 2, critical: 3 };
  const threshold = severityRank[minSeverity] ?? 3;

  store.onNew(n => {
    if ((severityRank[n.severity] ?? 0) >= threshold) {
      alerter.sendAlert(n).catch(err => console.error('[breaking-alert] failed:', err.message));
    }
  });
  console.log(`[breaking-alert] enabled — threshold: ${minSeverity}+`);
}

// Collectors
const collectors = [
  { name: 'task_queue',    fn: createTaskQueueCollector(),    intervalMs: config.supabase.pollInterval, enabled: isCollectorEnabled('task_queue') },
  { name: 'agent_health',  fn: createAgentHealthCollector(),  intervalMs: 60_000,                        enabled: isCollectorEnabled('agent_health') },
  { name: 'goals',         fn: createGoalsCollector(),        intervalMs: 5 * 60_000,                    enabled: isCollectorEnabled('goals') },
  { name: 'containers',    fn: createContainersCollector(),   intervalMs: config.podman.pollInterval,    enabled: isCollectorEnabled('containers') },
  { name: 'home_assistant',fn: createHACollector(),           intervalMs: config.ha.pollInterval,        enabled: isCollectorEnabled('home_assistant') },
  { name: 'discord',       fn: createDiscordCollector(),      intervalMs: config.discord.pollInterval,   enabled: isCollectorEnabled('discord') },
  { name: 'grafana',       fn: createGrafanaCollector(),      intervalMs: config.grafana.pollInterval,   enabled: isCollectorEnabled('grafana') },
  { name: 'services',      fn: createServicesCollector(),     intervalMs: config.prometheus.pollInterval, enabled: isCollectorEnabled('services') },
];

const poller = new Poller(collectors, store);
poller.start();

// Digest
const digest = new DigestScheduler(store, alerter);
digest.start();

// Routes
app.use('/', healthRouter);
app.use('/api', createNotificationsRouter(store));

// Start
const server = app.listen(config.port, () => {
  console.log(`[sentinel-api] v2.0.0 listening on :${config.port}`);
});

process.on('SIGTERM', () => {
  console.log('[sentinel-api] shutting down...');
  store.stop();
  poller.stop();
  digest.stop();
  server.close(() => process.exit(0));
});
