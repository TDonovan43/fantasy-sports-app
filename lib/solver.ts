// Server-side only (used by /api/optimize): HiGHS loads its WebAssembly from node_modules.
import loadHighs from "highs";
import { isInactive } from "@/lib/dk-salaries";
import { stoppedEarlyMessage } from "@/lib/optimizer";
import { ownershipPlan, playersDue, type OwnershipMode } from "@/lib/ownership-weighting";
import { NO_RULES, type StackRules } from "@/lib/stack-rules";

export { NO_RULES, type StackRules };
import type { Position } from "@/lib/types";

/**
 * Integer-programming lineup solver (HiGHS). Every player is a yes/no variable; salary, roster,
 * stacking and diversity rules are linear constraints, so the result is the exact best lineup that
 * satisfies all of them.
 */

/** The fields the solver needs from a player. */
export type SolverPlayer = {
  id: string;
  name: string;
  position: Position;
  team: string;
  salary: number;
  projected: number;
  floor: number;
  ceiling: number;
  injury: string | null;
};

export type SolverGame = { id: string; awayTeam: string; homeTeam: string };

export type SolveRequest = {
  players: SolverPlayer[];
  games: SolverGame[];
  salaryCap: number;
  lockedIds?: string[];
  excludedIds?: string[];
  rules?: StackRules;
  /** Salary held back for a DST when the pool has no defenses. */
  dstReserve?: number;
};

export type SolvedLineup = { ids: string[]; salary: number; projected: number };
export type SolveResult = { ok: true; lineup: SolvedLineup } | { ok: false; reason: string };

let highsPromise: ReturnType<typeof loadHighs> | null = null;
const getHighs = () => (highsPromise ??= loadHighs());

const OFFENSE: Position[] = ["RB", "WR", "TE"];
const round1 = (n: number) => Math.round(n * 10) / 10;

type Context = {
  vars: SolverPlayer[];
  locked: Set<string>;
  gameOf: Map<string, string>;
  opponentOf: Map<string, string>;
  hasDst: boolean;
};

function buildContext(req: SolveRequest): Context | { error: string } {
  const locked = new Set(req.lockedIds ?? []);
  const excluded = new Set(req.excludedIds ?? []);
  const vars = req.players.filter(
    (p) => locked.has(p.id) || (!excluded.has(p.id) && p.salary > 0 && p.projected > 0 && !isInactive(p.injury)),
  );
  const gameOf = new Map<string, string>();
  const opponentOf = new Map<string, string>();
  for (const g of req.games) {
    gameOf.set(g.awayTeam, g.id);
    gameOf.set(g.homeTeam, g.id);
    opponentOf.set(g.awayTeam, g.homeTeam);
    opponentOf.set(g.homeTeam, g.awayTeam);
  }
  if (!vars.some((p) => p.position === "QB")) return { error: "No eligible quarterbacks in the pool." };
  return { vars, locked, gameOf, opponentOf, hasDst: vars.some((p) => p.position === "DST") };
}

/** Writes a sum like " + 3.2 x0 - 1 x4" with line breaks so no line gets too long. */
function sum(terms: [number, string][]) {
  if (terms.length === 0) return "0 x_none";
  return terms
    .map(([c, v], i) => `${i === 0 ? (c < 0 ? "-" : "") : c < 0 ? " -" : " +"} ${Math.abs(Number(c.toFixed(4)))} ${v}`)
    .reduce((out, term, i) => out + (i > 0 && i % 8 === 0 ? `\n   ${term}` : term), "");
}

/**
 * Best lineup under the rules. `previous` lineups (player ids) must each differ from the result by at
 * least `minUnique` players; `objective` overrides projections (used for randomized variety).
 */
