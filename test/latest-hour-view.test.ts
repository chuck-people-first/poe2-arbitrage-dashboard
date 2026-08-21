import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("latest-hour public view proposal (migration 013)", () => {
  // Normalize CRLF so string searches work identically on Windows and POSIX.
  const sql = readFileSync("supabase/migrations/013_latest_hour_view.sql", "utf8").split("\r\n").join("\n");

  it("keeps a security-invoker, security-barrier public view", () => {
    expect(sql).toContain("security_invoker = true");
    expect(sql).toContain("security_barrier = true");
  });

  it("uses a safe per-league status projection (not max(source_hour) fallback)", () => {
    expect(sql).toContain("opportunity_run_status");
    expect(sql).toContain("latest_successful_source_hour");
    expect(sql).toContain("candidate_count");
    // The old approach (max(source_hour) over public rows) cannot represent a
    // successful zero-opportunity hour. The NEW view body filters by joining the
    // safe status row instead of using max(source_hour).
    const viewDef = sql.slice(sql.indexOf("create or replace view public.opportunity_public"));
    expect(viewDef).not.toContain("max(source_hour)");
    expect(viewDef).toContain("latest_successful_source_hour = r.source_hour");
    expect(viewDef).toContain("where s.run_status = 'succeeded'");
  });

  it("exposes exactly ONE live data_age column (never the stored one plus an alias)", () => {
    // Exactly one output column named data_age, computed as now() - source_hour.
    const viewBody = sql.slice(sql.indexOf("as\nselect r.id"));
    const dataAgeAliases = viewBody.match(/as data_age/g) ?? [];
    expect(dataAgeAliases).toHaveLength(1);
    expect(viewBody).toContain("(now() - r.source_hour) as data_age");
    // The view must not select the stored r.data_age and then add another alias.
    expect(viewBody).not.toMatch(/r\.data_age/);
  });

  it("grants only SELECT of the safe projection to the browser roles", () => {
    expect(sql).toContain("grant select on public.opportunity_public to anon, authenticated;");
    // Browser roles never get DML on private run/market tables.
    expect(sql).not.toMatch(/grant (insert|update|delete) on public\.opportunity_runs/);
    expect(sql).not.toMatch(/grant (insert|update|delete) on public\.market_hours/);
  });
});