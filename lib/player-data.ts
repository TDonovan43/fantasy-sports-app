import {
  NOTICE_NO_DST,
  NOTICE_TRIAL,
  applyDkSalariesToSlate,
  buildSalaryLookup,
  buildStatusLookup,
  hideOutAndIr,
  type DkSalaryRow,
} from "@/lib/dk-salaries";
import { loadSleeperDepth } from "@/lib/sleeper";
import { getGameWeather } from "@/lib/weather";
import { DEFAULT_MODEL, currentWeekFromSchedule, loadNflverseData, projectWeek } from "@/lib/nflverse";
import prisma from "@/lib/prisma";
import {
  estimateRange,
  getSeasonWeek,
  getSportsDataIOKey,
  getWeekGames,
  getWeekProjections,
  round1,
  round2,
  toPosition,
} from "@/lib/sportsdataio";
import type { Matchup, OffensePosition, PoolPlayer, Position, SlateData, StarterOverride } from "@/lib/types";

export type SlateOptions = {
  /** Players the user marked as starting (manual overrides). */
  starters?: StarterOverride[];
};

const OVERRIDE_POSITIONS = new Set<OffensePosition>(["QB", "RB", "WR", "TE"]);

/** Parses the `starters` query param: JSON array of {name, team, position}. Invalid entries are dropped. */
export function parseStarterOverrides(raw: string | null): StarterOverride[] {
  if (!raw) return [];
  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list
      .slice(0, 25)
      .filter(
        (o): o is StarterOverride =>
          !!o &&
          typeof o.name === "string" &&
          typeof o.team === "string" &&
          OVERRIDE_POSITIONS.has(o.position) &&
          o.name.length <= 60 &&
          o.team.length <= 4,
      )
      .map((o) => ({ name: o.name, team: o.team.toUpperCase(), position: o.position }));
  } catch {
    return [];
  }
}

export const DK_CLASSIC_CAP = 50000;
export const SLATE_GAME_TYPE = "DraftKings Classic";

type Json = Record<string, unknown>;

function samplePlayer(
  name: string,
  position: Position,
  team: string,
  opponent: string,
  salary: number,
  projected: number,
): PoolPlayer {
  return {
    id: `sample-${team}-${position}-${name.replace(/\W+/g, "")}`,
    name,
    position,
    team,
    opponent,
    gameKey: null,
    salary,
    projected,
    ...estimateRange(position, projected),
    rangeEstimated: true,
    value: round2(projected / (salary / 1000)),
    injury: null,
  };
}

/** Illustrative pool used only when no live source or database is reachable. */
export const samplePlayers: PoolPlayer[] = [
  samplePlayer("Jalen Hurts", "QB", "PHI", "DAL", 8600, 24.8),
  samplePlayer("C.J. Stroud", "QB", "HOU", "IND", 6800, 19.9),
  samplePlayer("Jared Goff", "QB", "DET", "GB", 6400, 18.6),
  samplePlayer("Christian McCaffrey", "RB", "SF", "MIN", 9300, 22.6),
  samplePlayer("Breece Hall", "RB", "NYJ", "NE", 7000, 15.8),
  samplePlayer("Jahmyr Gibbs", "RB", "DET", "GB", 7800, 18.2),
  samplePlayer("Tony Pollard", "RB", "TEN", "JAX", 5600, 11.9),
  samplePlayer("Jaylen Warren", "RB", "PIT", "CLE", 4900, 10.1),
  samplePlayer("Amon-Ra St. Brown", "WR", "DET", "GB", 8200, 18.4),
  samplePlayer("Puka Nacua", "WR", "LAR", "SEA", 7600, 17.1),
  samplePlayer("CeeDee Lamb", "WR", "DAL", "PHI", 8400, 18.9),
  samplePlayer("Nico Collins", "WR", "HOU", "IND", 6900, 15.2),
  samplePlayer("Jordan Addison", "WR", "MIN", "SF", 5700, 12.6),
  samplePlayer("Jayden Reed", "WR", "GB", "DET", 5200, 11.8),
  samplePlayer("Khalil Shakir", "WR", "BUF", "MIA", 4600, 10.2),
  samplePlayer("Sam LaPorta", "TE", "DET", "GB", 6100, 14.9),
  samplePlayer("George Kittle", "TE", "SF", "MIN", 5800, 12.7),
  samplePlayer("Dalton Kincaid", "TE", "BUF", "MIA", 4400, 9.6),
  samplePlayer("49ers", "DST", "SF", "MIN", 3600, 8.4),
  samplePlayer("Eagles", "DST", "PHI", "DAL", 3200, 7.6),
  samplePlayer("Steelers", "DST", "PIT", "CLE", 2800, 7.1),
];

