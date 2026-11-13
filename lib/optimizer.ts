import { isInactive } from "@/lib/dk-salaries";
import { ownershipPlan, type OwnershipMode } from "@/lib/ownership-weighting";
import type { PoolPlayer, Position } from "@/lib/types";

/** DraftKings NFL Classic roster. */
export const ROSTER_SLOTS = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "DST"] as const;
export type Slot = (typeof ROSTER_SLOTS)[number];

/**
 * Why a multi-lineup build stopped after `built` lineups. Locked players are in every lineup, so
 * when too many are locked no further lineup can differ by `minUnique` players: say that plainly.
 */
export function stoppedEarlyMessage(built: number, count: number, lockedCount: number, minUnique: number, general: string) {
  const free = ROSTER_SLOTS.length - lockedCount;
  if (lockedCount > 0 && free < minUnique) {
    return `Built ${built} of ${count}: ${lockedCount} players are locked in, so only ${free} roster spot${free === 1 ? "" : "s"} can change, but each lineup must differ by ${minUnique}. Remove some players from the lineup editor (or lower "Min. different players").`;
  }
  const hint = lockedCount >= 5 ? ` You also have ${lockedCount} players locked in; removing some gives the builder more room.` : "";
  return `Built ${built} of ${count}: ${general} Loosen a setting or select more games.${hint}`;
}

const FLEX_POSITIONS: Position[] = ["RB", "WR", "TE"];
const BASE_COUNTS: Record<Position, number> = { QB: 1, RB: 2, WR: 3, TE: 1, DST: 1 };
const SALARY_UNIT = 100;

export type SlottedLineup = Array<PoolPlayer | null>;

/**
 * Places players into DraftKings Classic slots (dedicated slots first, overflow to FLEX).
 * Returns null if the players cannot all fit.
 */
export function assignSlots(players: PoolPlayer[]): SlottedLineup | null {
  const slots: SlottedLineup = ROSTER_SLOTS.map(() => null);
  const overflow: PoolPlayer[] = [];

  for (const player of players) {
    const idx = ROSTER_SLOTS.findIndex((slot, i) => slot === player.position && slots[i] === null);
    if (idx >= 0) slots[idx] = player;
    else overflow.push(player);
  }

  const flexIdx = ROSTER_SLOTS.indexOf("FLEX");
  for (const player of overflow) {
    if (!FLEX_POSITIONS.includes(player.position) || slots[flexIdx] !== null) return null;
    slots[flexIdx] = player;
  }
  return slots;
}

export function lineupSalary(players: PoolPlayer[]) {
  return players.reduce((sum, p) => sum + p.salary, 0);
}

export function lineupProjection(players: PoolPlayer[]) {
  return Math.round(players.reduce((sum, p) => sum + p.projected, 0) * 10) / 10;
}

type GroupResult = {
  /** best[k][s]: max projection using exactly k players costing <= s units. */
  best: Float64Array[];
  reconstruct: (k: number, s: number) => PoolPlayer[];
};

function solveGroup(players: PoolPlayer[], maxK: number, budget: number): GroupResult {
  const n = players.length;
  const width = budget + 1;
  const best = Array.from({ length: maxK + 1 }, (_, k) => new Float64Array(width).fill(k === 0 ? 0 : -Infinity));
  const keep = new Uint8Array(Math.max(1, n * (maxK + 1) * width));
  const costs = players.map((p) => Math.ceil(p.salary / SALARY_UNIT));

  for (let i = 0; i < n; i++) {
    const c = costs[i];
    const v = players[i].projected;
    for (let k = maxK; k >= 1; k--) {
      const prev = best[k - 1];
      const cur = best[k];
      for (let s = budget; s >= c; s--) {
        const candidate = prev[s - c] + v;
        if (candidate > cur[s]) {
          cur[s] = candidate;
          keep[(i * (maxK + 1) + k) * width + s] = 1;
        }
      }
    }
  }

  return {
    best,
    reconstruct(k, s) {
      const chosen: PoolPlayer[] = [];
      for (let i = n - 1; i >= 0 && k > 0; i--) {
        if (keep[(i * (maxK + 1) + k) * width + s]) {
          chosen.push(players[i]);
          k--;
          s -= costs[i];
        }
      }
      return chosen;
    },
  };
}

