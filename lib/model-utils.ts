import type { Position } from "@/lib/types";

/** Shared helpers for every projection source (no network calls). */

export const round1 = (n: number) => Math.round(n * 10) / 10;
export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Position volatility (coefficient of variation) used to estimate floor/ceiling when a source gives none. */
const VOLATILITY: Record<Position, number> = { QB: 0.3, RB: 0.42, WR: 0.48, TE: 0.5, DST: 0.6 };

export function estimateRange(position: Position, projected: number) {
  const cv = VOLATILITY[position];
  return {
    floor: Math.max(0, round1(projected * (1 - 0.67 * cv))),
    ceiling: round1(projected * (1 + 1.28 * cv)),
  };
}

/** Normalizes a provider's position label to a DraftKings Classic position. */
export function toPosition(raw: unknown): Position | null {
  const p = String(raw ?? "").toUpperCase();
  if (p === "QB" || p === "RB" || p === "WR" || p === "TE") return p;
  if (p === "DST" || p === "DEF" || p === "D/ST" || p === "D") return "DST";
  return null;
}
