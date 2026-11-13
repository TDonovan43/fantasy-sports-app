/**
 * Building lineups relative to projected ownership (ETR, large field): your exposure to each chalk
 * player (projected 10%+ owned) compared with the share of the field expected to play him.
 *
 *  - under: at most half his projected ownership
 *  - match: about his projected ownership (at most, and at least, rounded to whole lineups)
 *  - over:  at least 1.5x his projected ownership
 *
 * Players below the chalk line are left to the optimizer, and Max exposure % still caps everyone.
 */
export type OwnershipMode = "under" | "match" | "over";

export const OWNERSHIP_MODES: OwnershipMode[] = ["under", "match", "over"];

/** Target exposure as a multiple of projected ownership. */
export const OWNERSHIP_TARGET: Record<OwnershipMode, number> = { under: 0.5, match: 1, over: 1.5 };

/** Ownership (0–1) from which a player counts as chalk and gets a target. */
export const CHALK_OWNERSHIP = 0.1;

export function isOwnershipMode(value: unknown): value is OwnershipMode {
  return typeof value === "string" && (OWNERSHIP_MODES as string[]).includes(value);
}

export type OwnershipPlan = {
  /** Most lineups each chalk player may be in. */
  caps: Map<string, number>;
  /** Fewest lineups each chalk player should be in. */
  minimums: Map<string, number>;
};

/** Per-player lineup caps and minimums for a build of `count` lineups, or null when not in use. */
export function ownershipPlan(ownership: Record<string, number> | undefined, mode: OwnershipMode | null | undefined, count: number): OwnershipPlan | null {
  if (!mode || !ownership) return null;
  const caps = new Map<string, number>();
  const minimums = new Map<string, number>();
  for (const [id, own] of Object.entries(ownership)) {
    if (!Number.isFinite(own) || own < CHALK_OWNERSHIP) continue;
    const target = Math.max(1, Math.round(OWNERSHIP_TARGET[mode] * own * count + 1e-9));
    if (mode !== "over") caps.set(id, target);
    if (mode !== "under") minimums.set(id, Math.min(count, target));
  }
  return caps.size || minimums.size ? { caps, minimums } : null;
}

/**
 * Chalk players behind schedule for their minimum before building lineup `index` (0-based), most
 * behind first. They're pushed into that lineup so minimums are met evenly through the build.
 */
export function playersDue(plan: OwnershipPlan, exposure: Map<string, number>, index: number, count: number) {
  return [...plan.minimums]
    .map(([id, min]) => ({ id, behind: Math.floor((min * (index + 1)) / count + 1e-9) - (exposure.get(id) ?? 0) }))
    .filter((d) => d.behind > 0)
    .sort((a, b) => b.behind - a.behind)
    .map((d) => d.id);
}
