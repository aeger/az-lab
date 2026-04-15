// Migration 004: PageRank scoring
// Run from the memory-mcp-server directory: node apply_pagerank_migration.mjs

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ogqjjlbupqnvlcyrfnxi.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || readFileSync("/home/almty1/azlab/services/memory-mcp-server/.env", "utf8")
  .split("\n").find(l => l.startsWith("SUPABASE_SERVICE_KEY="))?.split("=").slice(1).join("=") || "";

console.log("Supabase URL:", SUPABASE_URL);
console.log("Service key length:", SUPABASE_KEY.length);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Step 1: Check if pagerank_score column exists
const { data: colCheck, error: colError } = await supabase
  .from("memories")
  .select("pagerank_score")
  .limit(1);

if (colError?.message?.includes("pagerank_score")) {
  console.log("Step 1: pagerank_score column missing — need DDL access");
  console.log("ERROR:", colError.message);
  console.log("");
  console.log("=== MANUAL STEPS REQUIRED ===");
  console.log("Apply migrations/004_pagerank.sql in the Supabase SQL Editor:");
  console.log("https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new");
  console.log("");
  process.exit(2);
} else {
  console.log("Step 1: pagerank_score column exists or already applied");
}

// Step 2: Run compute_pagerank
const { data: prResult, error: prError } = await supabase.rpc("compute_pagerank", {
  damping: 0.85,
  iterations: 20,
});
if (prError) {
  console.log("compute_pagerank not registered:", prError.message);
  process.exit(2);
} else {
  console.log("compute_pagerank result (updated rows):", prResult);
}
