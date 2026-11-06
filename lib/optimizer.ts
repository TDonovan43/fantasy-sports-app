import { isInactive } from "@/lib/dk-salaries";
import type { PoolPlayer, Position } from "@/lib/types";

/** DraftKings NFL Classic roster. */
export const ROSTER_SLOTS = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "DST"] as const;
export type Slot = (typeof ROSTER_SLOTS)[number];

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
