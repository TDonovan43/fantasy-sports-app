import prisma from "@/lib/prisma";

export type NflPlayerRow = {
  name: string;
  position: string;
  team: string;
  salary: string;
  projected: number;
  floor: number;
  ceiling: number;
  value: number;
  trend: "up" | "flat";
};

export const fallbackPlayers: NflPlayerRow[] = [
  { name: "Jalen Hurts", position: "QB", team: "PHI", salary: "$8,600", projected: 24.8, floor: 17.4, ceiling: 31.2, value: 2.88, trend: "up" },
  { name: "Christian McCaffrey", position: "RB", team: "SF", salary: "$9,300", projected: 22.6, floor: 15.7, ceiling: 29.3, value: 2.43, trend: "up" },
  { name: "Amon-Ra St. Brown", position: "WR", team: "DET", salary: "$8,200", projected: 18.4, floor: 13.2, ceiling: 23.7, value: 2.24, trend: "flat" },
  { name: "Sam LaPorta", position: "TE", team: "DET", salary: "$6,100", projected: 14.9, floor: 10.6, ceiling: 19.8, value: 2.44, trend: "up" },
  { name: "Puka Nacua", position: "WR", team: "LAR", salary: "$7,600", projected: 17.1, floor: 11.4, ceiling: 21.9, value: 2.25, trend: "up" },
  { name: "Breece Hall", position: "RB", team: "NYJ", salary: "$7,000", projected: 15.8, floor: 10.9, ceiling: 20.4, value: 2.26, trend: "flat" },
  { name: "George Kittle", position: "TE", team: "SF", salary: "$5,800", projected: 12.7, floor: 8.9, ceiling: 16.4, value: 2.19, trend: "up" },
  { name: "C.J. Stroud", position: "QB", team: "HOU", salary: "$6,800", projected: 19.9, floor: 14.1, ceiling: 26.4, value: 2.93, trend: "up" },
];

function normalizePlayerRow(raw: Record<string, any>, index: number): NflPlayerRow | null {
  const name = String(
    raw.name ?? raw.player_name ?? raw.display_name ?? raw.playerName ?? `Player ${index + 1}`,
  );

  if (!name || name === "undefined") {
    return null;
  }

  const position = String(raw.position ?? raw.pos ?? "").toUpperCase();
  const team = String(raw.team ?? raw.team_abbr ?? raw.teamAbbr ?? raw.franchise ?? "N/A");
  const salary = Number(raw.salary ?? raw.dk_salary ?? raw.draftkings_salary ?? raw.salary_usd ?? raw.salaryUSD ?? 0);
  const projected = Number(raw.projected ?? raw.projected_points ?? raw.projectedFantasyPoints ?? raw.fantasy_points ?? raw.fppg ?? 0);
  const floor = Number(raw.floor ?? raw.low ?? raw.min_projection ?? 0);
  const ceiling = Number(raw.ceiling ?? raw.high ?? raw.max_projection ?? 0);
  const value = Number(raw.value ?? (salary > 0 && projected ? projected / (salary / 1000) : 0));

  return {
    name,
    position: position || "N/A",
    team,
    salary: salary > 0 ? `$${salary.toLocaleString()}` : "N/A",
    projected: Number.isFinite(projected) ? projected : 0,
    floor: Number.isFinite(floor) ? floor : 0,
    ceiling: Number.isFinite(ceiling) ? ceiling : 0,
    value: Number.isFinite(value) ? Number(value.toFixed(2)) : 0,
    trend: index % 2 === 0 ? "up" : "flat",
  };
}

