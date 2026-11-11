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
import { easternToUtcMs } from "@/lib/time";
import { getGameWeather } from "@/lib/weather";
import { DEFAULT_MODEL, currentWeekFromSchedule, loadNflverseData, loadSchedule, projectWeek } from "@/lib/nflverse";
import { Prisma } from "@prisma/client";
import { after } from "next/server";
import prisma from "@/lib/prisma";
import { estimateRange, round1, round2, toPosition } from "@/lib/model-utils";
// SportsDataIO is only called when PROJECTION_SOURCE=sportsdataio.
import { getSeasonWeek, getSportsDataIOKey, getWeekGames, getWeekProjections } from "@/lib/sportsdataio";
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

  const { season, week } = await resolveSeasonWeek();
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

/** Builds the slate from the sources (slow on a cold server: downloads stats, schedule, Sleeper). */
async function computeSlateData(options: SlateOptions = {}): Promise<SlateData> {
  const slate = hideOutAndIr(await withStoredDkSalaries(await getBaseSlate(options)));
  return { ...slate, generatedAt: new Date().toISOString() };
}

// ---- Snapshot: the finished default slate, saved in the database --------------------------------

const SNAPSHOT_ID = "current";
/** Served as-is while younger than this. */
const SNAPSHOT_FRESH_MS = 15 * 60 * 1000;
/** Older than this, a visitor waits for a fresh build instead of seeing stale data. */
const SNAPSHOT_MAX_STALE_MS = 24 * 60 * 60 * 1000;
const LIVE_SOURCES = new Set<SlateData["source"]>(["nflverse model", "SportsDataIO", "DFS feed"]);

let refreshing: Promise<SlateData> | null = null;

/**
 * Rebuilds the default slate and saves it as the snapshot. Only live data is saved, so a temporary
 * outage never replaces a good snapshot with the database fallback or sample players. Concurrent
 * calls on one server share the same build.
 */
export function refreshSlateSnapshot(): Promise<SlateData> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const slate = await computeSlateData();
    if (process.env.DATABASE_URL && LIVE_SOURCES.has(slate.source)) {
      try {
        const data = JSON.parse(JSON.stringify(slate)) as Prisma.InputJsonValue;
        await prisma.slateSnapshot.upsert({
          where: { id: SNAPSHOT_ID },
          update: { season: slate.season, week: slate.week, source: slate.source, data },
          create: { id: SNAPSHOT_ID, season: slate.season, week: slate.week, source: slate.source, data },
        });
      } catch (error) {
        console.error("Saving the slate snapshot failed", error);
      }
      await recordProjections(slate);
    }
    return slate;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/**
 * Logs each player's projection for accuracy tracking. Only players whose game hasn't kicked off
 * are written, so after kickoff a player's row keeps his last pre-game projection.
 */
async function recordProjections(slate: SlateData) {
  const now = Date.now();
  const kickoffByTeam = new Map<string, { gameId: string; kickoff: string | null }>();
  for (const g of slate.games) {
    kickoffByTeam.set(g.awayTeam, { gameId: g.id, kickoff: g.kickoff });
    kickoffByTeam.set(g.homeTeam, { gameId: g.id, kickoff: g.kickoff });
  }
  const frozenAt = new Date(now);
  const rows = slate.players
    .map((p) => ({ p, game: kickoffByTeam.get(p.team) }))
    .filter(({ game }) => {
      const kickoffMs = easternToUtcMs(game?.kickoff);
      return kickoffMs !== null && kickoffMs > now;
    })
    .map(({ p, game }) => ({
      id: `${slate.season}-${slate.week}-${p.id}`,
      season: slate.season,
      week: slate.week,
      playerKey: p.id,
      name: p.name,
      team: p.team,
      position: p.position,
      opponent: p.opponent,
      gameId: game?.gameId ?? null,
      kickoff: game?.kickoff ?? null,
      salary: Math.round(p.salary),
      projected: p.projected,
      floor: p.floor,
      ceiling: p.ceiling,
      injury: p.injury,
      source: slate.source,
      frozenAt,
    }));
  if (rows.length === 0) return;
  try {
    await prisma.$transaction([
      prisma.projectionLog.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } }),
      prisma.projectionLog.createMany({ data: rows }),
    ]);
  } catch (error) {
    console.error("Recording projections failed", error);
  }
}