/** Max-plus convolution of two "best within budget" curves. */
function combine(a: Float64Array, b: Float64Array) {
  const width = a.length;
  const out = new Float64Array(width).fill(-Infinity);
  const split = new Int32Array(width);
  for (let s = 0; s < width; s++) {
    for (let t = 0; t <= s; t++) {
      const v = a[t] + b[s - t];
      if (v > out[s]) {
        out[s] = v;
        split[s] = t;
      }
    }
  }
  return { out, split };
}

export type OptimizeOptions = {
  pool: PoolPlayer[];
  salaryCap: number;
  lockedIds?: string[];
  excludedIds?: string[];
  /** Salary held back for a DST when the pool has no defenses. */
  dstReserve?: number;
};

export type OptimizeResult =
  | { ok: true; players: PoolPlayer[]; salary: number; projected: number }
  | { ok: false; reason: string };

/** Exact max-projection DraftKings Classic lineup under the salary cap. */
export function optimizeLineup({
  pool,
  salaryCap,
  lockedIds = [],
  excludedIds = [],
  dstReserve = 3000,
}: OptimizeOptions): OptimizeResult {
  const locked = pool.filter((p) => lockedIds.includes(p.id));
  if (!assignSlots(locked)) return { ok: false, reason: "Locked players don't fit a DraftKings Classic roster." };

  const hasDst = pool.some((p) => p.position === "DST");
  const reserve = hasDst ? 0 : dstReserve;
  const budget = Math.floor((salaryCap - lineupSalary(locked) - reserve) / SALARY_UNIT);
  if (budget < 0) return { ok: false, reason: "Locked players already exceed the salary cap." };

  const lockedCount = (pos: Position) => locked.filter((p) => p.position === pos).length;
  const blocked = new Set([...lockedIds, ...excludedIds]);
  const available = pool.filter((p) => !blocked.has(p.id) && !isInactive(p.injury) && p.salary > 0 && p.projected > 0);

  const positions: Position[] = hasDst ? ["QB", "RB", "WR", "TE", "DST"] : ["QB", "RB", "WR", "TE"];
  const groups = new Map<Position, GroupResult>();
  for (const pos of positions) {
    const maxTotal = BASE_COUNTS[pos] + (FLEX_POSITIONS.includes(pos) ? 1 : 0);
    const maxK = Math.max(0, maxTotal - lockedCount(pos));
    groups.set(pos, solveGroup(available.filter((p) => p.position === pos), maxK, budget));
  }

  let bestResult: { value: number; players: PoolPlayer[] } | null = null;

  for (const flexPos of FLEX_POSITIONS) {
    const need = positions.map((pos) => {
      const total = BASE_COUNTS[pos] + (pos === flexPos ? 1 : 0);
      return total - lockedCount(pos);
    });
    if (need.some((k) => k < 0)) continue;

    const curves = positions.map((pos, i) => groups.get(pos)!.best[need[i]]);
    if (curves.some((c) => c === undefined)) continue;

    let acc = curves[0];
    const splits: Int32Array[] = [];
    for (let i = 1; i < curves.length; i++) {
      const { out, split } = combine(acc, curves[i]);
      acc = out;
      splits.push(split);
    }

    const value = acc[budget];
    if (!Number.isFinite(value) || (bestResult && value <= bestResult.value)) continue;

    // Walk the splits backwards to recover each group's budget.
    const chosen: PoolPlayer[] = [];
    let s = budget;
    for (let i = curves.length - 1; i >= 1; i--) {
      const t = splits[i - 1][s];
      chosen.push(...groups.get(positions[i])!.reconstruct(need[i], s - t));
      s = t;
    }
    chosen.push(...groups.get(positions[0])!.reconstruct(need[0], s));
    bestResult = { value, players: chosen };
  }

  if (!bestResult) return { ok: false, reason: "Not enough eligible players to fill the roster under the cap." };

  const players = [...locked, ...bestResult.players];
  return { ok: true, players, salary: lineupSalary(players), projected: lineupProjection(players) };
}