export async function solveLineup(
  req: SolveRequest,
  extra: { previous?: string[][]; minUnique?: number; objective?: Map<string, number>; forbiddenStackTeams?: Set<string> } = {},
): Promise<SolveResult> {
  const ctx = buildContext(req);
  if ("error" in ctx) return { ok: false, reason: ctx.error };
  const { vars, locked, gameOf, opponentOf, hasDst } = ctx;
  const rules = req.rules ?? NO_RULES;
  const size = hasDst ? 9 : 8;
  const reserve = hasDst ? 0 : (req.dstReserve ?? 3000);
  const x = (i: number) => `x${i}`;
  const idx = (pos: Position | Position[]) =>
    vars.flatMap((p, i) => ((Array.isArray(pos) ? pos.includes(p.position) : p.position === pos) ? [i] : []));
  const ones = (list: number[]): [number, string][] => list.map((i) => [1, x(i)]);
  const rows: string[] = [];
  const add = (name: string, expr: string, op: string, rhs: number) => rows.push(` ${name}: ${expr} ${op} ${rhs}`);

  // Salary and roster.
  add("salary", sum(vars.map((p, i) => [p.salary, x(i)])), "<=", req.salaryCap - reserve);
  add("size", sum(ones(vars.map((_, i) => i))), "=", size);
  add("qb", sum(ones(idx("QB"))), "=", 1);
  if (hasDst) add("dst", sum(ones(idx("DST"))), "=", 1);
  add("rb_min", sum(ones(idx("RB"))), ">=", 2);
  add("rb_max", sum(ones(idx("RB"))), "<=", 3);
  add("wr_min", sum(ones(idx("WR"))), ">=", 3);
  add("wr_max", sum(ones(idx("WR"))), "<=", 4);
  add("te_min", sum(ones(idx("TE"))), ">=", 1);
  add("te_max", sum(ones(idx("TE"))), "<=", 2);
  // A TE in the FLEX (2 TEs) or never (1 TE), when chosen.
  if (rules.teCount) add("te_exact", sum(ones(idx("TE"))), "=", rules.teCount);
  add("flex", sum(ones(idx(OFFENSE))), "=", 7);

  // Team cap.
  if (rules.maxPerTeam < 9) {
    for (const team of new Set(vars.map((p) => p.team))) {
      const members = vars.flatMap((p, i) => (p.team === team ? [i] : []));
      if (members.length > rules.maxPerTeam) add(`team_${team}`, sum(ones(members)), "<=", rules.maxPerTeam);
    }
  }

  // QB stack, allowed stack teams, bring-back.
  const qbs = idx("QB");
  for (const q of qbs) {
    const team = vars[q].team;
    if (rules.qbStack > 0) {
      const mates = vars.flatMap((p, i) => (i !== q && p.team === team && rules.stackPositions.includes(p.position) ? [i] : []));
      add(`stack_${q}`, sum([...ones(mates), [-rules.qbStack, x(q)]]), ">=", 0);
      const allowed = (!rules.stackTeams || rules.stackTeams.includes(team)) && !extra.forbiddenStackTeams?.has(team);
      if (!allowed && !locked.has(vars[q].id)) add(`stackteam_${q}`, x(q), "=", 0);
    }
    if (rules.bringBack > 0) {
      const opp = opponentOf.get(team);
      const foes = vars.flatMap((p, i) => (opp && p.team === opp && OFFENSE.includes(p.position) ? [i] : []));
      add(`bring_${q}`, sum([...ones(foes), [-rules.bringBack, x(q)]]), ">=", 0);
    }
  }

  // No offensive player against your own defense.
  if (rules.avoidVsDst) {
    for (const d of idx("DST")) {
      const opp = opponentOf.get(vars[d].team);
      const facing = vars.flatMap((p, i) => (opp && p.team === opp && p.position !== "DST" ? [i] : []));
      if (facing.length) add(`avoid_${d}`, sum([...ones(facing), [8, x(d)]]), "<=", 8);
    }
  }

  // DraftKings: players from at least 2 games.
  const gameIds = [...new Set(vars.map((p) => gameOf.get(p.team)).filter((g): g is string => !!g))];
  const gameVars = gameIds.map((g, k) => ({ g, v: `y${k}` }));
  for (const { g, v } of gameVars) {
    const members = vars.flatMap((p, i) => (gameOf.get(p.team) === g ? [i] : []));
    add(`game_${v}`, sum([[1, v], ...members.map((i): [number, string] => [-1, x(i)])]), "<=", 0);
  }
  if (gameVars.length >= 2) add("two_games", sum(gameVars.map(({ v }) => [1, v])), ">=", 2);

  // Differ from earlier lineups.
  const position = new Map(vars.map((p, i) => [p.id, i]));
  (extra.previous ?? []).forEach((prev, k) => {
    const members = prev.map((id) => position.get(id)).filter((i): i is number => i !== undefined);
    const limit = size - (extra.minUnique ?? 1);
    if (members.length > limit) add(`unique_${k}`, sum(ones(members)), "<=", limit);
  });

  const objective = vars.map((p, i): [number, string] => [extra.objective?.get(p.id) ?? p.projected, x(i)]);
  const bounds = vars.flatMap((p, i) => (locked.has(p.id) ? [` 1 <= ${x(i)} <= 1`] : []));
  const binaries = [...vars.map((_, i) => x(i)), ...gameVars.map(({ v }) => v)];
  const lp = [
    "Maximize",
    ` obj: ${sum(objective)}`,
    "Subject To",
    ...rows,
    ...(bounds.length ? ["Bounds", ...bounds] : []),
    "Binary",
    ...binaries.reduce<string[]>((lines, v, i) => (i % 16 === 0 ? [...lines, ` ${v}`] : [...lines.slice(0, -1), `${lines.at(-1)} ${v}`]), []),
    "End",
  ].join("\n");

  const highs = await getHighs();
  const result = highs.solve(lp, { output_flag: false, mip_rel_gap: 0, time_limit: 20 });
  if (result.Status !== "Optimal") {
    return {
      ok: false,
      reason:
        result.Status === "Infeasible"
          ? "No lineup satisfies these rules and picks under the cap. Loosen a stacking rule, unlock a player or select more games."
          : `The solver stopped early (${result.Status}).`,
    };
  }
  const chosen = vars.filter((_, i) => (result.Columns[x(i)]?.Primal ?? 0) > 0.5);
  return {
    ok: true,
    lineup: {
      ids: chosen.map((p) => p.id),
      salary: chosen.reduce((s, p) => s + p.salary, 0),
      projected: round1(chosen.reduce((s, p) => s + p.projected, 0)),
    },
  };
}

