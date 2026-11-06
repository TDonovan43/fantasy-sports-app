import { parseCsvObjects } from "@/lib/csv";
import { isInactive } from "@/lib/dk-salaries";
import { round1, round2 } from "@/lib/sportsdataio";
import type { Matchup, OffensePosition, PlayerResearch, PoolPlayer, Position, TeamProfile } from "@/lib/types";

/**
 * FieldGoal projection model built on nflverse data (https://github.com/nflverse/nflverse-data).
 *
 * For each player: recency-weighted DraftKings points per game (current season, plus last season
 * at reduced weight), shrunk toward a salary-implied prior for small samples, then adjusted for
 * the opponent (DK points allowed to the position) and the Vegas implied team total.
 */

const RELEASES = "https://github.com/nflverse/nflverse-data/releases/download";
const CACHE_TTL_MS = 30 * 60 * 1000;

export type ModelOptions = {
  /** Per-game weight decay going back in time. */
  decay: number;
  /** Weight multiplier for last season's games. */
  priorSeasonWeight: number;
  /** Pseudo-games of the prior (salary-implied or positional) blended into each player. */
  shrinkGames: number;
  /** Leave out teams whose game this week is already final (on for live use, off for backtests). */
  skipCompletedGames?: boolean;
};

// Tuned by backtest on 2026 weeks 4-8 (lowest MAE region; results were flat across nearby settings).
export const DEFAULT_MODEL: ModelOptions = { decay: 0.95, priorSeasonWeight: 0.7, shrinkGames: 1 };
const DST_SHRINK_GAMES = 3;
const OPP_SHRINK_GAMES = 5;
const OFFENSE_POSITIONS: Position[] = ["QB", "RB", "WR", "TE"];
/** Typical game-to-game coefficient of variation, used to stabilize small-sample spreads. */
const POSITION_CV: Record<Position, number> = { QB: 0.35, RB: 0.5, WR: 0.55, TE: 0.6, DST: 0.7 };

type Row = Record<string, string>;

export type NflverseData = {
  /** Weekly player stats keyed by season. */
  stats: Map<number, Row[]>;
  schedule: Row[];
  injuries: Row[];
};

const memo = new Map<string, { expires: number; value: Promise<Row[]> }>();

function fetchCsv(url: string): Promise<Row[]> {
  const cached = memo.get(url);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = fetch(url, { cache: "no-store" })
    .then(async (res) => (res.ok ? parseCsvObjects(await res.text()) : []))
    .catch(() => [] as Row[]);
  memo.set(url, { expires: Date.now() + CACHE_TTL_MS, value });
  // Don't cache failures for the full TTL.
  value.then((rows) => rows.length === 0 && memo.delete(url));
  return value;
}

export async function loadNflverseData(season: number): Promise<NflverseData> {
  const [current, prior, schedule, injuries] = await Promise.all([
    fetchCsv(`${RELEASES}/stats_player/stats_player_week_${season}.csv`),
    fetchCsv(`${RELEASES}/stats_player/stats_player_week_${season - 1}.csv`),
    fetchCsv(`${RELEASES}/schedules/games.csv`),
    fetchCsv(`${RELEASES}/injuries/injuries_${season}.csv`),
  ]);
  return {
    stats: new Map([
      [season, current],
      [season - 1, prior],
    ]),
    schedule,
    injuries,
  };
}

/** nflverse uses "LA" for the Rams; DraftKings and SportsDataIO use "LAR". */
export const teamAbbr = (t: string) => (t === "LA" ? "LAR" : t);

const n = (v: string | undefined) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

function toOffensePosition(raw: string): Position | null {
  if (raw === "QB" || raw === "RB" || raw === "WR" || raw === "TE") return raw;
  if (raw === "FB") return "RB";
  return null;
}

