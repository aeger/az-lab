// Migration: add link_type column to memory_links
// Approach: use supabase-js to call a raw SQL function via the REST API
// with the service_role key which has full Postgres privileges

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "https://ogqjjlbupqnvlcyrfnxi.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_KEY) {
  throw new Error("SUPABASE_SECRET_KEY is required");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Step 1: Create a migration helper function using the existing match_memories pattern
// We'll use the supabase REST API directly to POST to /rpc with a custom DDL function
// First, let's create it via a direct fetch to the PostgREST endpoint with a raw SQL call
// using the "Authorization" as service_role which bypasses RLS

// PostgREST doesn't support arbitrary DDL — we need to use the Supabase pg meta API
// Try: https://ogqjjlbupqnvlcyrfnxi.supabase.co/pg/columns
const metaRes = await fetch(`${SUPABASE_URL}/pg/columns`, {
  headers: {
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
  }
});
console.log("Meta API status:", metaRes.status);
if (metaRes.ok) {
  const cols = await metaRes.json();
  const linkCols = cols.filter(c => c.table_name === "memory_links");
  console.log("memory_links columns:", JSON.stringify(linkCols.map(c => c.name)));
} else {
  const text = await metaRes.text();
  console.log("Meta API response:", text.slice(0, 200));
}

// Try the pg meta API for column addition
const addColRes = await fetch(`${SUPABASE_URL}/pg/columns`, {
  method: "POST",
  headers: {
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    table_id: null, // will need table ID
    schema: "public",
    table: "memory_links",
    name: "link_type",
    type: "text",
    default_value: "semantic",
    is_nullable: false,
    check: "link_type IN ('semantic', 'temporal', 'causal', 'entity')"
  })
});
console.log("Add column status:", addColRes.status);
const addColText = await addColRes.text();
console.log("Add column response:", addColText.slice(0, 300));
