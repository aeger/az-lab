import type { SentinelNotification } from '../types';
import type { NotificationStore } from './store';

export interface Collector {
  name: string;
  fn: () => Promise<SentinelNotification[]>;
  intervalMs: number;
  enabled: boolean;
}

export class Poller {
  private timers: NodeJS.Timeout[] = [];

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

  private async runCollector(collector: Collector) {
    try {
      const notifications = await collector.fn();
      let added = 0;
      for (const n of notifications) {
        if (this.store.add(n)) added++;
      }
      if (added > 0) {
        console.log(`[${collector.name}] +${added} notification(s)`);
      }
    } catch (err: any) {
      // Only log if it's not a routine "nothing to report" situation
      if (!err.message?.includes('ECONNREFUSED') || Math.random() < 0.01) {
        console.warn(`[${collector.name}] collector error: ${err.message}`);
      }
    }
  }
}
