import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import express, { Request, Response } from "express";
import { z } from "zod";

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3100", 10);
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const OLLAMA_URL = process.env.OLLAMA_URL || "http://ollama:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = process.env.R2_BUCKET || "az-lab-memory";

const HA_URL = process.env.HA_URL || "";
const HA_TOKEN = process.env.HA_TOKEN || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Security Scanner ─────────────────────────────────────────────────────────
const THREAT_PATTERNS: Array<[RegExp, string]> = [
  [/ignore\s+(previous|all|above|prior)\s+instructions/i, "prompt_injection"],
  [/you\s+are\s+now\s+/i, "role_hijack"],
  [/do\s+not\s+tell\s+the\s+user/i, "deception_hide"],
  [/system\s+prompt\s+override/i, "sys_prompt_override"],
  [/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, "disregard_rules"],
  [/act\s+as\s+(if|though)\s+you\s+(have\s+no|don'?t\s+have)\s+(restrictions|limits|rules)/i, "bypass_restrictions"],
  [/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_curl"],
  [/wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_wget"],
  [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, "read_secrets"],
  [/authorized_keys/i, "ssh_backdoor"],
  [/\$HOME\/\.ssh|~\/\.ssh/i, "ssh_access"],
  [/pretend\s+(you\s+are|to\s+be)\s+(a\s+)?(different|new|another)/i, "persona_hijack"],
  [/your\s+(new\s+)?(instructions?|rules?|directives?)\s+are/i, "instruction_override"],
  [/\u200b|\u200c|\u200d|\u2060|\ufeff|[\u202a-\u202e]/, "invisible_unicode"],
];

function scanContent(text: string): string | null {
  for (const [pattern, threatId] of THREAT_PATTERNS) {
    if (pattern.test(text)) return threatId;
  }
  return null;
}

// ── Embeddings ───────────────────────────────────────────────────────────────
async function embed(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const json = await res.json() as { embedding: number[] };
    return json.embedding;
  } catch {
    return null; // Ollama unavailable — degrade gracefully
  }
}

function embedInput(name: string, description: string, content: string): string {
  return `${name}: ${description}\n\n${content}`.slice(0, 4000);
}

// R2 client (optional — file tools disabled if not configured)
const r2Enabled = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);
const r2 = r2Enabled
  ? new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

// ── MCP Server Factory ───────────────────────────────────────────────────────
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "memory-mcp-server",
    version: "3.1.0",
  });

  // ── Tool: remember ──────────────────────────────────────────────────────────
  server.tool(
    "remember",
    "Store a new memory or update an existing one. Use this when you learn something worth keeping.",
    {
      type: z.enum(["user", "feedback", "project", "reference"]).describe(
        "Memory type: user (about the user), feedback (how to work), project (ongoing work), reference (where to find things)"
      ),
      name: z.string().describe("Short, unique name for this memory"),
      description: z.string().describe("One-line description — used to decide relevance later"),
      content: z.string().describe("Full memory content. For feedback/project types, include Why and How to apply."),
      tags: z.array(z.string()).optional().describe("Tags for categorization and search"),
      source: z.string().optional().describe("Who is writing: claude-code, claude-ai, manual"),
    },
    async ({ type, name, description, content, tags, source }) => {
      // Security gate — scan all text fields before touching the DB
      const scanTargets: Array<[string, string]> = [
        ["name", name], ["description", description], ["content", content],
      ];
      for (const [field, value] of scanTargets) {
        const threat = scanContent(value);
        if (threat) {
          return { content: [{ type: "text" as const, text: `Blocked: ${field} matches threat pattern '${threat}'. Memory not written.` }] };
        }
      }

      const src = source || "claude-code";
      const memTags = tags || [];

      const { data: existing } = await supabase
        .from("memories")
        .select("id")
        .eq("name", name)
        .maybeSingle();

      const embedding = await embed(embedInput(name, description, content));
      const embedNote = embedding ? "" : " (no embedding — Ollama unavailable)";

      if (existing) {
        const update: Record<string, unknown> = { type, description, content, tags: memTags, source: src };
        if (embedding) update.embedding = JSON.stringify(embedding);
        const { error } = await supabase.from("memories").update(update).eq("id", existing.id);
        if (error) return { content: [{ type: "text" as const, text: `Error updating memory: ${error.message}` }] };
        return { content: [{ type: "text" as const, text: `Updated memory "${name}" (${type})${embedNote}` }] };
      }

      const insert: Record<string, unknown> = { type, name, description, content, tags: memTags, source: src };
      if (embedding) insert.embedding = JSON.stringify(embedding);
      const { error } = await supabase.from("memories").insert(insert);

      if (error) return { content: [{ type: "text" as const, text: `Error creating memory: ${error.message}` }] };
      return { content: [{ type: "text" as const, text: `Stored new ${type} memory "${name}"${embedNote}` }] };
    }
  );

  // ── Tool: recall ────────────────────────────────────────────────────────────
  server.tool(
    "recall",
    "Search memories by text, tags, or type. Uses semantic vector search when Ollama is available, falls back to keyword search.",
    {
      query: z.string().optional().describe("Free-text or semantic search query"),
      type: z.enum(["user", "feedback", "project", "reference"]).optional().describe("Filter by memory type"),
      tags: z.array(z.string()).optional().describe("Filter by tags (any match)"),
      limit: z.number().optional().describe("Max results (default 10)"),
      semantic: z.boolean().optional().describe("Force semantic search (default: true when Ollama available)"),
    },
    async ({ query, type, tags, limit, semantic }) => {
      const maxResults = limit || 10;

      // Try semantic search when query is provided and semantic not explicitly disabled
      if (query && semantic !== false) {
        const queryEmbedding = await embed(query);
        if (queryEmbedding) {
          const { data, error } = await supabase.rpc("match_memories", {
            query_embedding: JSON.stringify(queryEmbedding),
            match_count: maxResults,
            filter_type: type || null,
          });

          if (!error && data && data.length > 0) {
            // Apply tag filter client-side (rpc doesn't support it)
            const filtered = tags?.length
              ? data.filter((m: any) => tags.some((t) => m.tags?.includes(t)))
              : data;

            if (filtered.length > 0) {
              const results = filtered.map((m: any) => {
                const tagStr = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
                const sim = m.similarity ? ` (${(m.similarity * 100).toFixed(0)}% match)` : "";
                return `## ${m.name} (${m.type})${tagStr}${sim}\n_${m.description}_\n\n${m.content}`;
              });
              return {
                content: [{ type: "text" as const, text: `Found ${filtered.length} memor${filtered.length === 1 ? "y" : "ies"} (semantic):\n\n${results.join("\n\n---\n\n")}` }],
              };
            }
          }
          // Fall through to keyword search if semantic returns nothing
        }
      }

      // Keyword / filter search fallback
      let q = supabase
        .from("memories")
        .select("id, type, name, description, content, tags, source, updated_at")
        .order("updated_at", { ascending: false })
        .limit(maxResults);

      if (type) q = q.eq("type", type);
      if (tags && tags.length > 0) q = q.overlaps("tags", tags);
      if (query) q = q.or(`name.ilike.%${query}%,description.ilike.%${query}%,content.ilike.%${query}%`);

      const { data, error } = await q;

      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      if (!data || data.length === 0) return { content: [{ type: "text" as const, text: "No memories found." }] };

      const results = data.map((m) => {
        const tagStr = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
        return `## ${m.name} (${m.type})${tagStr}\n_${m.description}_\n_Updated: ${m.updated_at} | Source: ${m.source}_\n\n${m.content}`;
      });

      return {
        content: [{ type: "text" as const, text: `Found ${data.length} memor${data.length === 1 ? "y" : "ies"} (keyword):\n\n${results.join("\n\n---\n\n")}` }],
      };
    }
  );

  // ── Tool: forget ────────────────────────────────────────────────────────────
  server.tool(
    "forget",
    "Delete a memory by name. The audit log preserves what was deleted.",
    {
      name: z.string().describe("Exact name of the memory to delete"),
    },
    async ({ name }) => {
      const { data: existing } = await supabase
        .from("memories")
        .select("id")
        .eq("name", name)
        .maybeSingle();

      if (!existing) return { content: [{ type: "text" as const, text: `No memory found with name "${name}"` }] };

      const { error } = await supabase.from("memories").delete().eq("id", existing.id);

      if (error) return { content: [{ type: "text" as const, text: `Error deleting: ${error.message}` }] };
      return { content: [{ type: "text" as const, text: `Deleted memory "${name}". Audit log preserved.` }] };
    }
  );

  // ── Tool: list_memories ─────────────────────────────────────────────────────
  server.tool(
    "list_memories",
    "List all memories with their names, types, and descriptions. Quick overview of everything stored.",
    {
      type: z.enum(["user", "feedback", "project", "reference"]).optional().describe("Filter by type"),
    },
    async ({ type }) => {
      let q = supabase
        .from("memories")
        .select("type, name, description, tags, source, updated_at")
        .order("type")
        .order("name");

      if (type) q = q.eq("type", type);

      const { data, error } = await q;

      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      if (!data || data.length === 0) return { content: [{ type: "text" as const, text: "No memories stored." }] };

      const grouped: Record<string, string[]> = {};
      for (const m of data) {
        if (!grouped[m.type]) grouped[m.type] = [];
        const tagStr = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
        grouped[m.type].push(`- **${m.name}**${tagStr} — ${m.description}`);
      }

      const sections = Object.entries(grouped)
        .map(([t, items]) => `### ${t}\n${items.join("\n")}`)
        .join("\n\n");

      return {
        content: [{ type: "text" as const, text: `${data.length} memories:\n\n${sections}` }],
      };
    }
  );

  // ── Tool: memory_log ────────────────────────────────────────────────────────
  server.tool(
    "memory_log",
    "View the audit trail of memory changes. See what was created, updated, or deleted and when.",
    {
      limit: z.number().optional().describe("Max entries (default 20)"),
      memory_name: z.string().optional().describe("Filter by memory name"),
    },
    async ({ limit, memory_name }) => {
      const maxEntries = limit || 20;

      let q = supabase
        .from("memory_log")
        .select("id, memory_id, action, old_content, new_content, source, created_at")
        .order("created_at", { ascending: false })
        .limit(maxEntries);

      if (memory_name) {
        const { data: mem } = await supabase
          .from("memories")
          .select("id")
          .eq("name", memory_name)
          .maybeSingle();

        if (mem) q = q.eq("memory_id", mem.id);
      }

      const { data, error } = await q;

      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      if (!data || data.length === 0) return { content: [{ type: "text" as const, text: "No log entries found." }] };

      const entries = data.map((e) => {
        const preview = e.new_content
          ? e.new_content.substring(0, 100) + (e.new_content.length > 100 ? "..." : "")
          : e.old_content
            ? e.old_content.substring(0, 100) + "..."
            : "";
        return `- **${e.action}** (${e.source}) at ${e.created_at}\n  ${preview}`;
      });

      return {
        content: [{ type: "text" as const, text: `${data.length} log entries:\n\n${entries.join("\n\n")}` }],
      };
    }
  );

  // ── Tool: remember_file ─────────────────────────────────────────────────────
  if (r2) {
    server.tool(
      "remember_file",
      "Upload a file (image, config, doc, etc.) to persistent storage and link it to a memory. Pass file content as base64.",
      {
        filename: z.string().describe("Original filename with extension (e.g. network-diagram.png)"),
        content_base64: z.string().describe("File content encoded as base64"),
        content_type: z.string().optional().describe("MIME type (e.g. image/png, application/pdf). Auto-detected from extension if omitted."),
        memory_name: z.string().optional().describe("Link to an existing memory by name"),
        description: z.string().optional().describe("What this file is — used for searching later"),
        tags: z.array(z.string()).optional().describe("Tags for categorization"),
      },
      async ({ filename, content_base64, content_type, memory_name, description, tags }) => {
        const mimeMap: Record<string, string> = {
          png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
          webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf",
          json: "application/json", yaml: "text/yaml", yml: "text/yaml",
          txt: "text/plain", md: "text/markdown", csv: "text/csv",
          zip: "application/zip", tar: "application/x-tar",
        };
        const ext = filename.split(".").pop()?.toLowerCase() || "";
        const mime = content_type || mimeMap[ext] || "application/octet-stream";

        const key = `files/${Date.now()}-${filename}`;
        const body = Buffer.from(content_base64, "base64");

        try {
          await r2!.send(new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: key,
            Body: body,
            ContentType: mime,
          }));
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `R2 upload failed: ${err.message}` }] };
        }

        // Store file reference in Supabase
        const fileRecord = {
          r2_key: key,
          filename,
          content_type: mime,
          size_bytes: body.length,
          description: description || filename,
          tags: tags || [],
          memory_name: memory_name || null,
        };

        const { error } = await supabase.from("memory_files").insert(fileRecord);
        if (error) {
          return { content: [{ type: "text" as const, text: `File uploaded to R2 but DB insert failed: ${error.message}. Key: ${key}` }] };
        }

        return {
          content: [{ type: "text" as const, text: `Stored file "${filename}" (${(body.length / 1024).toFixed(1)} KB, ${mime})\nR2 key: ${key}${memory_name ? `\nLinked to memory: ${memory_name}` : ""}` }],
        };
      }
    );

    // ── Tool: recall_file ───────────────────────────────────────────────────────
    server.tool(
      "recall_file",
      "Get a download URL for a stored file, or list stored files. URLs are presigned and valid for 1 hour.",
      {
        filename: z.string().optional().describe("Search by filename (partial match)"),
        memory_name: z.string().optional().describe("Get files linked to a memory"),
        tags: z.array(z.string()).optional().describe("Filter by tags"),
        list_only: z.boolean().optional().describe("Just list files without generating URLs (default false)"),
      },
      async ({ filename, memory_name, tags, list_only }) => {
        let q = supabase
          .from("memory_files")
          .select("id, r2_key, filename, content_type, size_bytes, description, tags, memory_name, created_at")
          .order("created_at", { ascending: false })
          .limit(20);

        if (filename) q = q.ilike("filename", `%${filename}%`);
        if (memory_name) q = q.eq("memory_name", memory_name);
        if (tags && tags.length > 0) q = q.overlaps("tags", tags);

        const { data, error } = await q;

        if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
        if (!data || data.length === 0) return { content: [{ type: "text" as const, text: "No files found." }] };

        if (list_only) {
          const list = data.map((f) => {
            const size = f.size_bytes > 1024 * 1024
              ? `${(f.size_bytes / 1024 / 1024).toFixed(1)} MB`
              : `${(f.size_bytes / 1024).toFixed(1)} KB`;
            const tagStr = f.tags?.length ? ` [${f.tags.join(", ")}]` : "";
            return `- **${f.filename}** (${size}, ${f.content_type})${tagStr}\n  ${f.description}${f.memory_name ? ` | linked: ${f.memory_name}` : ""}`;
          });
          return { content: [{ type: "text" as const, text: `${data.length} files:\n\n${list.join("\n")}` }] };
        }

        // Generate presigned URLs
        const results = await Promise.all(data.map(async (f) => {
          const url = await getSignedUrl(r2!, new GetObjectCommand({
            Bucket: R2_BUCKET,
            Key: f.r2_key,
          }), { expiresIn: 3600 });

          const size = f.size_bytes > 1024 * 1024
            ? `${(f.size_bytes / 1024 / 1024).toFixed(1)} MB`
            : `${(f.size_bytes / 1024).toFixed(1)} KB`;

          return `## ${f.filename} (${size})\n${f.description}\nURL (1h): ${url}`;
        }));

        return {
          content: [{ type: "text" as const, text: `${data.length} file${data.length === 1 ? "" : "s"}:\n\n${results.join("\n\n---\n\n")}` }],
        };
      }
    );

    // ── Tool: forget_file ───────────────────────────────────────────────────────
    server.tool(
      "forget_file",
      "Delete a stored file from R2 and its database record.",
      {
        filename: z.string().describe("Exact filename to delete"),
      },
      async ({ filename }) => {
        const { data: file } = await supabase
          .from("memory_files")
          .select("id, r2_key")
          .eq("filename", filename)
          .maybeSingle();

        if (!file) return { content: [{ type: "text" as const, text: `No file found: "${filename}"` }] };

        try {
          await r2!.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: file.r2_key }));
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `R2 delete failed: ${err.message}` }] };
        }

        const { error } = await supabase.from("memory_files").delete().eq("id", file.id);
        if (error) return { content: [{ type: "text" as const, text: `R2 file deleted but DB cleanup failed: ${error.message}` }] };

        return { content: [{ type: "text" as const, text: `Deleted file "${filename}" from storage and database.` }] };
      }
    );
  }

  // ── Tool: save_skill ────────────────────────────────────────────────────────
  server.tool(
    "save_skill",
    "Save a skill — procedural knowledge about how to accomplish a specific type of task. Call this after completing a complex task (5+ steps) to capture the approach for future sessions.",
    {
      name: z.string().describe("Short slug, e.g. 'deploy-podman-compose-service'"),
      title: z.string().describe("Human-readable title, e.g. 'Deploy a Podman Compose Service'"),
      description: z.string().describe("One-line summary shown in skill index — when to use this skill"),
      content: z.string().describe("Full skill content: steps, gotchas, examples, commands. Markdown."),
      triggers: z.array(z.string()).optional().describe("Phrases that indicate this skill applies, e.g. ['deploy service', 'podman compose']"),
      platforms: z.array(z.string()).optional().describe("Platforms this applies to, e.g. ['linux', 'podman', 'svc-podman-01']"),
      source: z.string().optional().describe("Source interface (default: claude-code)"),
    },
    async ({ name, title, description, content, triggers, platforms, source }) => {
      // Security gate
      for (const [field, value] of [["name", name], ["title", title], ["description", description], ["content", content]] as Array<[string, string]>) {
        const threat = scanContent(value);
        if (threat) return { content: [{ type: "text" as const, text: `Blocked: ${field} matches threat pattern '${threat}'. Skill not saved.` }] };
      }

      const src = source || "claude-code";
      const skillTriggers = triggers || [];
      const skillPlatforms = platforms || [];
      const embedding = await embed(embedInput(name, description, content));

      const { data: existing } = await supabase.from("skills").select("id").eq("name", name).maybeSingle();

      if (existing) {
        const update: Record<string, unknown> = { title, description, content, triggers: skillTriggers, platforms: skillPlatforms, source: src };
        if (embedding) update.embedding = JSON.stringify(embedding);
        const { error } = await supabase.from("skills").update(update).eq("id", existing.id);
        if (error) return { content: [{ type: "text" as const, text: `Error updating skill: ${error.message}` }] };
        return { content: [{ type: "text" as const, text: `Updated skill "${name}"` }] };
      }

      const insert: Record<string, unknown> = { name, title, description, content, triggers: skillTriggers, platforms: skillPlatforms, source: src };
      if (embedding) insert.embedding = JSON.stringify(embedding);
      const { error } = await supabase.from("skills").insert(insert);
      if (error) return { content: [{ type: "text" as const, text: `Error saving skill: ${error.message}` }] };
      return { content: [{ type: "text" as const, text: `Saved new skill "${name}" — "${title}"` }] };
    }
  );

  // ── Tool: recall_skill ───────────────────────────────────────────────────────
  server.tool(
    "recall_skill",
    "Find a skill by semantic search or name. Returns full content of matching skills.",
    {
      query: z.string().optional().describe("What you're trying to do — semantic search"),
      name: z.string().optional().describe("Exact skill name to retrieve"),
      limit: z.number().optional().describe("Max results (default 3)"),
    },
    async ({ query, name, limit }) => {
      const maxResults = limit || 3;

      if (name) {
        const { data, error } = await supabase.from("skills").select("*").eq("name", name).maybeSingle();
        if (error || !data) return { content: [{ type: "text" as const, text: `Skill "${name}" not found.` }] };
        await supabase.from("skills").update({ use_count: (data.use_count || 0) + 1 }).eq("id", data.id);
        return { content: [{ type: "text" as const, text: `# ${data.title}\n_${data.description}_\n\n${data.content}` }] };
      }

      if (query) {
        const queryEmbedding = await embed(query);
        if (queryEmbedding) {
          const { data, error } = await supabase.rpc("match_skills", { query_embedding: JSON.stringify(queryEmbedding), match_count: maxResults });
          if (!error && data?.length > 0) {
            for (const s of data) await supabase.from("skills").update({ use_count: (s.use_count || 0) + 1 }).eq("id", s.id);
            const results = data.map((s: any) => `# ${s.title} (${(s.similarity * 100).toFixed(0)}% match)\n_${s.description}_\n\n${s.content}`);
            return { content: [{ type: "text" as const, text: results.join("\n\n---\n\n") }] };
          }
        }
        // keyword fallback
        const { data, error } = await supabase.from("skills").select("*")
          .or(`name.ilike.%${query}%,title.ilike.%${query}%,description.ilike.%${query}%`).limit(maxResults);
        if (error || !data?.length) return { content: [{ type: "text" as const, text: "No matching skills found." }] };
        const results = data.map((s) => `# ${s.title}\n_${s.description}_\n\n${s.content}`);
        return { content: [{ type: "text" as const, text: results.join("\n\n---\n\n") }] };
      }

      return { content: [{ type: "text" as const, text: "Provide a query or name." }] };
    }
  );

  // ── Tool: list_skills ────────────────────────────────────────────────────────
  server.tool(
    "list_skills",
    "List all saved skills with their names and descriptions. Quick index of what procedural knowledge is available.",
    {},
    async () => {
      const { data, error } = await supabase.from("skills")
        .select("name, title, description, triggers, use_count, updated_at")
        .order("use_count", { ascending: false });
      if (error || !data?.length) return { content: [{ type: "text" as const, text: "No skills saved yet." }] };
      const lines = data.map((s) => {
        const t = s.triggers?.length ? ` [${s.triggers.slice(0, 3).join(", ")}]` : "";
        return `- **${s.name}**${t} — ${s.description} (used ${s.use_count}x)`;
      });
      return { content: [{ type: "text" as const, text: `${data.length} skills:\n\n${lines.join("\n")}` }] };
    }
  );

  // ── Tool: delete_skill ───────────────────────────────────────────────────────
  server.tool(
    "delete_skill",
    "Delete a skill by name when it's outdated or replaced by a better approach.",
    {
      name: z.string().describe("Exact skill name to delete"),
    },
    async ({ name }) => {
      const { error } = await supabase.from("skills").delete().eq("name", name);
      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      return { content: [{ type: "text" as const, text: `Deleted skill "${name}".` }] };
    }
  );

  // ── Home Assistant Tools ─────────────────────────────────────────────────────
  if (HA_URL && HA_TOKEN) {
    const haFetch = async (path: string, method = "GET", body?: object) => {
      const res = await fetch(`${HA_URL}/api${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${HA_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HA API ${res.status}: ${await res.text()}`);
      return res.json();
    };

    // ── Tool: ha_get_states ────────────────────────────────────────────────────
    server.tool(
      "ha_get_states",
      "Get Home Assistant entity states. Optionally filter by domain (light, switch, climate, sensor, etc.) or entity_id prefix.",
      {
        domain: z.string().optional().describe("Filter by domain: light, switch, climate, sensor, binary_sensor, media_player, person, device_tracker, etc."),
        search: z.string().optional().describe("Filter by entity_id substring or friendly_name"),
      },
      async ({ domain, search }) => {
        const states = await haFetch("/states") as Array<{ entity_id: string; state: string; attributes: Record<string, unknown> }>;
        let filtered = states;
        if (domain) filtered = filtered.filter((s) => s.entity_id.startsWith(`${domain}.`));
        if (search) {
          const q = search.toLowerCase();
          filtered = filtered.filter((s) =>
            s.entity_id.includes(q) ||
            String(s.attributes.friendly_name || "").toLowerCase().includes(q)
          );
        }
        const lines = filtered.map((s) => {
          const name = s.attributes.friendly_name || s.entity_id;
          const extra: string[] = [];
          if (s.attributes.temperature !== undefined) extra.push(`temp=${s.attributes.temperature}`);
          if (s.attributes.brightness !== undefined) extra.push(`brightness=${s.attributes.brightness}`);
          if (s.attributes.battery_level !== undefined) extra.push(`battery=${s.attributes.battery_level}%`);
          return `${s.entity_id}: **${s.state}**  (${name})${extra.length ? "  " + extra.join(", ") : ""}`;
        });
        return { content: [{ type: "text" as const, text: filtered.length ? lines.join("\n") : "No matching entities." }] };
      }
    );

    // ── Tool: ha_call_service ──────────────────────────────────────────────────
    server.tool(
      "ha_call_service",
      "Call a Home Assistant service to control devices. Examples: turn on/off lights, set climate, trigger automations.",
      {
        domain: z.string().describe("Service domain: light, switch, climate, automation, script, media_player, etc."),
        service: z.string().describe("Service name: turn_on, turn_off, toggle, set_temperature, trigger, etc."),
        entity_id: z.string().optional().describe("Target entity ID, or comma-separated list. Omit for services that don't need one."),
        data: z.record(z.unknown()).optional().describe("Additional service data (e.g. temperature, brightness, hvac_mode)"),
      },
      async ({ domain, service, entity_id, data }) => {
        const payload: Record<string, unknown> = { ...data };
        if (entity_id) payload.entity_id = entity_id;
        await haFetch(`/services/${domain}/${service}`, "POST", payload);
        const target = entity_id || `${domain}.${service}`;
        return { content: [{ type: "text" as const, text: `Called ${domain}.${service} on ${target} ✅` }] };
      }
    );

    // ── Tool: ha_get_history ───────────────────────────────────────────────────
    server.tool(
      "ha_get_history",
      "Get state history for a Home Assistant entity over the past N hours.",
      {
        entity_id: z.string().describe("Entity ID to get history for"),
        hours: z.number().optional().describe("Hours of history to fetch (default 24, max 168)"),
      },
      async ({ entity_id, hours = 24 }) => {
        const start = new Date(Date.now() - hours * 3600 * 1000).toISOString();
        const data = await haFetch(`/history/period/${start}?filter_entity_id=${entity_id}`) as Array<Array<{ state: string; last_changed: string }>>;
        const history = data?.[0] || [];
        if (!history.length) return { content: [{ type: "text" as const, text: `No history for ${entity_id} in the last ${hours}h.` }] };
        const lines = history.slice(-50).map((s) => {
          const ts = new Date(s.last_changed).toLocaleString();
          return `${ts}: ${s.state}`;
        });
        return { content: [{ type: "text" as const, text: `${entity_id} — last ${lines.length} state changes:\n\n${lines.join("\n")}` }] };
      }
    );
  }

  return server;
}