async function readSlateSnapshot(): Promise<{ slate: SlateData; ageMs: number } | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const row = await prisma.slateSnapshot.findUnique({ where: { id: SNAPSHOT_ID } });
    if (!row) return null;
    return { slate: row.data as unknown as SlateData, ageMs: Date.now() - row.updatedAt.getTime() };
  } catch (error) {
    console.error("Reading the slate snapshot failed", error);
    return null;
  }
}

/**
 * The slate pages and APIs show. The default slate comes from the saved snapshot: served directly
 * while fresh; when stale it's still served immediately and rebuilt in the background. Slates with
 * manual starters are personal, so they're always computed.
 */
export async function getSlateData(options: SlateOptions = {}): Promise<SlateData> {
  if (options.starters?.length) return computeSlateData(options);

  const snapshot = await readSlateSnapshot();
  if (snapshot && snapshot.ageMs < SNAPSHOT_FRESH_MS) return snapshot.slate;
  if (snapshot && snapshot.ageMs < SNAPSHOT_MAX_STALE_MS) {
    after(async () => {
      await refreshSlateSnapshot();
    });
    return snapshot.slate;
  }
  return refreshSlateSnapshot();
}

/** `NFL_SEASON` + `NFL_WEEK` (or the older `SPORTS_DATA_IO_SEASON` / `_WEEK`) pin the week. */
function pinnedSeasonWeek(): { season: number; week: number } | null {
  const season = Number(process.env.NFL_SEASON ?? process.env.SPORTS_DATA_IO_SEASON);
  const week = Number(process.env.NFL_WEEK ?? process.env.SPORTS_DATA_IO_WEEK);
  return season > 0 && week > 0 ? { season, week } : null;
}

/** Most recent week saved by /api/sync, used when the nflverse schedule can't be loaded. */
async function latestSyncedWeek(): Promise<{ season: number; week: number } | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    return await prisma.slate.findFirst({
      where: { gameType: SLATE_GAME_TYPE },
      orderBy: [{ season: "desc" }, { week: "desc" }],
      select: { season: true, week: true },
    });
  } catch {
    return null;
  }
}

/**
 * Season/week to project, without SportsDataIO unless it's the chosen source:
 * an env pin, else the first nflverse schedule week with unplayed games (rolls over as soon as
 * Monday night's game ends), else the last synced week.
 */
export async function resolveSeasonWeek(): Promise<{ season: number; week: number }> {
  const pinned = pinnedSeasonWeek();
  if (pinned) return pinned;
  const fromSchedule = currentWeekFromSchedule({ schedule: await loadSchedule() });
  if (fromSchedule) return fromSchedule;
  if (projectionPreference() === "sportsdataio") return getSeasonWeek();
  return (await latestSyncedWeek()) ?? { season: new Date().getFullYear(), week: 1 };
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

type ProjectionPreference = "nflverse" | "sportsdataio";

/** nflverse (free) unless `PROJECTION_SOURCE=sportsdataio`; the old "auto" value means nflverse. */
function projectionPreference(): ProjectionPreference {
  return (process.env.PROJECTION_SOURCE ?? "").toLowerCase() === "sportsdataio" ? "sportsdataio" : "nflverse";
}

/**
 * Live slate from the chosen projection source. SportsDataIO is never called unless chosen, and a
 * trial key's scrambled data is never shown: the nflverse model is used instead. When no live
 * source works, the caller falls back to the last slate saved in the database.
 */
export async function getLiveSlate(options: SlateOptions = {}): Promise<SlateData | null> {
  let live: SlateData | null;
  if (projectionPreference() === "sportsdataio") {
    const sdio = await getSportsDataIOSlate();
    live = sdio && !sdio.notices.includes(NOTICE_TRIAL) ? sdio : await getNflverseSlate(options);
  } else {
    live = await getNflverseSlate(options);
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