export async function getSportsDataIOSeasonWeek(): Promise<{ season: string; week: string }> {
  const envSeason = process.env.SPORTS_DATA_IO_SEASON;
  const envWeek = process.env.SPORTS_DATA_IO_WEEK;
  const apiKey = process.env.SPORTS_DATA_IO_API_KEY ?? process.env.SPORTS_DATA_IO_KEY;

  if (envSeason && envWeek) {
    return { season: envSeason, week: envWeek };
  }

  if (!apiKey) {
    return {
      season: envSeason ?? "2025",
      week: envWeek ?? "1",
    };
  }

  try {
    const [seasonRes, weekRes] = await Promise.all([
      fetch("https://api.sportsdata.io/v3/nfl/scores/json/CurrentSeason", {
        cache: "no-store",
        headers: { "Ocp-Apim-Subscription-Key": apiKey },
      }),
      fetch("https://api.sportsdata.io/v3/nfl/scores/json/CurrentWeek", {
        cache: "no-store",
        headers: { "Ocp-Apim-Subscription-Key": apiKey },
      }),
    ]);

    const season = seasonRes.ok ? Number(await seasonRes.text()) : Number(envSeason ?? 2025);
    const week = weekRes.ok ? Number(await weekRes.text()) : Number(envWeek ?? 1);

    return {
      season: String(Number.isFinite(season) ? season : envSeason ?? 2025),
      week: String(Number.isFinite(week) ? week : envWeek ?? 1),
    };
  } catch {
    return {
      season: envSeason ?? "2025",
      week: envWeek ?? "1",
    };
  }
}

async function fetchSportsDataIORows(): Promise<NflPlayerRow[]> {
  const apiKey = process.env.SPORTS_DATA_IO_API_KEY ?? process.env.SPORTS_DATA_IO_KEY;
  if (!apiKey) {
    return [];
  }

  const { season, week } = await getSportsDataIOSeasonWeek();

  try {
    const response = await fetch(
      `https://api.sportsdata.io/v3/nfl/projections/json/PlayerGameProjectionStatsByWeek/${season}/${week}`,
      {
        cache: "no-store",
        headers: {
          "Ocp-Apim-Subscription-Key": apiKey,
        },
      },
    );

    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as Array<Record<string, any>>;
    const rows = payload
      .map((item, index) => {
        const name = String(item.Name ?? item.name ?? item.PlayerName ?? item.playerName ?? item.Player ?? `Player ${index + 1}`);
        const position = String(item.Position ?? item.position ?? item.Pos ?? item.pos ?? "").toUpperCase();
        const team = String(item.Team ?? item.team ?? item.TeamAbbreviation ?? item.teamAbbr ?? item.franchise ?? "N/A");
        const salary = Number(item.DfsSalary ?? item.DFSSalary ?? item.Salary ?? item.salary ?? item.DraftKingsSalary ?? item.draftkings_salary ?? 0);
        const projected = Number(item.FantasyPoints ?? item.fantasyPoints ?? item.ProjectedFantasyPoints ?? item.projectedFantasyPoints ?? item.ProjectedPoints ?? item.projected_points ?? 0);
        const floor = Number(item.Floor ?? item.floor ?? item.ProjectedFloor ?? item.projectedFloor ?? 0);
        const ceiling = Number(item.Ceiling ?? item.ceiling ?? item.ProjectedCeiling ?? item.projectedCeiling ?? 0);

        if (!name || name === "undefined") {
          return null;
        }

        const value = salary > 0 && projected ? projected / (salary / 1000) : 0;

        return {
          name,
          position: position || "N/A",
          team,
          salary: salary > 0 ? `$${salary.toLocaleString()}` : "N/A",
          projected: Number.isFinite(projected) ? projected : 0,
          floor: Number.isFinite(floor) ? floor : 0,
          ceiling: Number.isFinite(ceiling) ? ceiling : 0,
          value: Number.isFinite(value) ? Number(value.toFixed(2)) : 0,
          trend: index % 2 === 0 ? "up" : "flat",
        } satisfies NflPlayerRow;
      })
      .filter((item): item is NflPlayerRow => item !== null)
      .slice(0, 8);

    return rows.length > 0 ? rows : [];
  } catch {
    return [];
  }
}