/** DraftKings NFL Classic scoring for an offensive player's game. */
export function dkOffensePoints(r: Row): number {
  const passYds = n(r.passing_yards);
  const rushYds = n(r.rushing_yards);
  const recYds = n(r.receiving_yards);
  return (
    passYds * 0.04 +
    n(r.passing_tds) * 4 -
    n(r.passing_interceptions) +
    (passYds >= 300 ? 3 : 0) +
    rushYds * 0.1 +
    n(r.rushing_tds) * 6 +
    (rushYds >= 100 ? 3 : 0) +
    n(r.receptions) +
    recYds * 0.1 +
    n(r.receiving_tds) * 6 +
    (recYds >= 100 ? 3 : 0) +
    (n(r.special_teams_tds) + n(r.fumble_recovery_tds)) * 6 +
    (n(r.passing_2pt_conversions) + n(r.rushing_2pt_conversions) + n(r.receiving_2pt_conversions)) * 2 -
    (n(r.sack_fumbles_lost) + n(r.rushing_fumbles_lost) + n(r.receiving_fumbles_lost))
  );
}

function pointsAllowedScore(pa: number) {
  if (pa === 0) return 10;
  if (pa <= 6) return 7;
  if (pa <= 13) return 4;
  if (pa <= 20) return 1;
  if (pa <= 27) return 0;
  if (pa <= 34) return -1;
  return -4;
}

type PlayerGame = {
  playerId: string;
  name: string;
  position: Position;
  team: string;
  opponent: string;
  gameId: string;
  season: number;
  week: number;
  points: number;
  usage: number;
  attempts: number;
  passYds: number;
  passTds: number;
  rushYds: number;
  rushAtt: number;
  recYds: number;
  targets: number;
  receptions: number;
};

/** Backup QBs keep this share of their projection (garbage time, trick plays). */
const BACKUP_QB_FACTOR = 0.1;
/** Pseudo-games of salary prior for a backup QB promoted to starter (his own sample is relief work). */
const PROMOTED_QB_SHRINK = 6;

type TeamGame = {
  team: string;
  opponent: string;
  gameId: string;
  season: number;
  week: number;
  dstPoints: number;
  pointsFor: number;
  pointsAllowed: number;
  passYds: number;
  rushYds: number;
  sacks: number;
  takeaways: number;
};

type ScheduleGame = {
  gameId: string;
  season: number;
  week: number;
  away: string;
  home: string;
  awayScore: number | null;
  homeScore: number | null;
  spread: number | null;
  total: number | null;
  kickoff: string | null;
  awayMoneyline: number | null;
  homeMoneyline: number | null;
  stadiumId: string;
  stadium: string | null;
  roof: string | null;
};

const numOrNull = (v: string | undefined) => (v === undefined || v === "" ? null : n(v));

function parseSchedule(rows: Row[]): ScheduleGame[] {
  return rows
    .filter((r) => r.game_type === "REG")
    .map((r) => ({
      gameId: r.game_id,
      season: n(r.season),
      week: n(r.week),
      away: teamAbbr(r.away_team),
      home: teamAbbr(r.home_team),
      awayScore: r.away_score === "" ? null : n(r.away_score),
      homeScore: r.home_score === "" ? null : n(r.home_score),
      spread: r.spread_line === "" ? null : n(r.spread_line),
      total: r.total_line === "" ? null : n(r.total_line),
      kickoff: r.gameday ? `${r.gameday}T${(r.gametime || "13:00").padStart(5, "0")}:00` : null,
      awayMoneyline: numOrNull(r.away_moneyline),
      homeMoneyline: numOrNull(r.home_moneyline),
      stadiumId: r.stadium_id,
      stadium: r.stadium || null,
      roof: r.roof || null,
    }));
}

/** Latest season/week in the schedule that still has unplayed games. */
export function currentWeekFromSchedule(data: NflverseData): { season: number; week: number } | null {
  const upcoming = parseSchedule(data.schedule)
    .filter((g) => g.homeScore === null)
    .sort((a, b) => a.season - b.season || a.week - b.week);
  return upcoming[0] ? { season: upcoming[0].season, week: upcoming[0].week } : null;
}

