import * as fs from 'fs';
import * as path from 'path';

const NEMOTRON_BASE = process.env.NEMOTRON_URL || 'http://192.168.1.183:8000';
const NEMOTRON_MODEL = process.env.NEMOTRON_MODEL || 'nvidia/nemotron-3-super-120b-a12b';

function getApiKey(): string {
  const fromEnv = process.env.NVIDIA_API_KEY;
  if (fromEnv) return fromEnv;
  try {
    const keyPath = path.join(process.env.HOME || '/root', '.nvidia_api_key');
    return fs.readFileSync(keyPath, 'utf8').trim();
  } catch {
    return '';
  }
}

export interface ParsedSearchQuery {
  dateRange?: { from?: string; to?: string };
  source?: string;
  severity?: string;
  categories?: string[];
  keywords?: string[];
  days?: number;
}

/** Parse a natural-language notification query into structured filters using Nemotron. */
export async function parseSearchQuery(query: string): Promise<ParsedSearchQuery> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn('[nemotron] no API key — falling back to keyword-only search');
    return { keywords: query.split(/\s+/).filter(w => w.length > 2) };
  }

  const systemPrompt = `You parse homelab notification search queries into structured JSON filters.
Return ONLY valid JSON matching this schema (all fields optional):
{
  "dateRange": { "from": "<ISO date>", "to": "<ISO date>" },
  "source": "<one of: task_queue, home_assistant, discord, grafana, services, agent_health, goals>",
  "severity": "<one of: critical, warning, info>",
  "categories": ["<category strings>"],
  "keywords": ["<search terms>"],
  "days": <integer, days back to search>
}

Today is ${new Date().toISOString().split('T')[0]}.
Interpret relative dates: "last month" = 30 days, "last week" = 7 days, "yesterday" = 1 day.
Source aliases: "containers/services/prometheus" → "services", "HA/home assistant" → "home_assistant",
"tasks/queue" → "task_queue", "grafana/alerts" → "grafana", "agents/heartbeat" → "agent_health".
Severity aliases: "down/critical/urgent" → "critical", "warning/warn" → "warning".
Return ONLY the JSON object, no explanation.`;

  try {
    const res = await fetch(`${NEMOTRON_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: NEMOTRON_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query },
        ],
        max_tokens: 256,
        temperature: 0.1,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Nemotron ${res.status}: ${text}`);
    }

    const data = await res.json() as { choices: { message: { content: string } }[] };
    const content = data.choices[0]?.message?.content?.trim() ?? '{}';

    // Strip markdown code fences if present
    const jsonStr = content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    return JSON.parse(jsonStr) as ParsedSearchQuery;
  } catch (err) {
    console.error('[nemotron] parseSearchQuery failed:', (err as Error).message);
    // Fallback: basic keyword extraction
    return { keywords: query.split(/\s+/).filter(w => w.length > 2) };
  }
}

/** Generate a sound suggestion from hourly latency data using Nemotron. */
export async function generateSoundSuggestion(
  hourlyLatency: { hour: number; avgMinutes: number; samples: number }[],
  medianLatency: number,
): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) return '';

  const dataStr = hourlyLatency
    .map(h => `Hour ${h.hour}:00 — avg ${h.avgMinutes.toFixed(1)} min to acknowledge (${h.samples} samples)`)
    .join('\n');

  const prompt = `You are analyzing homelab notification acknowledgment patterns.
Median response time across all hours: ${medianLatency.toFixed(1)} minutes.

Hourly data:
${dataStr}

Identify 2-3 hours where acknowledgment is slowest (>1.5x median).
Recommend specific sound changes for the az-lab Sentinel browser extension:
- Which hours need louder/more urgent alert sounds
- Brief explanation of the pattern you see

Keep it under 150 words, casual tone. Format as bullet points.`;

  try {
    const res = await fetch(`${NEMOTRON_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: NEMOTRON_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0.7,
      }),
    });

    if (!res.ok) throw new Error(`Nemotron ${res.status}`);
    const data = await res.json() as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message?.content?.trim() ?? '';
  } catch (err) {
    console.error('[nemotron] generateSoundSuggestion failed:', (err as Error).message);
    return '';
  }
}
