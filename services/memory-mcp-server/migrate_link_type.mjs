import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://ogqjjlbupqnvlcyrfnxi.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ncWpqbGJ1cHFudmxjeXJmbnhpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDA0NTU3NiwiZXhwIjoyMDg5NjIxNTc2fQ.nxAesbiMgcogKp4rOS0VodJLI127mmMbSFMHcvRKNa0"
);

// Check current schema
const { data, error } = await supabase
  .from("memory_links")
  .select("*")
  .limit(1);

console.log("Sample row:", JSON.stringify(data));
console.log("Error:", error);
