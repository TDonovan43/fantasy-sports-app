import type { Matchup, SlateData } from "@/lib/types";

/**
 * DraftKings Sunday Classic slates, by kickoff (Eastern):
 *   early = Sunday games kicking off before 4 PM (the 1:00 PM window)
 *   late  = Sunday 4:00–7:59 PM kickoffs (4:05 / 4:25 PM window; DK calls it "Afternoon")
 *   main  = early + late
 * Thursday, Monday, Sunday night and international morning games are only in "all".
 */
export type SlateFilter = "all" | "main" | "early" | "late";

export const SLATE_OPTIONS: { id: SlateFilter; label: string; hint: string }[] = [
  { id: "all", label: "All games", hint: "Every game this week" },
  { id: "main", label: "Main", hint: "Sunday 1:00 PM + 4:05/4:25 PM ET" },
  { id: "early", label: "Early", hint: "Sunday 1:00 PM ET" },
  { id: "late", label: "Late", hint: "Sunday 4:05/4:25 PM ET (DK \"Afternoon\")" },
];

/** Kickoffs are Eastern wall-clock strings, e.g. 2026-11-08T13:00:00. */
function sundayWindow(kickoff: string | null | undefined): "early" | "late" | null {
  if (!kickoff) return null;
  const date = new Date(`${kickoff.slice(0, 19)}Z`);
  if (Number.isNaN(date.getTime()) || date.getUTCDay() !== 0) return null;
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  if (minutes >= 12 * 60 && minutes < 16 * 60) return "early";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "late";
  return null;
}

export function gameInSlate(game: Matchup, filter: SlateFilter) {
  if (filter === "all") return true;
  const window = sundayWindow(game.kickoff);
  return filter === "main" ? window !== null : window === filter;
}

/** Restricts a slate's games and players (by team) to one DraftKings slate. */
export function filterSlate(slate: SlateData, filter: SlateFilter): SlateData {
  if (filter === "all") return slate;
  const games = slate.games.filter((g) => gameInSlate(g, filter));
  const teams = new Set(games.flatMap((g) => [g.awayTeam, g.homeTeam]));
  return { ...slate, games, players: slate.players.filter((p) => teams.has(p.team)) };
}
