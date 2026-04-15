import { config } from '../config';
import { generateSoundSuggestion } from './nemotron';

const MIN_SAMPLES_PER_HOUR = 3;
const MIN_DAYS_OF_DATA = 14;
const LOW_ATTENTION_MULTIPLIER = 1.5; // hours with latency > 1.5x median are "low attention"

export interface HourlyLatency {
  hour: number;       // 0-23
  avgMinutes: number;
  samples: number;
}

export interface SoundSuggestion {
  weekStart: string;
  lowAttentionHours: number[];
  medianLatencyMinutes: number;
  hourlyData: HourlyLatency[];
  suggestion: string; // Nemotron-generated text
  hasEnoughData: boolean;
}

export class SoundDirector {
  /** Returns true if we have ≥14 days of acknowledged notifications to analyze. */
  async hasEnoughData(): Promise<boolean> {
    const key = config.supabase.serviceKey || config.supabase.anonKey;
    if (!config.supabase.url || !key) return false;

    const cutoff = new Date(Date.now() - MIN_DAYS_OF_DATA * 86_400_000).toISOString();
    const url = `${config.supabase.url}/rest/v1/sentinel_notifications`
      + `?read_at=not.is.null`
      + `&received_at=lte.${encodeURIComponent(cutoff)}`
      + `&limit=1`
      + `&select=id`;

    try {
      const res = await fetch(url, {
        headers: {
          'apikey': key,
          'Authorization': `Bearer ${key}`,
          'Prefer': 'count=exact',
        },
      });
      if (!res.ok) return false;
      const range = res.headers.get('content-range');
      const total = range ? parseInt(range.split('/')[1] || '0', 10) : 0;
      return total >= MIN_DAYS_OF_DATA * 2; // at least 2 acknowledged notifs/day avg
    } catch {
      return false;
    }
  }

  /** Query Supabase for acknowledgment latency grouped by hour-of-day. */
  async analyzeAckLatency(): Promise<HourlyLatency[]> {
    const key = config.supabase.serviceKey || config.supabase.anonKey;
    if (!config.supabase.url || !key) return [];

    // Pull last 30 days of acknowledged notifications
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const url = `${config.supabase.url}/rest/v1/sentinel_notifications`
      + `?read_at=not.is.null`
      + `&received_at=gte.${encodeURIComponent(since)}`
      + `&select=received_at,read_at`
      + `&limit=2000`;

    try {
      const res = await fetch(url, {
        headers: {
          'apikey': key,
          'Authorization': `Bearer ${key}`,
        },
      });
      if (!res.ok) return [];

      const rows = await res.json() as { received_at: string; read_at: string }[];

      // Group by hour-of-day and calculate average latency
      const buckets: Record<number, number[]> = {};
      for (const row of rows) {
        const receivedMs = new Date(row.received_at).getTime();
        const readMs = new Date(row.read_at).getTime();
        const latencyMin = (readMs - receivedMs) / 60_000;

        // Ignore implausible values (< 0 or > 8 hours — likely batch reads, not real latency)
        if (latencyMin < 0 || latencyMin > 480) continue;

        const hour = new Date(row.received_at).getHours();
        if (!buckets[hour]) buckets[hour] = [];
        buckets[hour].push(latencyMin);
      }

      return Object.entries(buckets)
        .map(([h, samples]) => ({
          hour: parseInt(h, 10),
          avgMinutes: samples.reduce((a, b) => a + b, 0) / samples.length,
          samples: samples.length,
        }))
        .filter(h => h.samples >= MIN_SAMPLES_PER_HOUR)
        .sort((a, b) => a.hour - b.hour);
    } catch (err) {
      console.error('[sound-director] latency query failed:', (err as Error).message);
      return [];
    }
  }

  /** Generate a weekly sound suggestion. Returns null if not enough data. */
  async generateSuggestion(): Promise<SoundSuggestion | null> {
    const enoughData = await this.hasEnoughData();
    const weekStart = this.getWeekStart();

    // Even without enough data for real analysis, return a placeholder
    if (!enoughData) {
      return {
        weekStart,
        lowAttentionHours: [],
        medianLatencyMinutes: 0,
        hourlyData: [],
        suggestion: 'Not enough data yet (need 2+ weeks of acknowledged notifications). Check back next week!',
        hasEnoughData: false,
      };
    }

    const hourlyData = await this.analyzeAckLatency();
    if (hourlyData.length === 0) {
      return null;
    }

    // Calculate median latency
    const allLatencies = hourlyData.map(h => h.avgMinutes).sort((a, b) => a - b);
    const median = allLatencies[Math.floor(allLatencies.length / 2)] ?? 0;

    // Identify low-attention hours (> 1.5x median)
    const lowAttentionHours = hourlyData
      .filter(h => h.avgMinutes > median * LOW_ATTENTION_MULTIPLIER)
      .map(h => h.hour);

    const suggestionText = lowAttentionHours.length > 0
      ? await generateSoundSuggestion(hourlyData, median)
      : `Great attention span! No hours exceeded ${LOW_ATTENTION_MULTIPLIER}x the median response time (${median.toFixed(1)} min). No sound changes needed.`;

    return {
      weekStart,
      lowAttentionHours,
      medianLatencyMinutes: median,
      hourlyData,
      suggestion: suggestionText,
      hasEnoughData: true,
    };
  }

  /** Persist suggestion to DB and return it. */
  async saveSuggestion(suggestion: SoundSuggestion): Promise<void> {
    const key = config.supabase.serviceKey || config.supabase.anonKey;
    if (!config.supabase.url || !key) return;

    const url = `${config.supabase.url}/rest/v1/sentinel_sound_suggestions`;
    fetch(url, {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify({
        week_start: suggestion.weekStart,
        suggestion: { text: suggestion.suggestion, lowAttentionHours: suggestion.lowAttentionHours },
        hours_analyzed: suggestion.hourlyData.length,
        samples_used: suggestion.hourlyData.reduce((s, h) => s + h.samples, 0),
        posted_at: new Date().toISOString(),
      }),
    }).catch(err => console.warn('[sound-director] save failed:', err.message));
  }

  private getWeekStart(): string {
    const now = new Date();
    const day = now.getDay(); // 0=Sun
    const diff = now.getDate() - day;
    const sunday = new Date(now.setDate(diff));
    return sunday.toISOString().split('T')[0]!;
  }
}