// ── Express + Transport ─────────────────────────────────────────────────────
const app = express();

const haEnabled = !!(HA_URL && HA_TOKEN);

app.get("/health", (_req: Request, res: Response) => {
  const toolCount = (r2 ? 12 : 9) + (haEnabled ? 3 : 0);
  res.json({ status: "ok", service: "memory-mcp-server", version: "3.1.0", tools: toolCount, r2: r2Enabled, ha: haEnabled });
});

// Map to store transports and their servers by session ID
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }

  // New session — new server instance
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
  const server = createMcpServer();

  transport.onclose = () => {
    const sid = (transport as any).sessionId;
    if (sid) sessions.delete(sid);
  };

  await server.connect(transport);
  await transport.handleRequest(req, res);

  // Session ID is set during handleRequest, so store after
  const sid = (transport as any).sessionId;
  if (sid) sessions.set(sid, { transport, server });
});

// Handle GET for SSE streams
app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "No session. Send POST /mcp first." });
});

// Handle DELETE for session cleanup
app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
    sessions.delete(sessionId);
    return;
  }
  res.status(400).json({ error: "No session found." });
});

app.listen(PORT, "0.0.0.0", () => {
  const toolCount = (r2 ? 12 : 9) + (haEnabled ? 3 : 0);
  console.log(`Memory MCP Server v3.1.0 — http://0.0.0.0:${PORT}/mcp (${toolCount} tools, R2: ${r2Enabled ? "enabled" : "disabled"}, HA: ${haEnabled ? "enabled" : "disabled"})`);
  console.log(`Health check — http://0.0.0.0:${PORT}/health`);
});
