import { easternToUtcMs } from "@/lib/time";
import type { GameWeather } from "@/lib/types";

/**
 * Kickoff-hour forecasts from Open-Meteo (https://open-meteo.com; free, no API key, non-commercial use).
 * Stadium coordinates and roof types keyed by nflverse `stadium_id`.
 */

type Stadium = { lat: number; lon: number; roof: "outdoors" | "dome" | "retractable" };

const STADIUMS: Record<string, Stadium> = {
  ATL97: { lat: 33.7554, lon: -84.4008, roof: "retractable" },
  BAL00: { lat: 39.278, lon: -76.6227, roof: "outdoors" },
  BOS00: { lat: 42.0909, lon: -71.2643, roof: "outdoors" },
  BUF00: { lat: 42.7738, lon: -78.787, roof: "outdoors" },
  CAR00: { lat: 35.2258, lon: -80.8528, roof: "outdoors" },
  CHI98: { lat: 41.8623, lon: -87.6167, roof: "outdoors" },
  CIN00: { lat: 39.0955, lon: -84.5161, roof: "outdoors" },
  CLE00: { lat: 41.5061, lon: -81.6995, roof: "outdoors" },
  DAL00: { lat: 32.7473, lon: -97.0945, roof: "retractable" },
  DEN00: { lat: 39.7439, lon: -105.0201, roof: "outdoors" },
  DET00: { lat: 42.34, lon: -83.0456, roof: "dome" },
  GNB00: { lat: 44.5013, lon: -88.0622, roof: "outdoors" },
  HOU00: { lat: 29.6847, lon: -95.4107, roof: "retractable" },
  IND00: { lat: 39.7601, lon: -86.1639, roof: "retractable" },
  JAX00: { lat: 30.3239, lon: -81.6373, roof: "outdoors" },
  KAN00: { lat: 39.0489, lon: -94.4839, roof: "outdoors" },
  LAX01: { lat: 33.9535, lon: -118.3392, roof: "dome" },
  MIA00: { lat: 25.958, lon: -80.2389, roof: "outdoors" },
  MIN01: { lat: 44.9737, lon: -93.2581, roof: "dome" },
  NAS00: { lat: 36.1665, lon: -86.7713, roof: "outdoors" },
  NOR00: { lat: 29.9511, lon: -90.0812, roof: "dome" },
  NYC01: { lat: 40.8135, lon: -74.0745, roof: "outdoors" },
  PHI00: { lat: 39.9008, lon: -75.1675, roof: "outdoors" },
  PHO00: { lat: 33.5276, lon: -112.2626, roof: "retractable" },
  PIT00: { lat: 40.4468, lon: -80.0158, roof: "outdoors" },
  SEA00: { lat: 47.5952, lon: -122.3316, roof: "outdoors" },
  SFO01: { lat: 37.403, lon: -121.97, roof: "outdoors" },
  TAM00: { lat: 27.9759, lon: -82.5033, roof: "outdoors" },
  VEG00: { lat: 36.0909, lon: -115.1833, roof: "dome" },
  WAS00: { lat: 38.9077, lon: -76.8645, roof: "outdoors" },
  // International / neutral sites
  LON00: { lat: 51.556, lon: -0.2796, roof: "outdoors" },
  LON02: { lat: 51.6043, lon: -0.0664, roof: "outdoors" },
  MAD01: { lat: 40.4531, lon: -3.6883, roof: "retractable" },
  MUN01: { lat: 48.2188, lon: 11.6247, roof: "outdoors" },
  PAR00: { lat: 48.9245, lon: 2.3602, roof: "outdoors" },
  MEX00: { lat: 19.3029, lon: -99.1505, roof: "outdoors" },
  RIO00: { lat: -22.9121, lon: -43.2302, roof: "outdoors" },
  MEL00: { lat: -37.82, lon: 144.9834, roof: "outdoors" },
};

const HOME_STADIUM: Record<string, string> = {
  ARI: "PHO00", ATL: "ATL97", BAL: "BAL00", BUF: "BUF00", CAR: "CAR00", CHI: "CHI98", CIN: "CIN00", CLE: "CLE00",
  DAL: "DAL00", DEN: "DEN00", DET: "DET00", GB: "GNB00", HOU: "HOU00", IND: "IND00", JAX: "JAX00", KC: "KAN00",
  LAC: "LAX01", LAR: "LAX01", LV: "VEG00", MIA: "MIA00", MIN: "MIN01", NE: "BOS00", NO: "NOR00", NYG: "NYC01",
  NYJ: "NYC01", PHI: "PHI00", PIT: "PIT00", SEA: "SEA00", SF: "SFO01", TB: "TAM00", TEN: "NAS00", WAS: "WAS00",
};

