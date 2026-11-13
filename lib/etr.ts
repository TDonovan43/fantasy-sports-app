import { parseCsv } from "@/lib/csv";
import { normalizeName } from "@/lib/dk-salaries";
import { round1, round2, toPosition } from "@/lib/model-utils";
import type { PoolPlayer, Position, SlateData } from "@/lib/types";

/**
 * Establish The Run (ETR) projection imports. Works with their DraftKings slate export (has DK ids,
 * floor, ceiling and projected ownership) and their weekly projections file (projection and ceiling).
 * Browser-only: files are parsed and merged in the viewer's browser and never sent to the server.
 */

export type EtrRow = {
  name: string;
  position: Position;
  team: string;
  dkId: string | null;
  projected: number;
  floor: number | null;
  ceiling: number | null;
  /** Projected ownership, 0–100 (%). */
  ownSmall: number | null;
  ownLarge: number | null;
};

export type ProjectionMode = "fieldgoal" | "etr" | "blend";

/** ETR spells the Rams "LA"; the app uses DraftKings' "LAR". */
const team = (t: string) => (t.trim() === "LA" ? "LAR" : t.trim());

const num = (v: string | undefined) => {
  if (v === undefined) return null;
  const n = Number(v.replace(/[$,%\s]/g, ""));
  return v.trim() === "" || !Number.isFinite(n) ? null : n;
};

export function parseEtrCsv(text: string): EtrRow[] {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ""));
  if (!header) throw new Error("The file is empty.");
  const col = (...names: string[]) => header.findIndex((h) => names.some((n) => h.trim().toLowerCase() === n.toLowerCase()));
  const idx = {
    name: col("Player"),
    position: col("DK Pos", "Pos"),
    team: col("Team"),
    projected: col("DK Proj"),
    floor: col("DK Floor"),
    ceiling: col("DK Ceiling"),
    small: col("Small Field"),
    large: col("Large Field"),
    id: col("id", "DK ID"),
  };
  if (idx.name < 0 || idx.projected < 0 || idx.team < 0 || idx.position < 0) {
    throw new Error("This doesn't look like an ETR projections file (needs Player, Pos, Team and DK Proj columns).");
  }

  const out: EtrRow[] = [];
  for (const r of rows) {
    const position = toPosition(r[idx.position]);
    const projected = num(r[idx.projected]);
    const name = (r[idx.name] ?? "").trim();
    if (!position || projected === null || !name) continue; // kickers and blank rows
    out.push({
      name,
      position,
      team: team(r[idx.team] ?? ""),
      dkId: idx.id >= 0 && r[idx.id]?.trim() ? r[idx.id].trim() : null,
      projected,
      floor: idx.floor >= 0 ? num(r[idx.floor]) : null,
      ceiling: idx.ceiling >= 0 ? num(r[idx.ceiling]) : null,
      ownSmall: idx.small >= 0 ? num(r[idx.small]) : null,
      ownLarge: idx.large >= 0 ? num(r[idx.large]) : null,
    });
  }
  if (out.length === 0) throw new Error("No DraftKings projections found in the file.");
  return out;
}

export type EtrMergeResult = {
  slate: SlateData;
  matched: number;
  total: number;
  hasOwnership: boolean;
  /** True for ETR's DraftKings slate export, which lists every player on the slate (with DK ids). */
  complete: boolean;
  /** Pool players with a FieldGoal projection of 5+ that ETR's file leaves out (likely ruled out). */
  missing: PoolPlayer[];
};

/**
 * Attaches ETR numbers to the slate's players (and unprojected players), matching by DraftKings id,
 * then name + team, then name + position; defenses by team. FieldGoal numbers are left unchanged.
 */
export function mergeEtr(slate: SlateData, rows: EtrRow[]): EtrMergeResult {
  const byId = new Map(rows.filter((r) => r.dkId).map((r) => [r.dkId!, r]));
  const byNameTeam = new Map(rows.map((r) => [`${normalizeName(r.name)}|${r.team}`, r]));
  const byNamePos = new Map(rows.map((r) => [`${normalizeName(r.name)}|${r.position}`, r]));
  const dstByTeam = new Map(rows.filter((r) => r.position === "DST").map((r) => [r.team, r]));
  const used = new Set<EtrRow>();

  const attach = (p: PoolPlayer): PoolPlayer => {
    const row =
      (p.dkId ? byId.get(p.dkId) : undefined) ??
      (p.position === "DST"
        ? dstByTeam.get(p.team)
        : (byNameTeam.get(`${normalizeName(p.name)}|${p.team}`) ?? byNamePos.get(`${normalizeName(p.name)}|${p.position}`)));
    if (!row) return p;
    used.add(row);
    return {
      ...p,
      etr: { projected: row.projected, floor: row.floor, ceiling: row.ceiling, ownSmall: row.ownSmall, ownLarge: row.ownLarge },
    };
  };

  const players = slate.players.map(attach);
  const unprojected = slate.unprojected?.map(attach);
  return {
    slate: { ...slate, players, unprojected },
    matched: used.size,
    total: rows.length,
    hasOwnership: rows.some((r) => r.ownLarge !== null || r.ownSmall !== null),
    complete: rows.some((r) => r.dkId),
    missing: players.filter((p) => !p.etr && p.projected >= 5).sort((a, b) => b.projected - a.projected),
  };
}

/**
 * Sets each player's projection, floor and ceiling from the chosen source, keeping the FieldGoal
 * numbers in `fieldgoal`. Players without an ETR match keep FieldGoal's numbers, except in ETR mode
 * with a complete slate export, where they're left out (ETR omitting a player usually means he's out).
 * In ETR or Blend mode, unprojected players that ETR projects join the pool with ETR's numbers.
 */
export function applyProjectionSource(slate: SlateData, mode: ProjectionMode, etrWeight: number, etrComplete = false): SlateData {
  if (mode === "fieldgoal") return slate;
  const w = mode === "etr" ? 1 : Math.min(1, Math.max(0, etrWeight));

  const switchSource = (p: PoolPlayer, fieldgoalHasProjection: boolean): PoolPlayer => {
    if (!p.etr) return p;
    const fieldgoal = { projected: p.projected, floor: p.floor, ceiling: p.ceiling };
    // No FieldGoal projection: ETR's numbers are the only ones there are.
    const weight = fieldgoalHasProjection ? w : 1;
    const blend = (fg: number, etr: number | null | undefined) =>
      etr === null || etr === undefined ? fg : round1(weight * etr + (1 - weight) * fg);
    const projected = blend(p.projected, p.etr.projected);
    return {
      ...p,
      fieldgoal,
      projected,
      floor: blend(p.floor, p.etr.floor ?? p.floor),
      ceiling: blend(p.ceiling, p.etr.ceiling ?? p.ceiling),
      value: p.salary > 0 ? round2(projected / (p.salary / 1000)) : 0,
    };
  };

  const promoted = (slate.unprojected ?? []).filter((p) => p.etr && p.etr.projected > 0).map((p) => switchSource(p, false));
  const promotedIds = new Set(promoted.map((p) => p.id));
  const dropMissing = mode === "etr" && etrComplete;
  const kept = dropMissing ? slate.players.filter((p) => p.etr) : slate.players;
  return {
    ...slate,
    players: [...kept.map((p) => switchSource(p, true)), ...promoted],
    unprojected: slate.unprojected?.filter((p) => !promotedIds.has(p.id)),
  };
}