/** Weighted mean/sd; `sumW` is the effective sample size (Kish), in games. */
function weightedStats(values: { value: number; weight: number }[]) {
  const total = values.reduce((s, v) => s + v.weight, 0);
  if (total === 0) return { mean: 0, sd: 0, sumW: 0 };
  const mean = values.reduce((s, v) => s + v.value * v.weight, 0) / total;
  const variance = values.reduce((s, v) => s + v.weight * (v.value - mean) ** 2, 0) / total;
  const sumSq = values.reduce((s, v) => s + v.weight ** 2, 0);
  return { mean, sd: Math.sqrt(variance), sumW: (total * total) / sumSq };
}

/** Least-squares fit of points on salary, per position. */
function fitSalaryPrior(samples: { salary: number; points: number }[]) {
  if (samples.length < 8) return null;
  const mx = samples.reduce((s, p) => s + p.salary, 0) / samples.length;
  const my = samples.reduce((s, p) => s + p.points, 0) / samples.length;
  const sxx = samples.reduce((s, p) => s + (p.salary - mx) ** 2, 0);
  if (sxx === 0) return null;
  const slope = samples.reduce((s, p) => s + (p.salary - mx) * (p.points - my), 0) / sxx;
  return (salary: number) => Math.max(0, my + slope * (salary - mx));
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export type SalaryLookup = (name: string, team: string, position: Position) => number | undefined;
/** Injury/status lookup from another source (e.g. DraftKings' Status column). */
export type StatusLookup = (name: string, team: string, position: Position) => string | null | undefined;

/** Where and when a game is played, for the weather lookup. */
export type Venue = { gameId: string; stadiumId: string; homeTeam: string; kickoff: string | null; roof: string | null };

export type ProjectionResult = {
  players: PoolPlayer[];
  games: Matchup[];
  teams: Record<string, TeamProfile>;
  venues: Venue[];
  /** Last completed week of stats that fed the model. */
  throughWeek: number;
  hasLines: boolean;
};

function perGame<T>(list: T[], pick: (item: T) => number) {
  return list.length ? list.reduce((sum, x) => sum + pick(x), 0) / list.length : 0;
}

/** Ranks values descending: 1 = highest. */
function rankDesc(values: Map<string, number>) {
  const sorted = [...values.entries()].sort((a, b) => b[1] - a[1]);
  return new Map(sorted.map(([team], i) => [team, i + 1]));
}

const OFFENSE: OffensePosition[] = ["QB", "RB", "WR", "TE"];

/** Season-to-date offense/defense profiles with league ranks. */
function buildTeamProfiles(seasonGames: TeamGame[], allowed: Map<string, Map<string, number>>): Record<string, TeamProfile> {
  const byTeam = new Map<string, TeamGame[]>();
  // Rows keyed by the opponent describe what that opponent allowed.
  const againstTeam = new Map<string, TeamGame[]>();
  for (const g of seasonGames) {
    byTeam.set(g.team, [...(byTeam.get(g.team) ?? []), g]);
    againstTeam.set(g.opponent, [...(againstTeam.get(g.opponent) ?? []), g]);
  }

  const metric = (fn: (team: string) => number) => new Map([...byTeam.keys()].map((t) => [t, fn(t)]));
  const off = (t: string, pick: (g: TeamGame) => number) => perGame(byTeam.get(t) ?? [], pick);
  const def = (t: string, pick: (g: TeamGame) => number) => perGame(againstTeam.get(t) ?? [], pick);
  const dk = (t: string, pos: string) => perGame([...(allowed.get(t + "|" + pos)?.values() ?? [])], (x) => x);

  const points = metric((t) => off(t, (g) => g.pointsFor));
  const passYds = metric((t) => off(t, (g) => g.passYds));
  const rushYds = metric((t) => off(t, (g) => g.rushYds));
  const dstAllowed = metric((t) => def(t, (g) => g.dstPoints));
  const pa = metric((t) => def(t, (g) => g.pointsFor));
  const passAllowed = metric((t) => def(t, (g) => g.passYds));
  const rushAllowed = metric((t) => def(t, (g) => g.rushYds));
  const dkAllowed = Object.fromEntries(OFFENSE.map((pos) => [pos, metric((t) => dk(t, pos))])) as Record<
    OffensePosition,
    Map<string, number>
  >;

  const ranks = {
    points: rankDesc(points),
    passYds: rankDesc(passYds),
    rushYds: rankDesc(rushYds),
    dstAllowed: rankDesc(dstAllowed),
    pa: rankDesc(pa),
    passAllowed: rankDesc(passAllowed),
    rushAllowed: rankDesc(rushAllowed),
    dk: Object.fromEntries(OFFENSE.map((pos) => [pos, rankDesc(dkAllowed[pos])])) as Record<OffensePosition, Map<string, number>>,
  };

  const byPos = <T,>(fn: (pos: OffensePosition) => T) => Object.fromEntries(OFFENSE.map((pos) => [pos, fn(pos)])) as Record<OffensePosition, T>;

  const out: Record<string, TeamProfile> = {};
  for (const team of byTeam.keys()) {
    out[team] = {
      team,
      games: byTeam.get(team)!.length,
      offense: {
        points: round1(points.get(team)!),
        passYds: round1(passYds.get(team)!),
        rushYds: round1(rushYds.get(team)!),
        dstPointsAllowed: round1(dstAllowed.get(team)!),
        ranks: {
          points: ranks.points.get(team)!,
          passYds: ranks.passYds.get(team)!,
          rushYds: ranks.rushYds.get(team)!,
          dstPointsAllowed: ranks.dstAllowed.get(team)!,
        },
      },
      defense: {
        pointsAllowed: round1(pa.get(team)!),
        passYdsAllowed: round1(passAllowed.get(team)!),
        rushYdsAllowed: round1(rushAllowed.get(team)!),
        dkAllowed: byPos((pos) => round1(dkAllowed[pos].get(team)!)),
        ranks: {
          pointsAllowed: ranks.pa.get(team)!,
          passYdsAllowed: ranks.passAllowed.get(team)!,
          rushYdsAllowed: ranks.rushAllowed.get(team)!,
          dkAllowed: byPos((pos) => ranks.dk[pos].get(team)!),
        },
      },
    };
  }
  return out;
}

/** Pure projection step: projects `week` of `season` using only games before it. */
export function projectWeek(
  data: NflverseData,
  season: number,
  week: number,
  salaryOf?: SalaryLookup,
  model: ModelOptions = DEFAULT_MODEL,
  statusOf?: StatusLookup,
): ProjectionResult {
  const { decay: RECENCY_DECAY, priorSeasonWeight: PRIOR_SEASON_WEIGHT, shrinkGames: SHRINK_GAMES, skipCompletedGames = true } = model;
  const schedule = parseSchedule(data.schedule);
  const isPast = (s: number, w: number) => s < season || (s === season && w < week);

  // ---- Player games (offense) and team defense games -------------------------------------------
  const playerGames: PlayerGame[] = [];
  type TeamAccumulator = {
    team: string;
    opponent: string;
    gameId: string;
    season: number;
    week: number;
    pts: number;
    passYds: number;
    rushYds: number;
    sacks: number;
    takeaways: number;
  };
  const dstByTeamGame = new Map<string, TeamAccumulator>();

  for (const [s, rows] of data.stats) {
    for (const r of rows) {
      if (r.season_type !== "REG") continue;
      const w = n(r.week);
      if (!isPast(s, w)) continue;
      const team = teamAbbr(r.team);
      const opponent = teamAbbr(r.opponent_team);

      // Every player's defensive/special-teams contributions roll up into their team's DST.
      const key = `${r.game_id}|${team}`;
      const dst =
        dstByTeamGame.get(key) ??
        { team, opponent, gameId: r.game_id, season: s, week: w, pts: 0, passYds: 0, rushYds: 0, sacks: 0, takeaways: 0 };
      dst.passYds += n(r.passing_yards);
      dst.rushYds += n(r.rushing_yards);
      dst.sacks += n(r.def_sacks);
      dst.takeaways += n(r.def_interceptions) + n(r.fumble_recovery_opp);
      dst.pts +=
        n(r.def_sacks) +
        n(r.def_interceptions) * 2 +
        n(r.fumble_recovery_opp) * 2 +
        n(r.def_safeties) * 2 +
        (n(r.def_fg_blocks) + n(r.def_punt_blocks) + n(r.def_pat_blocks)) * 2 +
        (n(r.def_tds) + n(r.special_teams_tds)) * 6;
      dstByTeamGame.set(key, dst);

      const position = toOffensePosition(r.position);
      if (!position) continue;
      playerGames.push({
        playerId: r.player_id,
        name: r.player_display_name || r.player_name,
        position,
        team,
        opponent,
        gameId: r.game_id,
        season: s,
        week: w,
        points: dkOffensePoints(r),
        usage: n(r.attempts) + n(r.carries) + n(r.targets),
        attempts: n(r.attempts),
        passYds: n(r.passing_yards),
        passTds: n(r.passing_tds),
        rushYds: n(r.rushing_yards),
        rushAtt: n(r.carries),
        recYds: n(r.receiving_yards),
        targets: n(r.targets),
        receptions: n(r.receptions),
      });
    }
  }

  // Points allowed comes from the final score.
  const scoreByGame = new Map(schedule.map((g) => [g.gameId, g]));
  const teamGames: TeamGame[] = [];
  for (const d of dstByTeamGame.values()) {
    const g = scoreByGame.get(d.gameId);
    if (!g || g.homeScore === null || g.awayScore === null) continue;
    const isHome = g.home === d.team;
    const allowed = isHome ? g.awayScore : g.homeScore;
    teamGames.push({
      team: d.team,
      opponent: d.opponent,
      gameId: d.gameId,
      season: d.season,
      week: d.week,
      dstPoints: d.pts + pointsAllowedScore(allowed),
      pointsFor: isHome ? g.homeScore : g.awayScore,
      pointsAllowed: allowed,
      passYds: d.passYds,
      rushYds: d.rushYds,
      sacks: d.sacks,
      takeaways: d.takeaways,
    });
  }

  // ---- Opponent adjustment: DK points allowed per position, current season ---------------------
  const allowed = new Map<string, Map<string, number>>(); // `${defTeam}|${pos}` -> gameId -> points
  for (const g of playerGames) {
    if (g.season !== season) continue;
    const key = `${g.opponent}|${g.position}`;
    const perGame = allowed.get(key) ?? new Map<string, number>();
    perGame.set(g.gameId, (perGame.get(g.gameId) ?? 0) + g.points);
    allowed.set(key, perGame);
  }
  for (const tg of teamGames) {
    if (tg.season !== season) continue;
    // DST points an offense gives up to opposing defenses.
    const key = `${tg.opponent}|DST_ALLOWED`;
    const perGame = allowed.get(key) ?? new Map<string, number>();
    perGame.set(tg.gameId, tg.dstPoints);
    allowed.set(key, perGame);
  }
  const leagueAvg = new Map<string, number>();
  for (const [key, perGame] of allowed) {
    const pos = key.split("|")[1];
    const list = [...perGame.values()];
    const prev = leagueAvg.get(pos);
    leagueAvg.set(pos, (prev ?? 0) + list.reduce((a, b) => a + b, 0));
    leagueAvg.set(`${pos}#n`, (leagueAvg.get(`${pos}#n`) ?? 0) + list.length);
  }
  function oppFactor(team: string, pos: string) {
    const perGame = allowed.get(`${team}|${pos}`);
    const total = leagueAvg.get(pos);
    const count = leagueAvg.get(`${pos}#n`);
    if (!perGame || !total || !count) return 1;
    const avg = total / count;
    const values = [...perGame.values()];
    const ratio = values.reduce((a, b) => a + b, 0) / values.length / avg;
    return clamp(1 + (ratio - 1) * (values.length / (values.length + OPP_SHRINK_GAMES)), 0.8, 1.25);
  }

  // ---- Vegas implied totals ----------------------------------------------------------------------
  const seasonGames = teamGames.filter((t) => t.season === season);
  const leaguePpg = seasonGames.length ? seasonGames.reduce((s, t) => s + t.pointsFor, 0) / seasonGames.length : 22;
  function teamPpg(team: string) {
    const list = seasonGames.filter((t) => t.team === team);
    return (list.reduce((s, t) => s + t.pointsFor, 0) + 4 * leaguePpg) / (list.length + 4);
  }

  const teams = buildTeamProfiles(seasonGames, allowed);

  const weekGames = schedule.filter((g) => g.season === season && g.week === week);
  const matchupByTeam = new Map<string, { opponent: string; implied: number | null; game: ScheduleGame }>();
  for (const g of weekGames) {
    const hasLine = g.spread !== null && g.total !== null && g.total > 0;
    // nflverse spread_line is positive when the home team is favored.
    const homeImplied = hasLine ? (g.total! + g.spread!) / 2 : null;
    const awayImplied = hasLine ? (g.total! - g.spread!) / 2 : null;
    matchupByTeam.set(g.home, { opponent: g.away, implied: homeImplied, game: g });
    matchupByTeam.set(g.away, { opponent: g.home, implied: awayImplied, game: g });
  }

  // ---- Offensive players ---------------------------------------------------------------------------
  const byPlayer = new Map<string, PlayerGame[]>();
  for (const g of playerGames) {
    const list = byPlayer.get(g.playerId) ?? [];
    list.push(g);
    byPlayer.set(g.playerId, list);
  }

  const injuryStatus = new Map<string, string>();
  for (const r of data.injuries) {
    if (n(r.season) === season && n(r.week) === week && r.report_status) injuryStatus.set(r.gsis_id, r.report_status);
  }

  // Starting QB = most pass attempts in the team's latest game this season.
  const starterQb = new Map<string, { playerId: string; name: string; week: number; attempts: number }>();
  for (const g of playerGames) {
    if (g.season !== season || g.position !== "QB") continue;
    const cur = starterQb.get(g.team);
    if (!cur || g.week > cur.week || (g.week === cur.week && g.attempts > cur.attempts)) {
      starterQb.set(g.team, { playerId: g.playerId, name: g.name, week: g.week, attempts: g.attempts });
    }
  }
  function qbRole(playerId: string, team: string): { factor: number; promoted: boolean } {
    const starter = starterQb.get(team);
    if (!starter || starter.playerId === playerId) return { factor: 1, promoted: false };
    // Backup becomes the starter if the incumbent is ruled out this week.
    const starterOut =
      injuryStatus.get(starter.playerId)?.toLowerCase() === "out" || isInactive(statusOf?.(starter.name, team, "QB"));
    return starterOut ? { factor: 1, promoted: true } : { factor: BACKUP_QB_FACTOR, promoted: false };
  }

  type Candidate = {
    id: string;
    name: string;
    position: Position;
    team: string;
    mean: number;
    sd: number;
    sumW: number;
    games: number;
    current: PlayerGame[];
  };
  const candidates: Candidate[] = [];

  for (const [playerId, games] of byPlayer) {
    games.sort((a, b) => b.season - a.season || b.week - a.week);
    const current = games.filter((g) => g.season === season);
    if (current.length === 0) continue; // Not active this season.
    const latest = current[0];
    const matchup = matchupByTeam.get(latest.team);
    if (!matchup || (skipCompletedGames && matchup.game.homeScore !== null)) continue; // Bye, or this week's game is already final.

    // Ignore games a regular left early (injury), which would understate their role.
    const usages = games.map((g) => g.usage).sort((a, b) => a - b);
    const medianUsage = usages[Math.floor(usages.length / 2)];
    const kept = games.filter((g) => !(medianUsage >= 10 && g.usage < medianUsage * 0.3));

    const values = kept.map((g, i) => ({
      value: g.points,
      weight: RECENCY_DECAY ** i * (g.season === season ? 1 : PRIOR_SEASON_WEIGHT),
    }));
    const { mean, sd, sumW } = weightedStats(values);
    if (mean <= 0) continue;
    candidates.push({
      id: playerId,
      name: latest.name,
      position: latest.position,
      team: latest.team,
      mean,
      sd,
      sumW,
      games: kept.length,
      current: kept.filter((g) => g.season === season),
    });
  }

  // Salary-implied prior per position, fitted on players with a decent sample.
  const priors = new Map<Position, ((salary: number) => number) | null>();
  for (const pos of OFFENSE_POSITIONS) {
    const samples = candidates
      .filter((c) => c.position === pos && c.sumW >= 3)
      .map((c) => ({ salary: salaryOf?.(c.name, c.team, pos) ?? 0, points: c.mean }))
      .filter((s) => s.salary > 0);
    priors.set(pos, fitSalaryPrior(samples));
  }
  const fallbackPrior = (pos: Position) => {
    const list = candidates.filter((c) => c.position === pos && c.sumW >= 3).map((c) => c.mean).sort((a, b) => a - b);
    return list.length ? list[Math.floor(list.length * 0.35)] : 5;
  };

  const players: PoolPlayer[] = [];
  for (const c of candidates) {
    const m = matchupByTeam.get(c.team)!;
    const salary = salaryOf?.(c.name, c.team, c.position) ?? 0;
    const priorFn = priors.get(c.position);
    const prior = salary > 0 && priorFn ? priorFn(salary) : Math.min(c.mean, fallbackPrior(c.position));
    const role = c.position === "QB" ? qbRole(c.id, c.team) : { factor: 1, promoted: false };
    const shrink = role.promoted && salary > 0 && priorFn ? PROMOTED_QB_SHRINK : SHRINK_GAMES;
    const base = (c.sumW * c.mean + shrink * prior) / (c.sumW + shrink);

    const opp = oppFactor(m.opponent, c.position);
    const vegas = m.implied !== null ? clamp(m.implied / teamPpg(c.team), 0.8, 1.25) : null;
    const adj = (vegas !== null ? Math.sqrt(opp * vegas) : opp) * role.factor;
    const projected = round1(base * adj);
    if (projected < 0.5) continue;

    const cvSd = POSITION_CV[c.position] * projected;
    const sd = Math.sqrt((c.sumW * (c.sd * adj) ** 2 + SHRINK_GAMES * cvSd ** 2) / (c.sumW + SHRINK_GAMES));
    const status = injuryStatus.get(c.id);
    const avg = (pick: (g: PlayerGame) => number) => round1(perGame(c.current, pick));
    const research: PlayerResearch = {
      games: c.current.length,
      seasonAvg: avg((g) => g.points),
      last3Avg: round1(perGame(c.current.slice(0, 3), (g) => g.points)),
      weightedAvg: round1(c.mean),
      salaryPrior: salary > 0 && priorFn ? round1(prior) : null,
      baseProjection: round1(base),
      matchupFactor: round2(opp),
      vegasFactor: vegas === null ? null : round2(vegas),
      impliedTotal: m.implied === null ? null : round1(m.implied),
      roleFactor: role.factor,
      ...(c.position === "QB"
        ? { passYds: avg((g) => g.passYds), passTds: round2(perGame(c.current, (g) => g.passTds)), passAtt: avg((g) => g.attempts) }
        : {}),
      rushYds: avg((g) => g.rushYds),
      rushAtt: avg((g) => g.rushAtt),
      ...(c.position !== "QB"
        ? { recYds: avg((g) => g.recYds), targets: avg((g) => g.targets), receptions: avg((g) => g.receptions) }
        : {}),
    };
    players.push({
      research,
      id: `nfl-${c.id}`,
      name: c.name,
      position: c.position,
      team: c.team,
      opponent: m.opponent,
      gameKey: m.game.gameId,
      salary,
      projected,
      floor: round1(Math.max(0, projected - 0.84 * sd)),
      ceiling: round1(projected + 1.28 * sd),
      rangeEstimated: false,
      value: salary > 0 ? round2(projected / (salary / 1000)) : 0,
      injury: status ? (status.toLowerCase() === "out" ? "OUT" : status) : null,
    });
  }

  // ---- Team defenses -------------------------------------------------------------------------------
  const leagueDst = seasonGames.length ? seasonGames.reduce((s, t) => s + t.dstPoints, 0) / seasonGames.length : 6;
  for (const [team, m] of matchupByTeam) {
    if (skipCompletedGames && m.game.homeScore !== null) continue; // Game already played.
    const games = teamGames.filter((t) => t.team === team).sort((a, b) => b.season - a.season || b.week - a.week);
    const { mean, sd, sumW } = weightedStats(
      games.map((g, i) => ({ value: g.dstPoints, weight: RECENCY_DECAY ** i * (g.season === season ? 1 : PRIOR_SEASON_WEIGHT) })),
    );
    const base = (sumW * mean + DST_SHRINK_GAMES * leagueDst) / (sumW + DST_SHRINK_GAMES);
    const opp = oppFactor(m.opponent, "DST_ALLOWED");
    const oppImplied = matchupByTeam.get(m.opponent)?.implied ?? null;
    const vegas = oppImplied !== null ? clamp(leaguePpg / oppImplied, 0.7, 1.35) : null;
    const projected = round1(Math.max(0.5, base * (vegas !== null ? Math.sqrt(opp * vegas) : opp)));
    const spread = Math.sqrt((sumW * sd ** 2 + DST_SHRINK_GAMES * (POSITION_CV.DST * projected) ** 2) / (sumW + DST_SHRINK_GAMES));
    const salary = salaryOf?.(`${team} DST`, team, "DST") ?? 0;
    const current = games.filter((g) => g.season === season);
    players.push({
      research: {
        games: current.length,
        seasonAvg: round1(perGame(current, (g) => g.dstPoints)),
        last3Avg: round1(perGame(current.slice(0, 3), (g) => g.dstPoints)),
        weightedAvg: round1(mean),
        salaryPrior: null,
        baseProjection: round1(base),
        matchupFactor: round2(opp),
        vegasFactor: vegas === null ? null : round2(vegas),
        impliedTotal: oppImplied === null ? null : round1(oppImplied),
        roleFactor: 1,
        sacks: round1(perGame(current, (g) => g.sacks)),
        takeaways: round1(perGame(current, (g) => g.takeaways)),
        pointsAllowed: round1(perGame(current, (g) => g.pointsAllowed)),
      },
      id: `nfl-dst-${team}`,
      name: `${team} DST`,
      position: "DST",
      team,
      opponent: m.opponent,
      gameKey: m.game.gameId,
      salary,
      projected,
      floor: round1(Math.max(0, projected - 0.84 * spread)),
      ceiling: round1(projected + 1.28 * spread),
      rangeEstimated: false,
      value: salary > 0 ? round2(projected / (salary / 1000)) : 0,
      injury: null,
    });
  }

  const games: Matchup[] = weekGames
    .map((g) => ({
      id: g.gameId,
      awayTeam: g.away,
      homeTeam: g.home,
      kickoff: g.kickoff,
      // Matchup.pointSpread is home-relative (negative = home favored), like SportsDataIO.
      pointSpread: g.spread === null ? null : -g.spread,
      overUnder: g.total,
      channel: null,
      status: g.homeScore !== null ? "Final" : "Scheduled",
      awayMoneyline: g.awayMoneyline,
      homeMoneyline: g.homeMoneyline,
      awayScore: g.awayScore,
      homeScore: g.homeScore,
      stadium: g.stadium,
      roof: g.roof,
    }))
    .sort((a, b) => (a.kickoff ?? "").localeCompare(b.kickoff ?? ""));

  const throughWeek = Math.max(0, ...playerGames.filter((g) => g.season === season).map((g) => g.week));
  const venues: Venue[] = weekGames.map((g) => ({
    gameId: g.gameId,
    stadiumId: g.stadiumId,
    homeTeam: g.home,
    kickoff: g.kickoff,
    roof: g.roof,
  }));
  return { players, games, teams, venues, throughWeek, hasLines: weekGames.some((g) => g.total !== null) };
}

/** Actual DK points per player for a completed week (for backtesting). */
export function actualWeekPoints(data: NflverseData, season: number, week: number) {
  const out = new Map<string, { name: string; position: Position; points: number; usage: number }>();
  for (const r of data.stats.get(season) ?? []) {
    if (n(r.week) !== week || r.season_type !== "REG") continue;
    const position = toOffensePosition(r.position);
    if (!position) continue;
    out.set(`nfl-${r.player_id}`, {
      name: r.player_display_name,
      position,
      points: dkOffensePoints(r),
      usage: n(r.attempts) + n(r.carries) + n(r.targets),
    });
  }
  return out;
}