/** True when every slot is filled with a player that has a DraftKings ID. */
export function canExportForDraftKings(players: PoolPlayer[]) {
  const slots = assignSlots(players);
  return !!slots && slots.every((p) => p?.dkId);
}

/** DraftKings bulk-upload format: slot header row, then player IDs. */
export function lineupToDraftKingsCsv(players: PoolPlayer[]): string {
  const slots = assignSlots(players) ?? [];
  return [ROSTER_SLOTS.join(","), slots.map((p) => p?.dkId ?? "").join(",")].join("\n");
}

/** CSV in DraftKings slot order, suitable for spreadsheets or manual entry. */
export function lineupToCsv(players: PoolPlayer[]): string {
  const slots = assignSlots(players) ?? [];
  const rows = [["Slot", "Player", "Position", "Team", "Opponent", "Salary", "Projected"]];
  ROSTER_SLOTS.forEach((slot, i) => {
    const p = slots[i];
    rows.push([slot, p?.name ?? "", p?.position ?? "", p?.team ?? "", p?.opponent ?? "", p ? String(p.salary) : "", p ? p.projected.toFixed(1) : ""]);
  });
  rows.push(["Total", "", "", "", "", String(lineupSalary(players)), lineupProjection(players).toFixed(1)]);
  return rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
}

// ---- Multiple lineups ---------------------------------------------------------------------------

export type MultiLineupOptions = OptimizeOptions & {
  /** How many lineups to build. */
  count: number;
  /** Each lineup must differ from every earlier one by at least this many players. */
  minUnique: number;
  /** Max share of lineups (0–1) any one player may appear in; locked players are exempt. */
  maxExposure: number;
  /** How far projections are nudged, in multiples of each player's own spread (0 = none). */
  randomness: number;
  /** Seed for the random nudges, so the same settings give the same lineups. */
  seed?: number;
  /** Maps a player to his game, to enforce DraftKings' 2-game rule. */
  gameOf?: (p: PoolPlayer) => string;
  /** Projected ownership (0–1) by player id, and how to weight lineups against it. */
  ownership?: Record<string, number>;
  ownershipMode?: OwnershipMode | null;
};

export type BuiltLineup = { players: PoolPlayer[]; salary: number; projected: number };

export type MultiLineupResult = {
  lineups: BuiltLineup[];
  /** Player id -> number of lineups he appears in. */
  exposure: Map<string, number>;
  warnings: string[];
};

