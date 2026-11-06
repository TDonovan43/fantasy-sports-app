export const POSITIONS = ["QB", "RB", "WR", "TE", "DST"] as const;
export type Position = (typeof POSITIONS)[number];

export type DataSource = "SportsDataIO" | "DFS feed" | "Database" | "Sample data";

export type PoolPlayer = {
  /** Stable id, e.g. `sdio-23241`. */
  id: string;
  name: string;
  position: Position;
  team: string;
  opponent: string | null;
  gameKey: string | null;
  /** DraftKings salary in dollars, 0 when unknown. */
  salary: number;
  /** Projected DraftKings fantasy points. */
  projected: number;
  floor: number;
  ceiling: number;
  /** True when floor/ceiling were estimated rather than supplied by the source. */
  rangeEstimated: boolean;
  /** Points per $1K of salary. */
  value: number;
  injury: string | null;
  /** DraftKings player ID (from an uploaded DKSalaries.csv). */
  dkId?: string;
  /** True when the projection is DraftKings' season average, not a real projection. */
  projectionFromDkAvg?: boolean;
};

export type Matchup = {
  id: string;
  awayTeam: string;
  homeTeam: string;
  /** ISO string, Eastern time as reported by the provider. */
  kickoff: string | null;
  pointSpread: number | null;
  overUnder: number | null;
  channel: string | null;
  status: string | null;
};

export type SlateData = {
  season: number;
  week: number;
  source: DataSource;
  salaryCap: number;
  players: PoolPlayer[];
  games: Matchup[];
  /** Human-readable notes about data quality (trial keys, missing DST, etc). */
  notices: string[];
  /** Set when salaries come from an uploaded DraftKings CSV. */
  dkSalaries: { uploadedAt: string; players: number } | null;
};
