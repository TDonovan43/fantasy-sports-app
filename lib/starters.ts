import { normalizeName } from "@/lib/dk-salaries";
import type { OffensePosition, PoolPlayer, StarterOverride } from "@/lib/types";

export type StarterControls = {
  starters: StarterOverride[];
  isMarked: (p: PoolPlayer) => boolean;
  /** Whether the "Mark starting" control applies to this player. */
  canMark: (p: PoolPlayer) => boolean;
  toggle: (p: PoolPlayer) => void;
  /** True while the slate is being recalculated with the current overrides. */
  pending: boolean;
};

export function matchesOverride(o: StarterOverride, p: Pick<PoolPlayer, "name" | "team" | "position">) {
  return o.team === p.team && o.position === p.position && normalizeName(o.name) === normalizeName(p.name);
}

/** Adds or removes an override. Only one QB per team can be marked. */
export function toggleOverride(list: StarterOverride[], p: PoolPlayer): StarterOverride[] {
  if (p.position === "DST") return list;
  if (list.some((o) => matchesOverride(o, p))) return list.filter((o) => !matchesOverride(o, p));
  const position = p.position as OffensePosition;
  const kept = position === "QB" ? list.filter((o) => !(o.team === p.team && o.position === "QB")) : list;
  return [...kept, { name: p.name, team: p.team, position }];
}
