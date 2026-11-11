import type { PoolPlayer, Position } from "@/lib/types";

/** Stacking rules shared by the browser (controls) and the server solver. No solver code here. */
export type StackRules = {
  /** Players from the QB's own team required alongside him (0 = no stack rule). */
  qbStack: number;
  /** Positions that count toward the QB stack. */
  stackPositions: Position[];
  /** Players required from the QB's opponent (0 = none). */
  bringBack: number;
  /** Never play an offensive player against your own defense. */
  avoidVsDst: boolean;
  /** Max players from one team, defense included (9 = no limit). */
  maxPerTeam: number;
  /** When stacking, the QB must come from one of these teams (null = any). */
  stackTeams: string[] | null;
};

/** No rules: the plain best lineup under the cap. */
export const NO_RULES: StackRules = {
  qbStack: 0,
  stackPositions: ["WR", "TE"],
  bringBack: 0,
  avoidVsDst: false,
  maxPerTeam: 9,
  stackTeams: null,
};

/** Defaults for the stacking controls: QB + 1 pass catcher, no bring-back, max 4 per team, no players vs your DST. */
export const DEFAULT_STACK_RULES: StackRules = {
  qbStack: 1,
  stackPositions: ["WR", "TE"],
  bringBack: 0,
  avoidVsDst: true,
  maxPerTeam: 4,
  stackTeams: null,
};

export type StackSummary = { team: string; withQb: number; bringBack: number; label: string } | null;

/** Describes a lineup's QB stack, e.g. "BUF stack: QB + 2 · bring-back 1". */
export function describeStack(players: PoolPlayer[], opponentOf: Map<string, string>, rules: StackRules): StackSummary {
  const qb = players.find((p) => p.position === "QB");
  if (!qb) return null;
  const withQb = players.filter((p) => p !== qb && p.team === qb.team && rules.stackPositions.includes(p.position)).length;
  const opp = opponentOf.get(qb.team);
  const bringBack = players.filter((p) => opp && p.team === opp && p.position !== "DST" && p.position !== "QB").length;
  const label = `${qb.team} stack: QB + ${withQb}${bringBack ? ` · bring-back ${bringBack}` : ""}`;
  return { team: qb.team, withQb, bringBack, label };
}
