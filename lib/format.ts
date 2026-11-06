import type { Matchup } from "@/lib/types";

export const money = (n: number) => (n > 0 ? `$${n.toLocaleString("en-US")}` : "—");

/** Provider times are Eastern wall-clock; format the digits without shifting time zones. */
export function formatKickoff(value: string | null | undefined) {
  if (!value) return "TBD";
  const date = new Date(`${value.slice(0, 19)}Z`);
  if (Number.isNaN(date.getTime())) return "TBD";
  const day = date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  return `${day} ${time} ET`;
}

/** "SF -10 · O/U 51.5" (pointSpread is home-relative: negative = home favored). */
export function formatLine(game: Matchup) {
  const parts: string[] = [];
  if (game.pointSpread !== null && game.pointSpread !== 0) {
    const fav = game.pointSpread < 0 ? game.homeTeam : game.awayTeam;
    parts.push(`${fav} -${Math.abs(game.pointSpread)}`);
  }
  if (game.overUnder !== null) parts.push(`O/U ${game.overUnder}`);
  return parts.join(" · ");
}

/** Implied team totals from the spread and over/under. */
export function impliedTotals(game: Matchup): { away: number; home: number } | null {
  if (game.overUnder === null || game.pointSpread === null) return null;
  return {
    home: Math.round((game.overUnder / 2 - game.pointSpread / 2) * 10) / 10,
    away: Math.round((game.overUnder / 2 + game.pointSpread / 2) * 10) / 10,
  };
}

export const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

/** 1.08 -> "+8%", 0.92 -> "−8%". */
export function pct(factor: number | null | undefined) {
  if (factor === null || factor === undefined) return "—";
  const p = Math.round((factor - 1) * 100);
  return p === 0 ? "0%" : p > 0 ? `+${p}%` : `−${Math.abs(p)}%`;
}

export function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
