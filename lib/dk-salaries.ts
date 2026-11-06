import { parseCsv } from "@/lib/csv";
import { estimateRange, round1, round2, toPosition } from "@/lib/sportsdataio";
import type { PoolPlayer, Position, SlateData } from "@/lib/types";

/** One row of DraftKings' "Export to CSV" salary file (DKSalaries.csv). */
export type DkSalaryRow = {
  dkId: string;
  name: string;
  position: Position;
  rosterPosition: string;
  salary: number;
  team: string;
  opponent: string | null;
  /** Kickoff as Eastern wall-clock ISO (no zone), e.g. 2026-11-08T13:00:00. */
  kickoff: string | null;
  gameInfo: string | null;
  avgPoints: number;
  status: string | null;
};

export type DkMergeResult = {
  players: PoolPlayer[];
  matched: number;
  /** DK rows at positions the projection source doesn't cover (e.g. DST), projected from DK's average. */
  avgOnly: number;
  /** DK rows dropped: no projection from the source (usually inactive or deep reserves). */
  skipped: number;
  /** The dropped rows as zero-projection players, so they can still be picked or marked as starting. */
  unprojected: PoolPlayer[];
};

const INACTIVE_STATUSES = new Set(["OUT", "IR", "D", "DOUBTFUL", "SUSPENDED", "PUP", "NFI", "O"]);

export function isInactive(injury: string | null | undefined) {
  return !!injury && INACTIVE_STATUSES.has(injury.trim().toUpperCase());
}

const HIDDEN_STATUSES = new Set(["OUT", "O", "IR"]);

/** True for players ruled OUT or on injured reserve; these are removed from the pool entirely. */
export function isOutOrIr(injury: string | null | undefined) {
  return !!injury && HIDDEN_STATUSES.has(injury.trim().toUpperCase());
}

/** Removes OUT/IR players from a slate, counting how many were hidden. */
export function hideOutAndIr(slate: SlateData): SlateData {
  const players = slate.players.filter((p) => !isOutOrIr(p.injury));
  const unprojected = slate.unprojected?.filter((p) => !isOutOrIr(p.injury));
  const removed = slate.players.length - players.length;
  if (removed === 0 && unprojected?.length === slate.unprojected?.length) return slate;
  return { ...slate, players, unprojected, hiddenInactive: (slate.hiddenInactive ?? 0) + removed };
}

/** "DET@MIA 11/08/2026 01:00PM ET" -> teams and an Eastern wall-clock ISO string. */
function parseGameInfo(info: string, team: string) {
  const match = info.match(/^(\w+)@(\w+)\s+(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})(AM|PM)/i);
  if (!match) return { opponent: null, kickoff: null };
  const [, away, home, mm, dd, yyyy, hh, min, ampm] = match;
  let hour = Number(hh) % 12;
  if (ampm.toUpperCase() === "PM") hour += 12;
  return {
    opponent: team === away ? home : team === home ? away : null,
    kickoff: `${yyyy}-${mm}-${dd}T${String(hour).padStart(2, "0")}:${min}:00`,
  };
}

export function parseDkSalariesCsv(text: string): DkSalaryRow[] {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ""));
  if (!header) throw new Error("The file is empty.");

  const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const idx = {
    position: col("Position"),
    name: col("Name"),
    id: col("ID"),
    roster: col("Roster Position"),
    salary: col("Salary"),
    game: col("Game Info"),
    team: col("TeamAbbrev"),
    avg: col("AvgPointsPerGame"),
    status: col("Status"),
  };
  const missing = (["position", "name", "id", "salary", "team"] as const).filter((k) => idx[k] < 0);
  if (missing.length) {
    throw new Error(`This doesn't look like a DraftKings salary CSV (missing ${missing.join(", ")} columns).`);
  }

  const out: DkSalaryRow[] = [];
  for (const r of rows) {
    const position = toPosition(r[idx.position]);
    const salary = Number(r[idx.salary]);
    if (!position || !Number.isFinite(salary) || salary <= 0) continue;
    const team = r[idx.team].trim();
    const gameInfo = idx.game >= 0 ? r[idx.game]?.trim() || null : null;
    const status = idx.status >= 0 ? r[idx.status]?.trim() || null : null;
    out.push({
      dkId: r[idx.id].trim(),
      name: r[idx.name].trim(),
      position,
      rosterPosition: idx.roster >= 0 ? r[idx.roster].trim() : position,
      salary,
      team,
      gameInfo,
      ...(gameInfo ? parseGameInfo(gameInfo, team) : { opponent: null, kickoff: null }),
      avgPoints: idx.avg >= 0 ? Number(r[idx.avg]) || 0 : 0,
      status,
    });
  }

  if (out.length === 0) throw new Error("No players with salaries were found in the file.");
  if (out.some((r) => r.rosterPosition.includes("CPT"))) {
    throw new Error("This is a Showdown (Captain mode) file. Export the salary CSV from a Classic contest instead.");
  }
  return out;
}

