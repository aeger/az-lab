import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://ogqjjlbupqnvlcyrfnxi.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ncWpqbGJ1cHFudmxjeXJmbnhpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDA0NTU3NiwiZXhwIjoyMDg5NjIxNTc2fQ.nxAesbiMgcogKp4rOS0VodJLI127mmMbSFMHcvRKNa0";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  db: { schema: "public" }
});

// Try calling pg_catalog functions directly via rpc with schema header
const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/pg_execute`, {
  method: "POST",
  headers: {
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    "Accept-Profile": "extensions",
  },
  body: JSON.stringify({ query: "SELECT 1" })
});
console.log("pg_execute status:", res.status, await res.text().then(t => t.slice(0, 100)));

// Try the extensions schema for dblink
const res2 = await fetch(`${SUPABASE_URL}/rest/v1/rpc/dblink_connect`, {
  method: "POST",
  headers: {
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ connname: "test", connstr: "dbname=postgres user=postgres" })
});
console.log("dblink_connect status:", res2.status, (await res2.text()).slice(0, 100));
