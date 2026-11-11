import { buildSalaryLookup, normalizeName } from "@/lib/dk-salaries";
import { round1, round2 } from "@/lib/model-utils";
import {
  DEFAULT_MODEL,
  actualWeekDstPoints,
  actualWeekPoints,
  completedWeeks,
  loadNflverseData,
  projectWeek,
  seasonAverageBefore,
} from "@/lib/nflverse";
import { optimizeLineup } from "@/lib/optimizer";
import { getStoredDkSalaries, resolveSeasonWeek } from "@/lib/player-data";
import prisma from "@/lib/prisma";
import type { PoolPlayer, Position } from "@/lib/types";

/**
 * Projection accuracy by week: recorded pre-kickoff projections (ProjectionLog) where they exist,
 * otherwise the model replayed on only the games before that week. Scored against actual DraftKings
 * points from nflverse stats.
 */

/** Players projected below this aren't scored (deep reserves add noise, not insight). */
const MIN_PROJECTED = 3;
/** The model needs a few weeks of this season before replayed projections mean much. */
const FIRST_REPLAY_WEEK = 4;
const CACHE_TTL_MS = 30 * 60 * 1000;

export type Stats = { n: number; mae: number; bias: number; r: number | null };

export type Miss = { name: string; team: string; position: Position; projected: number; actual: number; error: number };

export type LineupCheck = {
  /** The optimal lineup by projection, and what it actually scored. */
  optimal: { projected: number; actual: number; players: string[] };
  /** The best lineup that could have been played, knowing the results. */
  hindsight: { actual: number; players: string[] };
};

export type WeekReport = {
  week: number;
  source: "recorded" | "replayed";
  /** Players scored (projected 3+ and played). */
  overall: Stats;
  /** Model vs season average on players who had a season average (same players for both). */
  baseline: { n: number; modelMae: number; baselineMae: number } | null;
  /** Share of scored players finishing below their floor / above their ceiling (targets 20% / 10%). */
  belowFloor: number;
  aboveCeiling: number;
  byPosition: Partial<Record<Position, Stats>>;
  misses: Miss[];
  lineup: LineupCheck | null;
};

export type AccuracyReport = {
  season: number;
  currentWeek: number;
  weeks: WeekReport[];
  /** Weeks with recorded projections whose games aren't all final yet. */
  pending: { week: number; recorded: number }[];
  totals: { weeks: number; players: number; mae: number; baselineMae: number | null; bias: number; belowFloor: number; aboveCeiling: number } | null;
  generatedAt: string;
};

type Scored = { key: string; name: string; team: string; position: Position; salary: number; projected: number; floor: number; ceiling: number; actual: number };