export function normalizeName(name: string) {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'’-]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Restricts the pool to the DraftKings slate and replaces salary/ID/status with DK's values.
 * Projections are kept from the source. Only positions the source doesn't project at all (e.g. DST)
 * fall back to DK's average points per game; other unmatched players are dropped, since the source
 * omitting them usually means a zero projection (inactive or not playing).
 */
export function mergeDkSalaries(projections: PoolPlayer[], rows: DkSalaryRow[]): DkMergeResult {
  // Only real projections are matchable; drop rows a previous merge created from DK averages.
  const base = projections.filter((p) => !p.projectionFromDkAvg);
  const byDkId = new Map(base.filter((p) => p.dkId).map((p) => [p.dkId!, p]));
  const byNameTeam = new Map(base.map((p) => [`${normalizeName(p.name)}|${p.team}`, p]));
  const byNamePos = new Map(base.map((p) => [`${normalizeName(p.name)}|${p.position}`, p]));
  const projectedPositions = new Set(base.map((p) => p.position));
  const dstByTeam = new Map(base.filter((p) => p.position === "DST").map((p) => [p.team, p]));

  let matched = 0;
  let avgOnly = 0;
  let skipped = 0;
  const players: PoolPlayer[] = [];
  const unprojected: PoolPlayer[] = [];

  for (const row of rows) {
    const key = normalizeName(row.name);
    const source =
      byDkId.get(row.dkId) ??
      byNameTeam.get(`${key}|${row.team}`) ??
      byNamePos.get(`${key}|${row.position}`) ??
      (row.position === "DST" ? dstByTeam.get(row.team) : undefined);

    const useAverage = !source && !projectedPositions.has(row.position);
    const projected = source ? source.projected : useAverage ? round1(Math.max(0, row.avgPoints)) : 0;
    if (projected <= 0) {
      skipped++;
      unprojected.push({
        id: `dk-${row.dkId}`,
        dkId: row.dkId,
        name: row.name,
        position: row.position,
        team: row.team,
        opponent: row.opponent,
        gameKey: row.gameInfo,
        salary: row.salary,
        projected: 0,
        floor: 0,
        ceiling: 0,
        rangeEstimated: true,
        value: 0,
        injury: row.status ?? source?.injury ?? null,
      });
      continue;
    }
    if (source) matched++;
    else avgOnly++;

    const range = source && !source.rangeEstimated ? { floor: source.floor, ceiling: source.ceiling } : estimateRange(row.position, projected);
    players.push({
      id: source?.id ?? `dk-${row.dkId}`,
      dkId: row.dkId,
      name: row.name,
      position: row.position,
      team: row.team,
      opponent: row.opponent ?? source?.opponent ?? null,
      gameKey: source?.gameKey ?? row.gameInfo,
      salary: row.salary,
      projected,
      ...range,
      rangeEstimated: source ? source.rangeEstimated : true,
      projectionFromDkAvg: !source,
      value: round2(projected / (row.salary / 1000)),
      injury: row.status ?? source?.injury ?? null,
      research: source?.research,
    });
  }

  return { players, matched, avgOnly, skipped, unprojected };
}

export const NOTICE_TRIAL = "SportsDataIO trial key detected: projections, salaries and lines are scrambled sample values.";
export const NOTICE_NO_DST =
  "This feed has no DST projections. Pick a defense manually on DraftKings; the optimizer reserves salary for it.";

/** Applies DraftKings salary rows to a slate and rewrites the data-quality notices to match. */
export function applyDkSalariesToSlate(slate: SlateData, rows: DkSalaryRow[], uploadedAt: string): SlateData {
  const merged = mergeDkSalaries(slate.players, rows);
  const notices = slate.notices.filter((n) => n !== NOTICE_TRIAL && n !== NOTICE_NO_DST);
  const when = new Date(uploadedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  notices.unshift(
    `Salaries from DraftKings CSV (${rows.length} players, uploaded ${when}). ${merged.matched} matched to projections` +
      (merged.avgOnly ? `; ${merged.avgOnly} without projections (defenses) use DraftKings' average points per game.` : "."),
  );
  if (slate.notices.includes(NOTICE_TRIAL)) {
    notices.unshift("SportsDataIO trial key detected: projections and lines are scrambled sample values. Salaries are real.");
  }
  return hideOutAndIr({
    ...slate,
    players: merged.players,
    unprojected: merged.unprojected,
    notices,
    dkSalaries: { uploadedAt, players: rows.length },
  });
}

/** Row lookup over DK rows (name+team, then name+position; defenses by team). */
function buildRowLookup(rows: DkSalaryRow[]) {
  const byNameTeam = new Map(rows.map((r) => [`${normalizeName(r.name)}|${r.team}`, r]));
  const byNamePos = new Map(rows.map((r) => [`${normalizeName(r.name)}|${r.position}`, r]));
  const dstByTeam = new Map(rows.filter((r) => r.position === "DST").map((r) => [r.team, r]));
  return (name: string, team: string, position: Position) =>
    position === "DST"
      ? dstByTeam.get(team)
      : (byNameTeam.get(`${normalizeName(name)}|${team}`) ?? byNamePos.get(`${normalizeName(name)}|${position}`));
}

export function buildSalaryLookup(rows: DkSalaryRow[]) {
  const find = buildRowLookup(rows);
  return (name: string, team: string, position: Position) => find(name, team, position)?.salary;
}

export function buildStatusLookup(rows: DkSalaryRow[]) {
  const find = buildRowLookup(rows);
  return (name: string, team: string, position: Position) => find(name, team, position)?.status;
}
