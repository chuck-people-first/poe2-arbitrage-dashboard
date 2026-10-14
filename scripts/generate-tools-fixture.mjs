// Build public/tools-sample-prices.json from the checked-in poe.ninja
// fixtures, so the Tools page still works offline and in local preview
// (python http.server cannot run /api/prices).
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { flatten } from "../api/prices.js";

const dir = "fixtures/poe-ninja";
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const payloads = files.map((f) => ({ category: f.replace(/\.json$/, ""), raw: JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) }));
// The fixture capture date is when the files were committed, not the checkout time.
const fetchedAt = new Date(execSync(`git log -1 --format=%cI -- ${dir}`, { encoding: "utf8" }).trim() || 0).toISOString();
const book = { ...flatten("Runes of Aldur", payloads, fetchedAt), sample: true };
writeFileSync("public/tools-sample-prices.json", JSON.stringify(book));
console.log(`Wrote ${book.items.length} sample prices`);
