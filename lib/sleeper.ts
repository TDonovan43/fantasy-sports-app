import type { OffensePosition } from "@/lib/types";

/**
 * Depth charts and injury status from Sleeper's public player feed (https://docs.sleeper.com).
 * Free, no key. The feed is ~15MB and Sleeper asks clients to fetch it sparingly, so it's cached
 * in memory for several hours.
 */

const URL = "https://api.sleeper.app/v1/players/nfl";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const POSITIONS = new Set<OffensePosition>(["QB", "RB", "WR", "TE"]);

export type DepthInfo = {
  name: string;
  team: string;
  position: OffensePosition;
  /** 1 = starter; null when Sleeper has no depth chart slot for the player. */
  depthOrder: number | null;
  /** Normalized: OUT, IR, PUP, D, Q, or null. */
  injury: string | null;
};

type SleeperPlayer = {
  full_name?: string;
  team?: string | null;
  position?: string;
  depth_chart_order?: number | null;
  injury_status?: string | null;
  active?: boolean;
};

function normalizeInjury(status: string | null | undefined): string | null {
  switch ((status ?? "").toLowerCase()) {
    case "out":
      return "OUT";
    case "ir":
      return "IR";
    case "pup":
      return "PUP";
    case "doubtful":
      return "D";
    case "questionable":
      return "Q";
    case "sus":
    case "suspended":
      return "SUSPENDED";
    default:
      return null;
  }
}

let memo: { expires: number; value: Promise<DepthInfo[] | null> } | null = null;

export function loadSleeperDepth(): Promise<DepthInfo[] | null> {
  if (memo && memo.expires > Date.now()) return memo.value;
  const value = (async () => {
    try {
      const res = await fetch(URL, { cache: "no-store" });
      if (!res.ok) return null;
      const json = (await res.json()) as Record<string, SleeperPlayer>;
      const out: DepthInfo[] = [];
      for (const p of Object.values(json)) {
        const position = p.position as OffensePosition;
        if (!p.full_name || !p.team || !POSITIONS.has(position) || p.active === false) continue;
        out.push({
          name: p.full_name,
          team: p.team,
          position,
          depthOrder: typeof p.depth_chart_order === "number" ? p.depth_chart_order : null,
          injury: normalizeInjury(p.injury_status),
        });
      }
      return out.length ? out : null;
    } catch (error) {
      console.error("Sleeper depth chart fetch failed", error);
      return null;
    }
  })();
  memo = { expires: Date.now() + CACHE_TTL_MS, value };
  value.then((v) => {
    if (!v) memo = null; // retry sooner after a failure
  });
  return value;
}
