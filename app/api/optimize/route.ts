import { NextResponse, type NextRequest } from "next/server";
import { solveLineup, solveLineups, type SolverPlayer } from "@/lib/solver";
import { NO_RULES, type StackRules } from "@/lib/stack-rules";
import type { Position } from "@/lib/types";

export const maxDuration = 60;

const POSITIONS = new Set<Position>(["QB", "RB", "WR", "TE", "DST"]);
const MAX_PLAYERS = 1000;
const MAX_LINEUPS = 50;

const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function parsePlayers(raw: unknown): SolverPlayer[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_PLAYERS).flatMap((p) => {
    const position = str(p?.position) as Position;
    if (!POSITIONS.has(position) || !str(p?.id)) return [];
    return [
      {
        id: str(p.id),
        name: str(p.name),
        position,
        team: str(p.team),
        salary: num(p.salary),
        projected: num(p.projected),
        floor: num(p.floor),
        ceiling: num(p.ceiling),
        injury: typeof p.injury === "string" ? p.injury : null,
      },
    ];
  });
}

function parseRules(raw: unknown): StackRules {
  if (!raw || typeof raw !== "object") return NO_RULES;
  const r = raw as Record<string, unknown>;
  const positions = Array.isArray(r.stackPositions)
    ? (r.stackPositions.filter((p) => p === "RB" || p === "WR" || p === "TE") as Position[])
    : NO_RULES.stackPositions;
  return {
    qbStack: clamp(Math.round(num(r.qbStack)), 0, 4),
    stackPositions: positions.length ? positions : NO_RULES.stackPositions,
    bringBack: clamp(Math.round(num(r.bringBack)), 0, 3),
    avoidVsDst: r.avoidVsDst === true,
    maxPerTeam: clamp(Math.round(num(r.maxPerTeam, 9)), 2, 9),
    stackTeams: Array.isArray(r.stackTeams) && r.stackTeams.length ? r.stackTeams.map(str).filter(Boolean) : null,
  };
}

/**
 * Solves one lineup, or several (`count` > 1), with the stacking and diversity rules.
 * Body: { players, games, salaryCap, lockedIds, excludedIds, rules, count, minUnique, maxExposure,
 *         maxStackExposure, randomness, seed }. Returns player ids per lineup.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const players = parsePlayers(body.players);
  if (players.length === 0) return NextResponse.json({ error: "No players sent." }, { status: 400 });
  const games = Array.isArray(body.games)
    ? body.games.map((g) => ({ id: str(g?.id), awayTeam: str(g?.awayTeam), homeTeam: str(g?.homeTeam) })).filter((g) => g.id)
    : [];
  const ids = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
  const base = {
    players,
    games,
    salaryCap: clamp(num(body.salaryCap, 50000), 1000, 1_000_000),
    lockedIds: ids(body.lockedIds),
    excludedIds: ids(body.excludedIds),
    rules: parseRules(body.rules),
  };

  const count = clamp(Math.round(num(body.count, 1)), 1, MAX_LINEUPS);
  try {
    if (count === 1) {
      const result = await solveLineup(base);
      return NextResponse.json(result.ok ? { lineups: [result.lineup], exposure: {}, warnings: [] } : { lineups: [], exposure: {}, warnings: [result.reason] });
    }
    const result = await solveLineups({
      ...base,
      count,
      minUnique: clamp(Math.round(num(body.minUnique, 2)), 1, 9),
      maxExposure: clamp(num(body.maxExposure, 1), 0.1, 1),
      maxStackExposure: clamp(num(body.maxStackExposure, 1), 0.05, 1),
      randomness: clamp(num(body.randomness), 0, 2),
      seed: Math.round(num(body.seed, 1)),
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Optimize failed", error);
    return NextResponse.json({ error: "The lineup solver failed. Try again." }, { status: 500 });
  }
}
