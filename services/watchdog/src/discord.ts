/**
 * discord.ts — DiscordNotifier using the bot API (not webhook)
 * Uses the channel messages endpoint with Authorization: Bot <token>
 */

import { LocalLogger } from './logger.js';

const DEFAULT_COLOR = 3447003; // Discord blue
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;

export type FetchFn = typeof fetch;

export interface DiscordConfig {
  botToken: string;
  channelId: string;
  /** Injectable fetch for testing */
  fetchFn?: FetchFn;
  /** Fallback log file when Discord is unreachable */
  fallbackLogFile?: string;
}

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  timestamp: string;
}

export class DiscordNotifier {
  private readonly config: DiscordConfig;
  private readonly fetchFn: FetchFn;
  private readonly fallbackLogger: LocalLogger | null;

  constructor(config: DiscordConfig) {
    this.config = config;
    this.fetchFn = config.fetchFn ?? fetch;
    this.fallbackLogger = config.fallbackLogFile
      ? new LocalLogger(config.fallbackLogFile)
      : null;
  }

  async send(message: string, color: number = DEFAULT_COLOR): Promise<void> {
    const embed: DiscordEmbed = {
      title: 'Wren Watchdog',
      description: message,
      color,
      timestamp: new Date().toISOString(),
    };

    const body = JSON.stringify({ embeds: [embed] });
    const url = `https://discord.com/api/v10/channels/${this.config.channelId}/messages`;
    const headers = {
      'Authorization': `Bot ${this.config.botToken}`,
      'Content-Type': 'application/json',
    };

    let lastError: string = '';

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await this.fetchFn(url, { method: 'POST', headers, body });

        if (res.status === 429) {
          // Rate limited — parse retry-after
          let retryAfterMs = BASE_RETRY_DELAY_MS;
          try {
            const retryHeader = res.headers.get('retry-after');
            if (retryHeader) {
              retryAfterMs = Math.ceil(parseFloat(retryHeader) * 1000);
            } else {
              const data = await res.json() as { retry_after?: number };
              if (data.retry_after) {
                retryAfterMs = Math.ceil(data.retry_after * 1000);
              }
            }
          } catch { /* ignore parse errors */ }
          await sleep(retryAfterMs);
          continue;
        }

        if (res.ok) {
          return; // Success
        }

        lastError = `HTTP ${res.status}`;
        // Non-retryable error
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_RETRIES - 1) {
          await sleep(BASE_RETRY_DELAY_MS * (attempt + 1));
        }
      }
    }

    // All attempts failed — write to fallback log
    await this.writeFallback(message, lastError);
  }

  private async writeFallback(message: string, error: string): Promise<void> {
    if (this.fallbackLogger) {
      await this.fallbackLogger.log(`[Discord fallback] ${message} (error: ${error})`).catch(() => {});
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
