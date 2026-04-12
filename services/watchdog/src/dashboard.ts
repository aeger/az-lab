/**
 * dashboard.ts — HTTP dashboard server on configurable port
 * GET /health → JSON status (no null fields)
 * GET /metrics → Prometheus-style text (bonus)
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http';

export interface CircuitBreakerStatus {
  tripped: boolean;
  restarts_in_last_hour: number;
  cooldown_remaining: number;
}

export interface HealthStatus {
  status: string;
  heartbeat_age: number;
  last_restart: string;
  prompt_count: number;
  circuit_breaker: CircuitBreakerStatus;
  uptime_sec?: number;
}

const DEFAULT_STATUS: HealthStatus = {
  status: 'initializing',
  heartbeat_age: 0,
  last_restart: 'never',
  prompt_count: 0,
  circuit_breaker: {
    tripped: false,
    restarts_in_last_hour: 0,
    cooldown_remaining: 0,
  },
};

export interface DashboardConfig {
  port: number;
}

export class WatchdogDashboard {
  private readonly config: DashboardConfig;
  private status: HealthStatus;
  private server: Server | null = null;
  private readonly startTime = Date.now();

  constructor(config: DashboardConfig) {
    this.config = config;
    this.status = { ...DEFAULT_STATUS };
  }

  updateStatus(partial: Partial<HealthStatus>): void {
    this.status = {
      ...this.status,
      ...partial,
      // Ensure circuit_breaker is merged, not replaced wholesale
      circuit_breaker: {
        ...this.status.circuit_breaker,
        ...(partial.circuit_breaker ?? {}),
      },
    };
  }

  getStatus(): HealthStatus {
    return {
      ...this.status,
      uptime_sec: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  async start(): Promise<Server> {
    return new Promise((resolve, reject) => {
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res);
      });

      server.on('error', reject);

      server.listen(this.config.port, '0.0.0.0', () => {
        this.server = server;
        resolve(server);
      });
    });
  }

  async close(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/';

    if (url === '/health' || url === '/health/') {
      const body = JSON.stringify(this.getStatus());
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    // 404 for anything else
    const body = JSON.stringify({ error: 'Not found', path: url });
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(body);
  }
}