/** Most chalk players pushed into one lineup to meet ownership minimums. */
const MAX_FORCED = 6;

// ---- Multiple lineups ----------------------------------------------------------------------------

export type MultiRequest = SolveRequest & {
  count: number;
  minUnique: number;
  /** 0–1; locked players are exempt. */
  maxExposure: number;
  /** Max share (0–1) of lineups whose QB stack comes from one team. */
  maxStackExposure?: number;
  randomness: number;
  seed?: number;
  /** Share (0–1) of lineups built with 2 TEs (the rest with 1); null/undefined = the optimizer decides. */
  twoTeShare?: number | null;
  /** Projected ownership (0–1) by player id, and how to weight lineups against it. */
  ownership?: Record<string, number>;
  ownershipMode?: OwnershipMode | null;
};

export type MultiResult = { lineups: SolvedLineup[]; exposure: Record<string, number>; warnings: string[] };

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

function gaussian(random: () => number) {
  return Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) * Math.cos(2 * Math.PI * random());
}

/**
 * Several lineups that each differ from every earlier one by at least `minUnique` players (an exact
 * constraint). Lineup 1 is optimal; later ones optimize projections nudged within each player's
 * floor–ceiling spread (randomness 0 = the next-best distinct lineups). Exposure caps are enforced by
 * excluding players (and stack teams) that reach their cap.
 */
