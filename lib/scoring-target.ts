/**
 * What the optimizer maximizes. Cash games reward a safe floor; big tournaments reward ceiling.
 * Each target blends the median projection with the player's floor or ceiling. Shared by the
 * server solver and the browser fallback; lineup totals still report the plain projection.
 */
export type ScoringTarget = "floor" | "median" | "upside" | "ceiling";

export const SCORING_TARGETS: ScoringTarget[] = ["floor", "median", "upside", "ceiling"];

/** Share of the score taken from the floor (negative) or ceiling (positive). */
const BLEND: Record<ScoringTarget, number> = { floor: -0.4, median: 0, upside: 0.2, ceiling: 0.4 };

export const SCORING_TARGET_LABEL: Record<ScoringTarget, string> = {
  floor: "Floor: 60% projection + 40% floor",
  median: "Projection",
  upside: "Some upside: 80% projection + 20% ceiling",
  ceiling: "Ceiling: 60% projection + 40% ceiling",
};

export function isScoringTarget(v: unknown): v is ScoringTarget {
  return typeof v === "string" && (SCORING_TARGETS as string[]).includes(v);
}

/** The points the optimizer uses for a player under a target. */
export function targetPoints(p: { projected: number; floor: number; ceiling: number }, target: ScoringTarget | null | undefined): number {
  const w = BLEND[target ?? "median"];
  if (!w || p.projected <= 0) return p.projected;
  const other = w < 0 ? p.floor : p.ceiling;
  // Missing floor/ceiling data (0) falls back to the projection.
  if (!(other > 0)) return p.projected;
  return (1 - Math.abs(w)) * p.projected + Math.abs(w) * other;
}
