import type { SentinelNotification, CollectorHealth } from '../types';
import type { NotificationStore } from './store';

export interface Collector {
  name: string;
  fn: () => Promise<SentinelNotification[]>;
  intervalMs: number;
  enabled: boolean;
}

export class Poller {
  private timers: NodeJS.Timeout[] = [];
  private lastRunTimes = new Map<string, number>();
  private lastErrors = new Map<string, string>();

  constructor(
    private collectors: Collector[],
    private store: NotificationStore,
  ) {}

  start() {
    const enabled = this.collectors.filter(c => c.enabled);
    const disabled = this.collectors.filter(c => !c.enabled);

    console.log(`[sentinel-api] collectors enabled: ${enabled.map(c => c.name).join(', ')}`);
    if (disabled.length > 0) {
      console.log(`[sentinel-api] collectors disabled (missing config): ${disabled.map(c => c.name).join(', ')}`);
    }

    for (const collector of enabled) {
      // Run immediately, then on interval
      this.runCollector(collector);
      const timer = setInterval(() => this.runCollector(collector), collector.intervalMs);
      this.timers.push(timer);
    }
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  getHealth(): Record<string, CollectorHealth> {
    const health: Record<string, CollectorHealth> = {};
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000; // 5 minutes

    for (const collector of this.collectors) {
      const lastRun = this.lastRunTimes.get(collector.name);
      const error = this.lastErrors.get(collector.name);

      if (!collector.enabled) {
        health[collector.name] = { status: 'ok' };
      } else if (error) {
        health[collector.name] = { status: 'error', message: error };
      } else if (!lastRun) {
        health[collector.name] = { status: 'ok' };
      } else if (now - lastRun > staleThreshold) {
        health[collector.name] = { status: 'stale', lastRun: new Date(lastRun).toISOString() };
      } else {
        health[collector.name] = { status: 'ok', lastRun: new Date(lastRun).toISOString() };
      }
    }
    return health;
  }

  private async runCollector(collector: Collector) {
    try {
      this.lastRunTimes.set(collector.name, Date.now());
      this.lastErrors.delete(collector.name);
      const notifications = await collector.fn();
      let added = 0;
      for (const n of notifications) {
        if (this.store.add(n)) added++;
      }
      if (added > 0) {
        console.log(`[${collector.name}] +${added} notification(s)`);
      }
    } catch (err: any) {
      const msg = err.message || String(err);
      this.lastErrors.set(collector.name, msg);
      // Only log if it's not a routine "nothing to report" situation
      if (!msg.includes('ECONNREFUSED') || Math.random() < 0.01) {
        console.warn(`[${collector.name}] collector error: ${msg}`);
      }
    }
  }
}
