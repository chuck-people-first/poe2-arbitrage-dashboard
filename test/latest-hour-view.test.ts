import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("latest-hour public view proposal", () => {
  it("keeps security invoker and filters each league to its latest source hour", () => {
    const sql = readFileSync("supabase/migrations/013_latest_hour_view.sql", "utf8");
    expect(sql).toContain("security_invoker = true");
    expect(sql).toContain("max(latest_row.source_hour)");
    expect(sql).toContain("latest_row.league = current_row.league");
  });
});