/** WMO weather codes -> short description. */
function describe(code: number | null): string | null {
  if (code === null) return null;
  if (code === 0) return "Clear";
  if (code <= 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code <= 48) return "Fog";
  if (code <= 57) return "Drizzle";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Rain showers";
  if (code <= 86) return "Snow showers";
  return "Thunderstorms";
}

export type WeatherRequest = { gameId: string; stadiumId: string; homeTeam: string; kickoff: string | null; roof: string | null };
export type WeatherResult = { roof: string | null; weather: GameWeather | null };

const CACHE_TTL_MS = 60 * 60 * 1000;
const FORECAST_DAYS = 15;
const memo = new Map<string, { expires: number; value: Promise<Map<string, WeatherResult>> }>();

/** Kickoff-hour forecast per game. Domes get no forecast; past or far-off games get null weather. */
export function getGameWeather(requests: WeatherRequest[]): Promise<Map<string, WeatherResult>> {
  const key = requests.map((r) => `${r.gameId}@${r.kickoff}`).join(",");
  const cached = memo.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = fetchWeather(requests);
  memo.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
  return value;
}

async function fetchWeather(requests: WeatherRequest[]): Promise<Map<string, WeatherResult>> {
  const out = new Map<string, WeatherResult>();
  const now = Date.now();
  const lookups: { gameId: string; stadium: Stadium; date: string; hour: string }[] = [];

  for (const r of requests) {
    const stadium = STADIUMS[r.stadiumId] ?? STADIUMS[HOME_STADIUM[r.homeTeam] ?? ""];
    // nflverse roof wins when present ("dome", "closed", "open", "outdoors").
    const roof = r.roof === "closed" || r.roof === "dome" ? "dome" : (r.roof || stadium?.roof) ?? null;
    out.set(r.gameId, { roof, weather: null });
    if (!stadium || roof === "dome" || !r.kickoff) continue;

    // Kickoff is Eastern wall-clock; only forecast games in the forecast window that haven't started.
    const kickoffMs = easternToUtcMs(r.kickoff) ?? NaN;
    if (!(kickoffMs > now - 4 * 3600_000 && kickoffMs < now + FORECAST_DAYS * 86400_000)) continue;
    lookups.push({ gameId: r.gameId, stadium, date: r.kickoff.slice(0, 10), hour: r.kickoff.slice(0, 13) + ":00" });
  }
  if (lookups.length === 0) return out;

  const dates = lookups.map((l) => l.date).sort();
  const params = new URLSearchParams({
    latitude: lookups.map((l) => l.stadium.lat).join(","),
    longitude: lookups.map((l) => l.stadium.lon).join(","),
    hourly: "temperature_2m,precipitation_probability,wind_speed_10m,weather_code",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    timezone: "America/New_York",
    start_date: dates[0],
    end_date: dates[dates.length - 1],
  });

  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { cache: "no-store" });
    if (!res.ok) return out;
    const json: unknown = await res.json();
    const locations = (Array.isArray(json) ? json : [json]) as Array<{
      hourly?: { time: string[]; temperature_2m: number[]; precipitation_probability: number[]; wind_speed_10m: number[]; weather_code: number[] };
    }>;

    lookups.forEach((l, i) => {
      const h = locations[i]?.hourly;
      const idx = h?.time.indexOf(l.hour) ?? -1;
      if (!h || idx < 0) return;
      const at = <T,>(arr: T[]) => (arr?.[idx] ?? null) as T | null;
      out.set(l.gameId, {
        roof: out.get(l.gameId)?.roof ?? null,
        weather: {
          tempF: at(h.temperature_2m) === null ? null : Math.round(at(h.temperature_2m)!),
          windMph: at(h.wind_speed_10m) === null ? null : Math.round(at(h.wind_speed_10m)!),
          precipChance: at(h.precipitation_probability),
          conditions: describe(at(h.weather_code)),
        },
      });
    });
  } catch (error) {
    console.error("Weather lookup failed", error);
  }
  return out;
}
