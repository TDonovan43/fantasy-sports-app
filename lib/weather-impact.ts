import type { Matchup, PoolPlayer, Position, SlateData } from "@/lib/types";

/**
 * Estimated weather effect on DraftKings scoring, shown for awareness only (projections don't use it).
 *
 * From a study of 12,270 player-games in 2023–2026 (actual kickoff weather vs each player's season
 * average, beyond what Vegas totals already priced in), roughly halved for small samples and forecast
 * uncertainty:
 *   wind 15+ mph: QB −13% measured → −8%; WR −5% → −4%
 *   wind 10–14 mph: QB −3%, WR −4% (not certain) → −2% each
 *   32°F or colder: RB +13% (31 games) → +5%
 * TEs and DSTs showed no reliable effect.
 */

export type WeatherImpact = {
  /** Estimated change as a fraction (−0.08 = −8%), 0 when conditions don't matter for the position. */
  pct: number;
  /** Short cell text, e.g. "−8% · wind 17 mph". */
  label: string;
  /** Hover text with the forecast and the basis. */
  detail: string;
};

const WIND_STRONG = 15;
const WIND_MODERATE = 10;
const COLD_F = 32;

function effectFor(position: Position, wind: number | null, temp: number | null) {
  let pct = 0;
  const reasons: string[] = [];
  if (wind !== null && wind >= WIND_STRONG) {
    const e = position === "QB" ? -0.08 : position === "WR" ? -0.04 : 0;
    if (e) reasons.push(`wind ${wind} mph`);
    pct += e;
  } else if (wind !== null && wind >= WIND_MODERATE) {
    const e = position === "QB" || position === "WR" ? -0.02 : 0;
    if (e) reasons.push(`wind ${wind} mph`);
    pct += e;
  }
  if (temp !== null && temp <= COLD_F && position === "RB") {
    pct += 0.05;
    reasons.push(`${temp}°F`);
  }
  return { pct, reasons };
}

export function weatherImpact(position: Position, game: Matchup | undefined): WeatherImpact | undefined {
  if (!game || game.status === "Final") return undefined;
  if (game.roof === "dome") return { pct: 0, label: "Indoors", detail: "Dome: weather isn't a factor." };
  const w = game.weather;
  if (!w) return undefined;
  const { pct, reasons } = effectFor(position, w.windMph, w.tempF);
  const conditions = [
    w.tempF !== null ? `${w.tempF}°F` : null,
    w.windMph !== null ? `wind ${w.windMph} mph` : null,
    w.precipChance !== null ? `${w.precipChance}% precip` : null,
    w.conditions,
  ]
    .filter(Boolean)
    .join(", ");
  const roofNote = game.roof === "retractable" ? " Retractable roof: may be closed." : "";
  const basis = "Estimate from 2023–26 results, not applied to projections.";
  if (pct === 0) {
    const calm = (w.windMph ?? 0) < WIND_MODERATE && (w.tempF ?? 60) > COLD_F;
    return {
      pct: 0,
      label: calm ? "—" : "no clear effect",
      detail: `Kickoff forecast: ${conditions}.${roofNote} No reliable weather effect for ${position}s in these conditions. ${basis}`,
    };
  }
  const sign = pct > 0 ? "+" : "−";
  return {
    pct,
    label: `${sign}${Math.round(Math.abs(pct) * 100)}% · ${reasons.join(", ")}`,
    detail: `Kickoff forecast: ${conditions}.${roofNote} Estimated ${sign}${Math.round(Math.abs(pct) * 100)}% for ${position}s. ${basis}`,
  };
}

/** Attaches the weather estimate to each player (projections unchanged). */
export function withWeatherImpact(slate: SlateData): SlateData {
  const gameOf = new Map<string, Matchup>();
  for (const g of slate.games) {
    gameOf.set(g.awayTeam, g);
    gameOf.set(g.homeTeam, g);
  }
  const tag = (p: PoolPlayer): PoolPlayer => {
    const impact = weatherImpact(p.position, gameOf.get(p.team));
    return impact ? { ...p, weatherImpact: impact } : p;
  };
  return { ...slate, players: slate.players.map(tag), unprojected: slate.unprojected?.map(tag) };
}