const sampleGames: Matchup[] = [
  { id: "sample-1", awayTeam: "DET", homeTeam: "GB", kickoff: null, pointSpread: null, overUnder: null, channel: null, status: "Sample" },
  { id: "sample-2", awayTeam: "PHI", homeTeam: "DAL", kickoff: null, pointSpread: null, overUnder: null, channel: null, status: "Sample" },
  { id: "sample-3", awayTeam: "SF", homeTeam: "MIN", kickoff: null, pointSpread: null, overUnder: null, channel: null, status: "Sample" },
];

const SALARY_KEYS = [
  "DraftKingsSalary",
  "draftkings_salary",
  "DKSalary",
  "dk_salary",
  "DfsSalary",
  "DFSSalary",
  "Salary",
  "salary",
  "salary_usd",
  "salaryUSD",
  "current_salary",
];

function firstNumber(raw: Json, keys: string[]): number {
  for (const key of keys) {
    const n = Number(raw[key]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function firstString(raw: Json, keys: string[]): string | null {
  for (const key of keys) {
    const v = raw[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Normalizes a row from an arbitrary licensed DFS JSON feed. */
export function normalizeFeedRow(raw: Json, index: number): PoolPlayer | null {
  const name = firstString(raw, ["name", "Name", "player_name", "display_name", "playerName"]);
  const position = toPosition(raw.position ?? raw.Position ?? raw.pos);
  if (!name || !position) return null;

  const team = firstString(raw, ["team", "Team", "team_abbr", "teamAbbr", "franchise"]) ?? "FA";
  const salary = firstNumber(raw, SALARY_KEYS);
  const projected = round1(
    firstNumber(raw, ["projected", "FantasyPointsDraftKings", "projected_points", "projectedFantasyPoints", "fantasy_points", "fppg"]),
  );
  const suppliedFloor = firstNumber(raw, ["floor", "Floor", "low", "min_projection"]);
  const suppliedCeiling = firstNumber(raw, ["ceiling", "Ceiling", "high", "max_projection"]);
  const estimated = estimateRange(position, projected);

  return {
    id: String(raw.id ?? raw.PlayerID ?? `feed-${index}-${name}`),
    name,
    position,
    team,
    opponent: firstString(raw, ["opponent", "Opponent", "opp"]),
    gameKey: firstString(raw, ["gameKey", "GameKey", "game_id"]),
    salary,
    projected,
    floor: suppliedFloor || estimated.floor,
    ceiling: suppliedCeiling || estimated.ceiling,
    rangeEstimated: !(suppliedFloor && suppliedCeiling),
    value: salary > 0 ? round2(projected / (salary / 1000)) : 0,
    injury: firstString(raw, ["injury", "InjuryStatus", "status"]),
  };
}

async function fetchFeedPlayers(): Promise<PoolPlayer[]> {
  const feedUrl = process.env.DFS_FEED_URL ?? process.env.DFS_DATA_FEED_URL ?? process.env.DRAFTKINGS_FEED_URL;
  if (!feedUrl) return [];

  try {
    const response = await fetch(feedUrl, { cache: "no-store" });
    if (!response.ok) return [];
    const json: unknown = await response.json();
    const container = json as { players?: unknown; data?: unknown };
    const payload = Array.isArray(json)
      ? json
      : Array.isArray(container?.players)
        ? container.players
        : Array.isArray(container?.data)
          ? container.data
          : [];

    return (payload as Json[])
      .map((row, i) => normalizeFeedRow(row, i))
      .filter((p): p is PoolPlayer => p !== null && p.projected > 0);
  } catch {
    return [];
  }
}

/** Reads the most recently synced DraftKings slate from Postgres. */
export async function getDatabaseSlate(): Promise<SlateData | null> {
  if (!process.env.DATABASE_URL) return null;

  try {
    const slate = await prisma.slate.findFirst({
      where: { gameType: SLATE_GAME_TYPE },
      orderBy: [{ season: "desc" }, { week: "desc" }, { updatedAt: "desc" }],
      include: {
        games: { orderBy: { kickoff: "asc" } },
        projections: { include: { player: true } },
        salaries: true,
      },
    });
    if (!slate || slate.projections.length === 0) return null;

    const salaryByPlayer = new Map(slate.salaries.map((s) => [s.playerId, s.salary]));
    const players: PoolPlayer[] = [];
    for (const proj of slate.projections) {
      const position = toPosition(proj.player.position);
      if (!position) continue;
      const salary = salaryByPlayer.get(proj.playerId) ?? 0;
      const projected = proj.projectedFantasyPoints;
      const estimated = estimateRange(position, projected);
      players.push({
        id: proj.player.externalId ?? proj.player.id,
        name: proj.player.name,
        position,
        team: proj.player.team ?? "FA",
        opponent: proj.opponent,
        gameKey: proj.gameKey,
        salary,
        projected,
        floor: proj.floor ?? estimated.floor,
        ceiling: proj.ceiling ?? estimated.ceiling,
        rangeEstimated: proj.floor === null || proj.ceiling === null,
        value: salary > 0 ? round2(projected / (salary / 1000)) : 0,
        injury: proj.player.status,
      });
    }

    return {
      season: slate.season,
      week: slate.week,
      source: "Database",
      salaryCap: slate.salaryCap,
      players,
      games: slate.games.map((g) => ({
        id: g.id,
        awayTeam: g.awayTeam,
        homeTeam: g.homeTeam,
        kickoff: g.kickoff?.toISOString() ?? null,
        pointSpread: g.pointSpread,
        overUnder: g.overUnder,
        channel: g.channel,
        status: g.status,
      })),
      notices: [`Showing the last database sync (${slate.updatedAt.toLocaleString("en-US")}).`],
      dkSalaries: null,
    };
  } catch (error) {
    console.error("Database slate read failed", error);
    return null;
  }
}

/** Live SportsDataIO slate, or null when no key is configured / the request fails. */
export async function getSportsDataIOSlate(): Promise<SlateData | null> {
  if (!getSportsDataIOKey()) return null;

  const { season, week } = await getSeasonWeek();
  const [projections, games] = await Promise.all([getWeekProjections(season, week), getWeekGames(season, week)]);
  if (!projections || projections.players.length === 0) return null;

  const notices: string[] = [];
  if (projections.scrambled) {
    notices.push(NOTICE_TRIAL);
  }
  if (!projections.players.some((p) => p.position === "DST")) {
    notices.push(NOTICE_NO_DST);
  }
  notices.push("Floor and ceiling are estimated from projection and positional volatility.");

  return {
    season,
    week,
    source: "SportsDataIO",
    salaryCap: DK_CLASSIC_CAP,
    players: projections.players,
    games,
    notices,
    dkSalaries: null,
  };
}

/** DraftKings salary rows uploaded for a given week, newest upload only. */
export async function getStoredDkSalaries(season: number, week: number): Promise<{ rows: DkSalaryRow[]; uploadedAt: string } | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const rows = await prisma.dkSalary.findMany({ where: { season, week } });
    if (rows.length === 0) return null;
    const uploadedAt = rows.reduce((max, r) => (r.uploadedAt > max ? r.uploadedAt : max), rows[0].uploadedAt);
    return {
      uploadedAt: uploadedAt.toISOString(),
      rows: rows.map((r) => ({
        dkId: r.dkId,
        name: r.name,
        position: toPosition(r.position) ?? "WR",
        rosterPosition: r.rosterPosition,
        salary: r.salary,
        team: r.team,
        opponent: r.opponent,
        kickoff: r.kickoff,
        gameInfo: r.gameInfo,
        avgPoints: r.avgPoints,
        status: r.status,
      })),
    };
  } catch (error) {
    console.error("DK salary read failed", error);
    return null;
  }
}

/** Overlays the week's uploaded DraftKings salaries, if any, onto a slate. */
export async function withStoredDkSalaries(slate: SlateData): Promise<SlateData> {
  const stored = await getStoredDkSalaries(slate.season, slate.week);
  return stored ? applyDkSalariesToSlate(slate, stored.rows, stored.uploadedAt) : slate;
}

export async function getSlateData(options: SlateOptions = {}): Promise<SlateData> {
  return hideOutAndIr(await withStoredDkSalaries(await getBaseSlate(options)));
}

/**
 * Season/week to project: pinned by env, else SportsDataIO's current week, else the first
 * week in the nflverse schedule with unplayed games.
 */
export async function resolveSeasonWeek(): Promise<{ season: number; week: number }> {
  if ((process.env.SPORTS_DATA_IO_SEASON && process.env.SPORTS_DATA_IO_WEEK) || getSportsDataIOKey()) {
    return getSeasonWeek();
  }
  const fromSchedule = currentWeekFromSchedule(await loadNflverseData(new Date().getFullYear()));
  return fromSchedule ?? getSeasonWeek();
}

/** Live slate projected by the FieldGoal model on nflverse data, or null if the data is unavailable. */
export async function getNflverseSlate(options: SlateOptions = {}): Promise<SlateData | null> {
  try {
    const { season, week } = await resolveSeasonWeek();
    const [data, depth] = await Promise.all([loadNflverseData(season), loadSleeperDepth()]);
    if (!data.stats.get(season)?.length || data.schedule.length === 0) return null;

    const stored = await getStoredDkSalaries(season, week);
    const result = projectWeek(data, season, week, {
      salaryOf: stored ? buildSalaryLookup(stored.rows) : undefined,
      statusOf: stored ? buildStatusLookup(stored.rows) : undefined,
      model: DEFAULT_MODEL,
      depth,
      starters: options.starters,
    });
    if (result.players.length === 0) return null;

    const notices = [
      `Projections: FieldGoal model on nflverse stats through week ${result.throughWeek}. It uses recency-weighted DraftKings points, opponent and Vegas adjustments${stored ? ", and a salary prior for small samples" : ""}.`,
      result.hasLines
        ? "Spreads and totals come from the nflverse schedule."
        : "No betting lines are posted for this week yet, so projections use only the opponent adjustment.",
      depth
        ? "Starting QBs and injury status come from Sleeper's depth charts. Starters without enough recent games are projected from past games plus the team's role baseline (tagged \"limited data\")."
        : "Sleeper depth charts are unavailable right now, so starting QBs are taken from each team's last game.",
    ];
    const weather = await getGameWeather(result.venues);
    const games = result.games.map((g) => {
      const wx = weather.get(g.id);
      return { ...g, roof: wx?.roof ?? g.roof ?? null, weather: wx?.weather ?? null };
    });
    return {
      season,
      week,
      source: "nflverse model",
      salaryCap: DK_CLASSIC_CAP,
      players: result.players,
      games,
      teams: result.teams,
      notices,
      dkSalaries: null,
    };
  } catch (error) {
    console.error("nflverse projection failed", error);
    return null;
  }
}

type ProjectionPreference = "auto" | "nflverse" | "sportsdataio";

function projectionPreference(): ProjectionPreference {
  const v = (process.env.PROJECTION_SOURCE ?? "auto").toLowerCase();
  return v === "nflverse" || v === "sportsdataio" ? v : "auto";
}

/**
 * Best live projection source. `PROJECTION_SOURCE`: "sportsdataio" or "nflverse" to force one;
 * "auto" (default) prefers a paid SportsDataIO key and falls back to the nflverse model when the
 * key is missing or a trial key (scrambled data).
 */
export async function getLiveSlate(options: SlateOptions = {}): Promise<SlateData | null> {
  const pref = projectionPreference();
  let live: SlateData | null;
  if (pref === "nflverse") {
    live = (await getNflverseSlate(options)) ?? (await getSportsDataIOSlate());
  } else if (pref === "sportsdataio") {
    live = (await getSportsDataIOSlate()) ?? (await getNflverseSlate(options));
  } else {
    const sdio = await getSportsDataIOSlate();
    live = sdio && !sdio.notices.includes(NOTICE_TRIAL) ? sdio : ((await getNflverseSlate(options)) ?? sdio);
  }
  if (live) return live;

  const feedPlayers = await fetchFeedPlayers();
  if (feedPlayers.length > 0) {
    const { season, week } = await resolveSeasonWeek();
    return { season, week, source: "DFS feed", salaryCap: DK_CLASSIC_CAP, players: feedPlayers, games: [], notices: [], dkSalaries: null };
  }
  return null;
}

async function getBaseSlate(options: SlateOptions): Promise<SlateData> {
  const live = await getLiveSlate(options);
  if (live) return live;

  const db = await getDatabaseSlate();
  if (db) return db;

  const { season, week } = await resolveSeasonWeek();
  return {
    season,
    week,
    source: "Sample data",
    salaryCap: DK_CLASSIC_CAP,
    players: samplePlayers,
    games: sampleGames,
    notices: ["No live data source is reachable. Showing illustrative sample players."],
    dkSalaries: null,
  };
}
