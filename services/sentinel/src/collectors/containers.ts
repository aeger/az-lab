import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import type { SentinelNotification } from '../types';
import * as http from 'http';
import * as fs from 'fs';

// Critical containers that page critical if down
const CRITICAL_CONTAINERS = ['traefik', 'authelia', 'memory-mcp-server', 'sentinel-api', 'lldap'];
// Containers to ignore (expected to be stopped occasionally)
const IGNORED_CONTAINERS: string[] = [];

async function podmanRequest(socketPath: string, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const options = {
      socketPath,
      path,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON: ${data.slice(0, 100)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

export function createContainersCollector() {
  return async (): Promise<SentinelNotification[]> => {
    const socketPath = config.podman.socketPath;

    // Check socket exists
    if (!fs.existsSync(socketPath)) {
      // Silent — socket not mounted is expected in some environments
      return [];
    }

    let containers: any[];
    try {
      containers = await podmanRequest(socketPath, '/v5.0.0/libpod/containers/json?all=true');
    } catch (err: any) {
      // Try older API version
      try {
        containers = await podmanRequest(socketPath, '/v4.0.0/libpod/containers/json?all=true');
      } catch {
        throw new Error(`Podman socket error: ${err.message}`);
      }
    }

    const notifications: SentinelNotification[] = [];

    for (const container of containers) {
      const name = (container.Names?.[0] || container.Name || '').replace(/^\//, '');
      if (IGNORED_CONTAINERS.includes(name)) continue;

      const state = container.State?.toLowerCase() || '';
      const status = container.Status || '';
      const isCritical = CRITICAL_CONTAINERS.some(c => name.includes(c));

      // Only alert on unhealthy states
      if (state === 'running') {
        // Check health status if available
        const health = container.HealthStatus?.toLowerCase() || '';
        if (health === 'unhealthy') {
          notifications.push({
            id: uuidv4(),
            source: 'services',
            severity: isCritical ? 'critical' : 'warning',
            urgency: 'medium',
            status: 'unread',
            title: `Unhealthy: ${name}`,
            body: `Container ${name} is running but health check is failing. Status: ${status}`,
            category: 'container_unhealthy',
            sourceId: `container:${name}`,
            metadata: { name, state, status, image: container.Image },
            timestamp: new Date().toISOString(),
            receivedAt: new Date().toISOString(),
          });
        }
        continue;
      }

      if (state === 'exited' || state === 'stopped') {
        const exitCode = container.ExitCode ?? -1;
        if (exitCode === 0) continue; // clean stop — not an alert

        notifications.push({
          id: uuidv4(),
          source: 'services',
          severity: isCritical ? 'critical' : 'warning',
          urgency: 'medium',
          status: 'unread',
          title: `${isCritical ? 'CRITICAL' : 'Down'}: ${name}`,
          body: `Container ${name} exited with code ${exitCode}. Status: ${status}`,
          category: 'container_down',
          sourceId: `container:${name}`,
          metadata: { name, state, exitCode, status, image: container.Image },
          timestamp: new Date().toISOString(),
          receivedAt: new Date().toISOString(),
        });
      } else if (state === 'restarting') {
        notifications.push({
          id: uuidv4(),
          source: 'services',
          severity: 'warning',
          urgency: 'medium',
          status: 'unread',
          title: `Restarting: ${name}`,
          body: `Container ${name} is in a restart loop. Status: ${status}`,
          category: 'container_restarting',
          sourceId: `container:${name}`,
          metadata: { name, state, status, image: container.Image },
          timestamp: new Date().toISOString(),
          receivedAt: new Date().toISOString(),
        });
      } else if (state === 'dead') {
        notifications.push({
          id: uuidv4(),
          source: 'services',
          severity: 'critical',
          urgency: 'medium',
          status: 'unread',
          title: `Dead: ${name}`,
          body: `Container ${name} is in a dead state and requires manual intervention. Status: ${status}`,
          category: 'container_dead',
          sourceId: `container:${name}`,
          metadata: { name, state, status, image: container.Image },
          timestamp: new Date().toISOString(),
          receivedAt: new Date().toISOString(),
        });
      }
    }

    return notifications;
  };
}
