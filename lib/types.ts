export const POSITIONS = ["QB", "RB", "WR", "TE", "DST"] as const;
export type Position = (typeof POSITIONS)[number];

export type DataSource = "SportsDataIO" | "nflverse model" | "DFS feed" | "Database" | "Sample data";

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
  /** Inputs behind the projection (nflverse model only). */
  research?: PlayerResearch;
  /** Establish The Run numbers from a browser upload (ownership in %, 0–100). */
  etr?: { projected: number; floor: number | null; ceiling: number | null; ownSmall: number | null; ownLarge: number | null };
  /** True at home, false on the road (unknown when the schedule doesn't list his game). */
  isHome?: boolean;
  /** Estimated weather effect at kickoff, for awareness only (not applied to projections). */
  weatherImpact?: { pct: number; label: string; detail: string };
  /** FieldGoal's own numbers, kept when the projection source is ETR or Blend. */
  fieldgoal?: { projected: number; floor: number; ceiling: number };
};

/** The numbers that feed a player's projection, all per game unless noted. */
export type PlayerResearch = {
  /** Current-season games used by the model. */
  games: number;
  /** DK points per game, this season. */
  seasonAvg: number;
  last3Avg: number;
  /** Recency-weighted DK points (includes last season at reduced weight). */
  weightedAvg: number;
  /** Salary-implied points prior, when salaries are loaded. */
  salaryPrior: number | null;
  /** Projection after shrinkage, before matchup/Vegas/role adjustments. */
  baseProjection: number;
  /** Opponent adjustment vs. this position (1 = neutral). */
  matchupFactor: number;
  /** Implied team total vs. team scoring average (1 = neutral). */
  vegasFactor: number | null;
  /** Team implied total (for DST: the opponent's). */
  impliedTotal: number | null;
  /** QB starter/backup adjustment (1 = starter). */
  roleFactor: number;
  passYds?: number;
  passTds?: number;
  passAtt?: number;
  rushYds?: number;
  rushAtt?: number;
  recYds?: number;
  targets?: number;
  receptions?: number;
  /** DST only. */
  sacks?: number;
  takeaways?: number;
  pointsAllowed?: number;
  /** Set when the player is a designated starter without enough recent games to project normally. */
  limitedData?: {
    /** Why he's treated as a starter. */
    source: "depth chart" | "manual";
    /** Past games (any season loaded) with a real role, and their average DK points. */
    historyGames: number;
    historyAvg: number | null;
    /** Points expected from the role (e.g. the team's QB production this season). */
    roleBaseline: number;
  };
  /** True when this player is the team's starter only because of a manual override. */
  manualStarter?: boolean;
  /** Most recent games, newest first (last season's fill in when this season has few). */
  gameLog?: GameLogEntry[];
};

/** One game in a player's (or defense's) recent log. Only the stats for his position are filled. */
export type GameLogEntry = {
  season: number;
  week: number;
  opponent: string;
  /** null when unknown. */
  home: boolean | null;
  /** DraftKings points. */
  points: number;
  passAtt?: number;
  passYds?: number;
  passTds?: number;
  ints?: number;
  rushAtt?: number;
  rushYds?: number;
  targets?: number;
  receptions?: number;
  recYds?: number;
  /** Rushing + receiving TDs. */
  tds?: number;
  sacks?: number;
  takeaways?: number;
  pointsAllowed?: number;
};

/** A player the user marked as starting (browser-only override). */
export type StarterOverride = { name: string; team: string; position: OffensePosition };

export type OffensePosition = "QB" | "RB" | "WR" | "TE";

/** Season-to-date team profile. Ranks are 1..N where 1 = the highest value. */
export type TeamProfile = {
  team: string;
  games: number;
  offense: {
    points: number;
    passYds: number;
    rushYds: number;
    /** DK points this offense gives up to opposing defenses. */
    dstPointsAllowed: number;
    ranks: { points: number; passYds: number; rushYds: number; dstPointsAllowed: number };
  };
  defense: {
    pointsAllowed: number;
    passYdsAllowed: number;
    rushYdsAllowed: number;
    /** DK points allowed to each offensive position. */
    dkAllowed: Record<OffensePosition, number>;
    ranks: {
      pointsAllowed: number;
      passYdsAllowed: number;
      rushYdsAllowed: number;
      dkAllowed: Record<OffensePosition, number>;
    };
  };
};

export type GameWeather = {
  tempF: number | null;
  windMph: number | null;
  precipChance: number | null;
  conditions: string | null;
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
  awayMoneyline?: number | null;
  homeMoneyline?: number | null;
  awayScore?: number | null;
  homeScore?: number | null;
  stadium?: string | null;
  /** "outdoors", "dome" or "retractable". */
  roof?: string | null;
  weather?: GameWeather | null;
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
  /** Season-to-date team profiles keyed by team (nflverse model only). */
  teams?: Record<string, TeamProfile>;
  /** Count of players hidden because they are listed OUT or IR. */
  hiddenInactive?: number;
  /** DraftKings players on the slate with no projection (no recent games), not OUT/IR. */
  unprojected?: PoolPlayer[];
  /** Set when salaries come from an uploaded DraftKings CSV. */
  dkSalaries: { uploadedAt: string; players: number } | null;
  /** When this slate was built (ISO). Pages serve a saved snapshot, so this can be minutes old. */
  generatedAt?: string;
};
