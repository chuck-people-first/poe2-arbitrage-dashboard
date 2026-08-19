import type { FlipHourlyObservation } from "./types.ts";

export type SignalStatus = "NEW" | "IMPROVING" | "STABLE" | "DEGRADING" | "EXPIRED" | "INSUFFICIENT HISTORY";
export interface HistorySummary {
  current: FlipHourlyObservation;
  firstDetected: FlipHourlyObservation;
  best: FlipHourlyObservation;
  breakEvenSourceHourUtc: string | null;
  changeSinceDetectionPct: number | null;
  firstSeenSourceHourUtc: string;
  lastProfitableSourceHourUtc: string | null;
  opportunityDurationHours: number;
  status: SignalStatus;
  hourlyValues: Array<{ sourceHourUtc: string; value: number }>;
}

const PROFIT_EPSILON = 0.000001;

export function classifySignal(history: FlipHourlyObservation[], expiredAfterHours: number, now = new Date()): SignalStatus {
  if (history.length < 2) return "INSUFFICIENT HISTORY";
  const ordered = [...history].sort((a, b) => Date.parse(a.sourceHourUtc) - Date.parse(b.sourceHourUtc));
  const current = ordered[ordered.length - 1]!;
  const age = (now.getTime() - Date.parse(current.sourceHourUtc)) / 3600000;
  if (current.divPer100kGold <= PROFIT_EPSILON || age > expiredAfterHours) return "EXPIRED";
  const previous = ordered[ordered.length - 2]!.divPer100kGold;
  const delta = current.divPer100kGold - previous;
  if (delta > PROFIT_EPSILON) return ordered.length === 2 ? "NEW" : "IMPROVING";
  if (delta < -PROFIT_EPSILON) return "DEGRADING";
  return "STABLE";
}

export function appendHourlyObservation(existing: FlipHourlyObservation[], incoming: FlipHourlyObservation): FlipHourlyObservation[] {
  const key = (row: FlipHourlyObservation) => `${row.familyId}|${row.league}|${row.sourceHourUtc}`;
  if (existing.some((row) => key(row) === key(incoming))) return [...existing];
  return [...existing, incoming].sort((a, b) => Date.parse(a.sourceHourUtc) - Date.parse(b.sourceHourUtc));
}

export function summarizeHistory(history: FlipHourlyObservation[], now = new Date(), expiredAfterHours = 26): HistorySummary {
  if (!history.length) throw new Error("cannot summarize empty signal history");
  const ordered = [...history].sort((a, b) => Date.parse(a.sourceHourUtc) - Date.parse(b.sourceHourUtc));
  const firstDetected = ordered[0]!;
  const current = ordered[ordered.length - 1]!;
  const best = ordered.reduce((bestRow, row) => row.divPer100kGold > bestRow.divPer100kGold ? row : bestRow, firstDetected);
  let breakEvenSourceHourUtc: string | null = null;
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i - 1]!.divPer100kGold > PROFIT_EPSILON && ordered[i]!.divPer100kGold <= PROFIT_EPSILON) {
      breakEvenSourceHourUtc = ordered[i - 1]!.sourceHourUtc;
    }
  }
  const profitable = ordered.filter((row) => row.divPer100kGold > PROFIT_EPSILON);
  const durationEnd = Date.parse(current.sourceHourUtc);
  const changeSinceDetectionPct = firstDetected.divPer100kGold === 0
    ? null
    : ((current.divPer100kGold - firstDetected.divPer100kGold) / Math.abs(firstDetected.divPer100kGold)) * 100;
  return {
    current, firstDetected, best, breakEvenSourceHourUtc, changeSinceDetectionPct,
    firstSeenSourceHourUtc: firstDetected.sourceHourUtc,
    lastProfitableSourceHourUtc: profitable.length ? profitable[profitable.length - 1]!.sourceHourUtc : null,
    opportunityDurationHours: Math.max(0, (durationEnd - Date.parse(firstDetected.sourceHourUtc)) / 3600000),
    status: classifySignal(ordered, expiredAfterHours, now),
    hourlyValues: ordered.map((row) => ({ sourceHourUtc: row.sourceHourUtc, value: row.divPer100kGold })),
  };
}