function stats(rows: { projected: number; actual: number }[]): Stats {
  const n = rows.length;
  if (n === 0) return { n, mae: 0, bias: 0, r: null };
  const mae = rows.reduce((s, x) => s + Math.abs(x.projected - x.actual), 0) / n;
  const bias = rows.reduce((s, x) => s + (x.projected - x.actual), 0) / n;
  const mp = rows.reduce((s, x) => s + x.projected, 0) / n;
  const ma = rows.reduce((s, x) => s + x.actual, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (const x of rows) {
    sab += (x.projected - mp) * (x.actual - ma);
    saa += (x.projected - mp) ** 2;
    sbb += (x.actual - ma) ** 2;
  }
  const r = saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
  return { n, mae: round2(mae), bias: round2(bias), r: r === null ? null : round2(r) };
}

type Projection = Omit<Scored, "actual">;

function lineupCheck(rows: Scored[], salaryCap: number): LineupCheck | null {
  const pool = rows.filter((r) => r.salary > 0);
  if (pool.length < 20) return null;
  const toPlayer = (r: Scored, projected: number): PoolPlayer => ({
    id: r.key,
    name: r.name,
    position: r.position,
    team: r.team,
    opponent: null,
    gameKey: null,
    salary: r.salary,
    projected,
    floor: r.floor,
    ceiling: r.ceiling,
    rangeEstimated: false,
    value: 0,
    injury: null,
  });
  const actualOf = new Map(pool.map((r) => [r.key, r.actual]));
  const optimal = optimizeLineup({ pool: pool.map((r) => toPlayer(r, r.projected)), salaryCap });
  const hindsight = optimizeLineup({ pool: pool.map((r) => toPlayer(r, Math.max(0.01, r.actual))), salaryCap });
  if (!optimal.ok || !hindsight.ok) return null;
  const actualSum = (ps: PoolPlayer[]) => round1(ps.reduce((s, p) => s + (actualOf.get(p.id) ?? 0), 0));
  return {
    optimal: { projected: optimal.projected, actual: actualSum(optimal.players), players: optimal.players.map((p) => p.name) },
    hindsight: { actual: actualSum(hindsight.players), players: hindsight.players.map((p) => p.name) },
  };
}

let memo: { key: string; expires: number; value: Promise<AccuracyReport> } | null = null;

export function getAccuracyReport(): Promise<AccuracyReport> {
  return resolveSeasonWeek().then(({ season, week }) => {
    const key = `${season}-${week}`;
    if (memo && memo.key === key && memo.expires > Date.now()) return memo.value;
    const value = buildReport(season, week);
    memo = { key, expires: Date.now() + CACHE_TTL_MS, value };
    value.catch(() => {
      memo = null;
    });
    return value;
  });
}

async function buildReport(season: number, currentWeek: number): Promise<AccuracyReport> {
  const data = await loadNflverseData(season);
  const logged = process.env.DATABASE_URL ? await prisma.projectionLog.findMany({ where: { season } }).catch(() => []) : [];
  const loggedByWeek = new Map<number, typeof logged>();
  for (const row of logged) loggedByWeek.set(row.week, [...(loggedByWeek.get(row.week) ?? []), row]);

  const done = completedWeeks(data, season);
  const weeks: WeekReport[] = [];

  for (const week of done) {
    let projections: Projection[];
    let source: WeekReport["source"];
    const rows = loggedByWeek.get(week);
    if (rows?.length) {
      source = "recorded";
      projections = rows.map((r) => ({
        key: r.playerKey,
        name: r.name,
        team: r.team,
        position: r.position as Position,
        salary: r.salary,
        projected: r.projected,
        floor: r.floor,
        ceiling: r.ceiling,
      }));
    } else if (week >= FIRST_REPLAY_WEEK) {
      source = "replayed";
      const stored = await getStoredDkSalaries(season, week);
      const salaryOf = stored ? buildSalaryLookup(stored.rows) : undefined;
      const result = projectWeek(data, season, week, { salaryOf, model: { ...DEFAULT_MODEL, skipCompletedGames: false } });
      projections = result.players
        // With a salary file, score that slate; otherwise everyone the model projected.
        .filter((p) => !stored || p.salary > 0)
        .map((p) => ({ key: p.id, name: p.name, team: p.team, position: p.position, salary: p.salary, projected: p.projected, floor: p.floor, ceiling: p.ceiling }));
    } else {
      continue;
    }

    const offense = actualWeekPoints(data, season, week);
    const dst = actualWeekDstPoints(data, season, week);
    const byName = new Map([...offense].map(([k, v]) => [`${normalizeName(v.name)}|${v.position}`, { key: k, ...v }]));
    const average = seasonAverageBefore(data, season, week);

    const scored: Scored[] = [];
    const allWithActual: Scored[] = [];
    for (const p of projections) {
      let actual: number | undefined;
      if (p.position === "DST") actual = dst.get(p.key);
      else {
        const hit = offense.get(p.key) ?? byName.get(`${normalizeName(p.name)}|${p.position}`);
        // Played = has a stat line with some usage (or any points).
        if (hit && (hit.usage > 0 || hit.points !== 0)) actual = hit.points;
      }
      const row = { ...p, actual: actual ?? 0 };
      allWithActual.push(row);
      if (actual !== undefined && p.projected >= MIN_PROJECTED) scored.push({ ...p, actual });
    }
    if (scored.length === 0) continue;

    const withAvg = scored.filter((s) => average.has(s.key));
    const byPosition: WeekReport["byPosition"] = {};
    for (const pos of ["QB", "RB", "WR", "TE", "DST"] as Position[]) {
      const list = scored.filter((s) => s.position === pos);
      if (list.length) byPosition[pos] = stats(list);
    }
    weeks.push({
      week,
      source,
      overall: stats(scored),
      baseline: withAvg.length
        ? {
            n: withAvg.length,
            modelMae: stats(withAvg).mae,
            baselineMae: stats(withAvg.map((s) => ({ projected: average.get(s.key)!, actual: s.actual }))).mae,
          }
        : null,
      belowFloor: round2(scored.filter((s) => s.actual < s.floor).length / scored.length),
      aboveCeiling: round2(scored.filter((s) => s.actual > s.ceiling).length / scored.length),
      byPosition,
      misses: [...scored]
        .sort((a, b) => Math.abs(b.actual - b.projected) - Math.abs(a.actual - a.projected))
        .slice(0, 8)
        .map((s) => ({ name: s.name, team: s.team, position: s.position, projected: round1(s.projected), actual: round1(s.actual), error: round1(s.actual - s.projected) })),
      lineup: lineupCheck(allWithActual, 50000),
    });
  }

  const pending = [...loggedByWeek]
    .filter(([w]) => !done.includes(w))
    .map(([w, rows]) => ({ week: w, recorded: rows.length }))
    .sort((a, b) => a.week - b.week);

  const players = weeks.reduce((s, w) => s + w.overall.n, 0);
  const weighted = (pick: (w: WeekReport) => number) => (players ? round2(weeks.reduce((s, w) => s + pick(w) * w.overall.n, 0) / players) : 0);
  const baseN = weeks.reduce((s, w) => s + (w.baseline?.n ?? 0), 0);
  const totals = weeks.length
    ? {
        weeks: weeks.length,
        players,
        mae: weighted((w) => w.overall.mae),
        baselineMae: baseN ? round2(weeks.reduce((s, w) => s + (w.baseline ? w.baseline.baselineMae * w.baseline.n : 0), 0) / baseN) : null,
        bias: weighted((w) => w.overall.bias),
        belowFloor: weighted((w) => w.belowFloor),
        aboveCeiling: weighted((w) => w.aboveCeiling),
      }
    : null;

  return { season, currentWeek, weeks, pending, totals, generatedAt: new Date().toISOString() };
}