export async function solveLineups(req: MultiRequest): Promise<MultiResult> {
  const random = seededRandom(req.seed ?? 1);
  const locked = new Set(req.lockedIds ?? []);
  const cap = Math.max(1, Math.floor(req.maxExposure * req.count + 1e-9));
  const stackCap = Math.max(1, Math.floor((req.maxStackExposure ?? 1) * req.count + 1e-9));
  const exposure = new Map<string, number>();
  const stackCounts = new Map<string, number>();
  const lineups: SolvedLineup[] = [];
  const warnings: string[] = [];
  const byId = new Map(req.players.map((p) => [p.id, p]));
  const stacking = (req.rules?.qbStack ?? 0) > 0;
  const own = ownershipPlan(req.ownership, req.ownershipMode, req.count);
  const capFor = (id: string) => Math.min(cap, own?.caps.get(id) ?? cap);
  const excludedSet = new Set(req.excludedIds ?? []);
  /** Chalk players that may be pushed into a lineup to meet their ownership minimum. */
  const forceable = (id: string) => {
    const p = byId.get(id);
    if (!p || locked.has(id) || excludedSet.has(id) || p.salary <= 0 || p.projected <= 0 || isInactive(p.injury)) return false;
    if ((exposure.get(id) ?? 0) >= cap) return false;
    // A forced QB would bypass the chosen stack teams.
    return !(p.position === "QB" && req.rules?.stackTeams && !req.rules.stackTeams.includes(p.team));
  };

  for (let i = 0; i < req.count; i++) {
    const capped = [...exposure].filter(([id, n]) => n >= capFor(id) && !locked.has(id)).map(([id]) => id);
    const forbiddenStackTeams = stacking ? new Set([...stackCounts].filter(([, n]) => n >= stackCap).map(([t]) => t)) : undefined;
    const objective =
      i === 0 || req.randomness <= 0
        ? undefined
        : new Map(
            req.players.map((p) => {
              const sigma = Math.max((p.ceiling - p.floor) / 2.12, 0.15 * p.projected);
              return [p.id, p.projected > 0 ? Math.max(0.01, p.projected + req.randomness * gaussian(random) * sigma) : p.projected];
            }),
          );
    // Chalk behind schedule for its ownership minimum goes into this lineup (as many as still fit).
    const due = own ? playersDue(own, exposure, i, req.count).filter(forceable).slice(0, MAX_FORCED) : [];
    // Spread the 2-TE lineups evenly through the build (e.g. 30% of 10 → lineups 4, 7 and 10).
    const share = req.twoTeShare;
    const teCount: 1 | 2 | null =
      share === null || share === undefined ? (req.rules?.teCount ?? null) : Math.floor((i + 1) * share + 1e-9) > Math.floor(i * share + 1e-9) ? 2 : 1;
    const solveWith = (te: 1 | 2 | null, forced: string[]) =>
      solveLineup(
        {
          ...req,
          rules: { ...(req.rules ?? NO_RULES), teCount: te },
          lockedIds: [...(req.lockedIds ?? []), ...forced],
          excludedIds: [...(req.excludedIds ?? []), ...capped.filter((id) => !forced.includes(id))],
        },
        { previous: lineups.map((l) => l.ids), minUnique: req.minUnique, objective, forbiddenStackTeams },
      );
    const attempt = async (te: 1 | 2 | null) => {
      // Drop the least-behind forced player until the lineup can be built.
      for (let k = due.length; k > 0; k--) {
        const r = await solveWith(te, due.slice(0, k));
        if (r.ok) return r;
      }
      return solveWith(te, []);
    };
    let result = await attempt(teCount);
    if (!result.ok && teCount !== null && share !== null && share !== undefined) {
      // Couldn't meet the TE count for this lineup: let the optimizer choose rather than stop.
      const retry = await attempt(null);
      if (retry.ok) warnings.push(`Lineup ${i + 1} couldn't use ${teCount} TE${teCount > 1 ? "s" : ""} under the other rules, so the optimizer chose.`);
      result = retry;
    }
    if (!result.ok) {
      warnings.push(
        lineups.length === 0
          ? result.reason
          : stoppedEarlyMessage(lineups.length, req.count, locked.size, req.minUnique, "no other lineup meets the difference, exposure and stacking rules."),
      );
      break;
    }
    lineups.push(result.lineup);
    for (const id of result.lineup.ids) exposure.set(id, (exposure.get(id) ?? 0) + 1);
    const qb = result.lineup.ids.map((id) => byId.get(id)).find((p) => p?.position === "QB");
    if (qb) stackCounts.set(qb.team, (stackCounts.get(qb.team) ?? 0) + 1);
  }

  return { lineups, exposure: Object.fromEntries(exposure), warnings };
}
