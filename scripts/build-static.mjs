import { mkdirSync, writeFileSync } from "node:fs";

const url = process.env.POE2_SUPABASE_URL ?? "";
const key = process.env.POE2_SUPABASE_PUBLISHABLE_KEY ?? "";
mkdirSync("public", { recursive: true });
writeFileSync("public/config.js", `window.POE2_SUPABASE_URL=${JSON.stringify(url)};window.POE2_SUPABASE_PUBLISHABLE_KEY=${JSON.stringify(key)};\n`);
console.log(`Generated public/config.js (${url ? "Supabase URL configured" : "empty connection state"})`);
