import { createClient } from "@supabase/supabase-js";
const s = createClient("https://x.supabase.co", "key");
const methods = [];
for (const p of Object.getOwnPropertyNames(Object.getPrototypeOf(s))) methods.push(p);
console.log("SupabaseClient methods:", methods.join(", "));
console.log("has sql:", typeof s.sql);
