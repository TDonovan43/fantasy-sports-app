import { estimateRange, round1, round2, toPosition } from "@/lib/model-utils";
import type { Matchup, PoolPlayer } from "@/lib/types";

const BASE_URL = "https://api.sportsdata.io/v3/nfl";
const CACHE_TTL_MS = 5 * 60 * 1000;

type Json = Record<string, unknown>;

// The weekly projection payload is ~3MB, above Next's 2MB fetch-cache limit,
// so cache parsed responses in memory per server instance instead.
const memo = new Map<string, { expires: number; value: unknown }>();

export function getSportsDataIOKey(): string | undefined {
  return process.env.SPORTS_DATA_IO_API_KEY ?? process.env.SPORTS_DATA_IO_KEY;
}

async function sdioGet<T>(path: string): Promise<T | null> {
  const apiKey = getSportsDataIOKey();
  if (!apiKey) return null;

  const cached = memo.get(path);
  if (cached && cached.expires > Date.now()) return cached.value as T;

  try {
    const res = await fetch(`${BASE_URL}/${path}`, {
      cache: "no-store",
      headers: { "Ocp-Apim-Subscription-Key": apiKey },
    });
    if (!res.ok) return null;
    const value = (await res.json()) as T;
    memo.set(path, { expires: Date.now() + CACHE_TTL_MS, value });
    return value;
  } catch {
    return null;
  }
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export async function getSeasonWeek(): Promise<{ season: number; week: number }> {
  const envSeason = Number(process.env.SPORTS_DATA_IO_SEASON);
  const envWeek = Number(process.env.SPORTS_DATA_IO_WEEK);
  if (envSeason > 0 && envWeek > 0) return { season: envSeason, week: envWeek };

  const [season, week] = await Promise.all([
    sdioGet<number>("scores/json/CurrentSeason"),
    sdioGet<number>("scores/json/CurrentWeek"),
  ]);

  return {
    season: num(season) || envSeason || new Date().getFullYear(),
    week: num(week) || envWeek || 1,
  };
}

export type SdioWeek = {
  players: PoolPlayer[];
  scrambled: boolean;
};

export async function getWeekProjections(season: number, week: number): Promise<SdioWeek | null> {
  const rows = await sdioGet<Json[]>(`projections/json/PlayerGameProjectionStatsByWeek/${season}/${week}`);
  if (!Array.isArray(rows) || rows.length === 0) return null;

  let scrambled = false;
  const players: PoolPlayer[] = [];

  for (const row of rows) {
    const position = toPosition(row.Position);
    const name = str(row.Name);
    if (!position || !name) continue;
    if (row.InjuryStatus === "Scrambled") scrambled = true;
    if (row.DeclaredInactive === true) continue;

    const salary = num(row.DraftKingsSalary);
    const projected = round1(num(row.FantasyPointsDraftKings) || num(row.FantasyPointsPPR));
    if (projected <= 0) continue;

    const injury = str(row.InjuryStatus);
    players.push({
      id: `sdio-${num(row.PlayerID)}`,
      name,
      position,
      team: str(row.Team) ?? "FA",
      opponent: str(row.Opponent),
      gameKey: str(row.GameKey),
      salary,
      projected,
      ...estimateRange(position, projected),
      rangeEstimated: true,
      value: salary > 0 ? round2(projected / (salary / 1000)) : 0,
      injury: injury && injury !== "Scrambled" ? injury : null,
    });
  }

  return { players, scrambled };
}

export async function getWeekGames(season: number, week: number): Promise<Matchup[]> {
  const rows = await sdioGet<Json[]>(`scores/json/ScoresByWeek/${season}/${week}`);
  if (!Array.isArray(rows)) return [];

  return rows
    .filter((g) => g.Canceled !== true && str(g.AwayTeam) && str(g.HomeTeam) && g.AwayTeam !== "BYE")
    .map((g) => ({
      id: String(g.GameKey ?? g.ScoreID ?? `${g.AwayTeam}-${g.HomeTeam}`),
      awayTeam: String(g.AwayTeam),
      homeTeam: String(g.HomeTeam),
      kickoff: str(g.DateTime) ?? str(g.Date),
      pointSpread: numOrNull(g.PointSpread),
      overUnder: numOrNull(g.OverUnder),
      channel: str(g.Channel),
      status: str(g.Status),
    }))
    .sort((a, b) => (a.kickoff ?? "").localeCompare(b.kickoff ?? ""));
}
