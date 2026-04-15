export const config = {
  port: parseInt(process.env.PORT || '3200', 10),
  apiKey: process.env.SENTINEL_API_KEY || '',
  supabase: {
    url: process.env.SUPABASE_URL || '',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    serviceKey: process.env.SUPABASE_SERVICE_KEY || '',
    pollInterval: parseInt(process.env.POLL_SUPABASE || '30000', 10),
  },
  ha: {
    url: process.env.HA_URL || '',
    accessToken: process.env.HA_ACCESS_TOKEN || '',
    pollInterval: parseInt(process.env.POLL_HA || '30000', 10),
  },
  discord: {
    botToken: process.env.DISCORD_BOT_TOKEN || '',
    channelId: process.env.DISCORD_CHANNEL_ID || '',
    pollInterval: parseInt(process.env.POLL_DISCORD || '60000', 10),
    alertChannelId: process.env.DISCORD_ALERT_CHANNEL_ID || process.env.DISCORD_CHANNEL_ID || '',
    breakingAlertsEnabled: process.env.BREAKING_ALERTS_ENABLED !== 'false',
    breakingSeverity: (process.env.BREAKING_SEVERITY || 'critical') as 'info' | 'warning' | 'critical',
    digestEnabled: process.env.DIGEST_ENABLED === 'true',
    digestHour: parseInt(process.env.DIGEST_HOUR || '8', 10),
  },
  grafana: {
    url: process.env.GRAFANA_URL || '',
    username: process.env.GRAFANA_USERNAME || '',
    password: process.env.GRAFANA_PASSWORD || '',
    pollInterval: parseInt(process.env.POLL_GRAFANA || '30000', 10),
  },
  prometheus: {
    url: process.env.PROMETHEUS_URL || '',
    pollInterval: parseInt(process.env.POLL_SERVICES || '60000', 10),
  },
  podman: {
    // Podman socket path (mounted from host)
    socketPath: process.env.PODMAN_SOCKET || '/run/podman/podman.sock',
    pollInterval: parseInt(process.env.POLL_CONTAINERS || '30000', 10),
  },
  store: {
    maxAge: 24 * 60 * 60 * 1000,
    maxItems: 1000,
    pruneInterval: 5 * 60 * 1000,
  },
};

export function isCollectorEnabled(name: string): boolean {
  switch (name) {
    case 'task_queue':   return !!(config.supabase.url && config.supabase.anonKey);
    case 'agent_health': return !!(config.supabase.url && config.supabase.anonKey);
    case 'goals':        return !!(config.supabase.url && config.supabase.anonKey);
    case 'home_assistant': return !!(config.ha.url && config.ha.accessToken);
    case 'discord':      return !!(config.discord.botToken && config.discord.channelId);
    case 'grafana':      return !!(config.grafana.url && config.grafana.password);
    case 'services':     return !!config.prometheus.url;
    case 'containers':   return true; // always attempt; falls back gracefully
    default:             return false;
  }
}
