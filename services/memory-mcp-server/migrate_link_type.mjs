import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "https://ogqjjlbupqnvlcyrfnxi.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_KEY) {
  throw new Error("SUPABASE_SECRET_KEY is required");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Check current schema
const { data, error } = await supabase
  .from("memory_links")
  .select("*")
  .limit(1);

console.log("Sample row:", JSON.stringify(data));
console.log("Error:", error);