/** Small deterministic PRNG (mulberry32). */
function seededRandom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draw (Box–Muller). */
function gaussian(random: () => number) {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

const MAX_ATTEMPTS = 40;
/** After this many near-duplicate attempts, start excluding the most-used overlapping player. */
const EXCLUDE_AFTER = 8;

/**
 * Builds several different lineups. The first is the optimal lineup; each later one re-optimizes on
 * projections nudged at random within each player's own floor–ceiling spread, and is kept only if it
 * differs from every earlier lineup by at least `minUnique` players, keeps everyone under the
 * exposure cap and uses 2+ games. Scores and salaries shown are always the real projections.
 */
export function generateLineups(options: MultiLineupOptions): MultiLineupResult {
  const { pool, salaryCap, lockedIds = [], excludedIds = [], dstReserve, count, minUnique, maxExposure, randomness, gameOf } = options;
  const random = seededRandom(options.seed ?? 1);
  const locked = new Set(lockedIds);
  const cap = Math.max(1, Math.floor(maxExposure * count + 1e-9));
  const own = ownershipPlan(options.ownership, options.ownershipMode, count);
  const capFor = (id: string) => Math.min(cap, own?.caps.get(id) ?? cap);
  // Fallback only: ownership caps apply, minimums need the server solver.
  const exposure = new Map<string, number>();
  const lineups: BuiltLineup[] = [];
  const previous: Set<string>[] = [];
  const warnings: string[] = [];
  const byId = new Map(pool.map((p) => [p.id, p]));

  for (let i = 0; i < count; i++) {
    let accepted: BuiltLineup | null = null;
    let lastReason = "";
    const extraExcluded = new Set<string>();

    for (let attempt = 0; attempt < MAX_ATTEMPTS && !accepted; attempt++) {
      const scale = i === 0 && attempt === 0 ? 0 : randomness * (1 + attempt / 10);
      const capped = [...exposure].filter(([id, n]) => n >= capFor(id) && !locked.has(id)).map(([id]) => id);
      const nudged =
        scale === 0
          ? pool
          : pool.map((p) => {
              if (p.projected <= 0) return p;
              const sigma = Math.max((p.ceiling - p.floor) / 2.12, 0.15 * p.projected);
              return { ...p, projected: Math.max(0.01, p.projected + scale * gaussian(random) * sigma) };
            });
      const result = optimizeLineup({
        pool: nudged,
        salaryCap,
        lockedIds,
        excludedIds: [...excludedIds, ...capped, ...extraExcluded],
        dstReserve,
      });
      if (!result.ok) {
        lastReason = result.reason;
        // Nothing to vary away from yet: the settings can't produce even one lineup.
        if (lineups.length === 0 && capped.length === 0 && extraExcluded.size === 0) break;
        continue;
      }

      const ids = result.players.map((p) => p.id);
      const tooClose = previous.find((prev) => ids.filter((id) => prev.has(id)).length > ids.length - minUnique);
      const oneGame = !!gameOf && new Set(result.players.map(gameOf)).size < 2;
      if (tooClose || oneGame) {
        if (tooClose && attempt >= EXCLUDE_AFTER) {
          const overlap = ids
            .filter((id) => tooClose.has(id) && !locked.has(id) && !extraExcluded.has(id))
            .sort((a, b) => (exposure.get(b) ?? 0) - (exposure.get(a) ?? 0));
          if (overlap[0]) extraExcluded.add(overlap[0]);
        }
        continue;
      }

      const players = ids.map((id) => byId.get(id)!);
      accepted = { players, salary: lineupSalary(players), projected: lineupProjection(players) };
      previous.push(new Set(ids));
      for (const id of ids) exposure.set(id, (exposure.get(id) ?? 0) + 1);
    }

    if (!accepted) {
      warnings.push(
        lineups.length === 0
          ? lastReason || "Couldn't build a lineup with these settings."
          : stoppedEarlyMessage(lineups.length, count, locked.size, minUnique, `no other lineup differs by ${minUnique}+ players within the ${Math.round(maxExposure * 100)}% exposure limit.`),
      );
      break;
    }
    lineups.push(accepted);
  }

  return { lineups, exposure, warnings };
}

/** DraftKings bulk-upload file with one row per lineup; null unless every slot of every lineup has a DK ID. */
export function lineupsToDraftKingsCsv(lineups: BuiltLineup[]): string | null {
  const rows: string[] = [ROSTER_SLOTS.join(",")];
  for (const l of lineups) {
    const slots = assignSlots(l.players);
    if (!slots || slots.some((p) => !p?.dkId)) return null;
    rows.push(slots.map((p) => p!.dkId).join(","));
  }
  return rows.join("\n");
}

/** Readable CSV of several lineups: one row per lineup with player names by slot, salary and projection. */
export function lineupsToCsv(lineups: BuiltLineup[]): string {
  const esc = (c: string) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  const rows = [["Lineup", ...ROSTER_SLOTS, "Salary", "Projected"]];
  lineups.forEach((l, i) => {
    const slots = assignSlots(l.players) ?? [];
    rows.push([String(i + 1), ...ROSTER_SLOTS.map((_, s) => slots[s]?.name ?? ""), String(l.salary), l.projected.toFixed(1)]);
  });
  return rows.map((r) => r.map(esc).join(",")).join("\n");
}