async function fetchProviderRows(): Promise<NflPlayerRow[]> {
  const sportsDataRows = await fetchSportsDataIORows();
  if (sportsDataRows.length > 0) {
    return sportsDataRows;
  }

  const feedUrl = process.env.DFS_FEED_URL ?? process.env.DFS_DATA_FEED_URL ?? process.env.DRAFTKINGS_FEED_URL;
  if (!feedUrl) {
    return [];
  }

  try {
    const response = await fetch(feedUrl, { cache: "no-store" });
    if (!response.ok) {
      return [];
    }

    const json = await response.json();
    const payload = Array.isArray(json) ? json : Array.isArray(json?.players) ? json.players : Array.isArray(json?.data) ? json.data : [];

    const rows = (payload as Array<Record<string, any>>)
      .map((item: Record<string, any>, index: number) => normalizePlayerRow(item, index))
      .filter((item): item is NflPlayerRow => item !== null);

    return rows.slice(0, 8);
  } catch {
    return [];
  }
}

export async function getDatabaseResearchPlayers(): Promise<NflPlayerRow[]> {
  if (!process.env.DATABASE_URL) {
    return [];
  }

  try {
    const players = await prisma.player.findMany({
      take: 8,
      include: {
        salaries: { orderBy: { collectedAt: "desc" }, take: 1 },
        projections: { orderBy: { collectedAt: "desc" }, take: 1 },
      },
    });

    return players.map((player: (typeof players)[number]) => {
      const salary = player.salaries[0]?.salary ?? 0;
      const projection = player.projections[0]?.projectedFantasyPoints ?? 0;
      const value = salary > 0 ? projection / (salary / 1000) : 0;

      return {
        name: player.name,
        position: player.position,
        team: player.team ?? "N/A",
        salary: salary > 0 ? `$${salary.toLocaleString()}` : "N/A",
        projected: projection || 0,
        floor: player.projections[0]?.floor ?? 0,
        ceiling: player.projections[0]?.ceiling ?? 0,
        value: Number(value.toFixed(2)),
        trend: "up",
      };
    });
  } catch {
    return [];
  }
}

export async function getResearchPlayers(): Promise<NflPlayerRow[]> {
  const dbPlayers = await getDatabaseResearchPlayers();
  if (dbPlayers.length > 0) {
    return dbPlayers;
  }

  return getPlayerData();
}

export async function getLiveWeekContext() {
  const { season, week } = await getSportsDataIOSeasonWeek();
  return {
    season,
    week,
    source: "SportsDataIO",
    label: `Week ${week} • ${season}`,
  };
}

export async function getPlayerData(): Promise<NflPlayerRow[]> {
  const providerRows = await fetchProviderRows();
  if (providerRows.length > 0) {
    return providerRows;
  }

  try {
    const response = await fetch("https://api.nflverse.com/api/v1/player?season=2024", {
      cache: "no-store",
    });

    if (!response.ok) {
      return fallbackPlayers;
    }

    const json = await response.json();
    const rawPlayers = Array.isArray(json?.data) ? json.data : [];

    const mapped = rawPlayers
      .filter((player: any) => {
        const position = String(player.position ?? "").toUpperCase();
        return ["QB", "RB", "WR", "TE"].includes(position);
      })
      .slice(0, 8)
      .map((player: any, index: number) => {
        const name = String(player.display_name ?? player.name ?? player.gsis_name ?? `Player ${index + 1}`);
        const position = String(player.position ?? "").toUpperCase();
        const team = String(player.team ?? player.team_abbr ?? player.franchise ?? "N/A");
        const projected = Number(player.fantasy_points ?? player.ppr_fantasy_points ?? 0);
        const salaryRaw = Number(player.draftkings_salary ?? player.salary ?? 0);

        return {
          name,
          position,
          team,
          salary: salaryRaw > 0 ? `$${salaryRaw.toLocaleString()}` : "N/A",
          projected: Number.isFinite(projected) ? projected : 0,
          floor: Number(player.floor ?? player.low ?? 0),
          ceiling: Number(player.ceiling ?? player.high ?? 0),
          value: Number(player.value ?? (projected && salaryRaw ? projected / (salaryRaw / 1000) : 0)),
          trend: index % 2 === 0 ? "up" : "flat",
        };
      });

    return mapped.length > 0 ? mapped : fallbackPlayers;
  } catch {
    return fallbackPlayers;
  }
}
