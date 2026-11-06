"use client";

import { formatKickoff, impliedTotals, signed } from "@/lib/format";
import type { Matchup, SlateData } from "@/lib/types";

const WINDY_MPH = 15;
const WET_PCT = 50;

function roofLabel(roof: string | null | undefined) {
  if (roof === "dome") return "Dome";
  if (roof === "retractable") return "Retractable roof";
  if (roof === "open") return "Retractable (open)";
  if (roof === "outdoors") return "Outdoors";
  return null;
}

function WeatherBlock({ game }: { game: Matchup }) {
  if (game.status === "Final") {
    return <p className="text-sm text-slate-400">Final</p>;
  }
  if (game.roof === "dome") {
    return <p className="text-sm text-slate-300">Indoors — weather not a factor</p>;
  }
  const w = game.weather;
  if (!w) {
    return <p className="text-sm text-slate-500">Forecast not available yet</p>;
  }
  const windy = (w.windMph ?? 0) >= WINDY_MPH;
  const wet = (w.precipChance ?? 0) >= WET_PCT;
  return (
    <div>
      <p className="text-sm text-slate-200">
        <span className="text-lg font-bold text-white">{w.tempF !== null ? `${w.tempF}°F` : "—"}</span>
        <span className="ml-2">{w.conditions ?? ""}</span>
      </p>
      <p className="mt-1 text-xs text-slate-400">
        <span className={windy ? "font-semibold text-amber-300" : ""}>Wind {w.windMph ?? "—"} mph</span>
        <span className="mx-2 text-slate-600">·</span>
        <span className={wet ? "font-semibold text-amber-300" : ""}>Precip {w.precipChance ?? "—"}%</span>
      </p>
      {(windy || wet) && (
        <p className="mt-1 text-xs text-amber-300">
          {windy && wet ? "Wind and rain" : windy ? "Windy" : "Rain likely"}: can suppress passing and kicking.
        </p>
      )}
      {game.roof === "retractable" && <p className="mt-1 text-[11px] text-slate-500">Retractable roof; may be closed.</p>}
    </div>
  );
}

function TeamLine({ team, spread, moneyline, implied, favored }: { team: string; spread: number | null; moneyline: number | null | undefined; implied: number | null; favored: boolean }) {
  return (
    <tr className="border-t border-slate-800">
      <td className={`py-2 pr-3 font-bold ${favored ? "text-white" : "text-slate-300"}`}>{team}</td>
      <td className="py-2 pr-3 text-slate-300">{spread === null ? "—" : spread === 0 ? "PK" : signed(spread)}</td>
      <td className="py-2 pr-3 text-slate-300">{moneyline === null || moneyline === undefined ? "—" : signed(moneyline)}</td>
      <td className="py-2 text-right text-lg font-bold text-emerald-300">{implied === null ? "—" : implied.toFixed(1)}</td>
    </tr>
  );
}

export default function GamesTab({ slate }: { slate: SlateData }) {
  if (slate.games.length === 0) {
    return <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-8 text-center text-slate-400">No games for this week.</section>;
  }

  const games = [...slate.games].sort((a, b) => (a.kickoff ?? "").localeCompare(b.kickoff ?? ""));
  const ranked = games
    .map((g) => ({ g, implied: impliedTotals(g) }))
    .flatMap(({ g, implied }) => (implied ? [{ team: g.awayTeam, total: implied.away, g }, { team: g.homeTeam, total: implied.home, g }] : []))
    .filter(({ g }) => g.status !== "Final")
    .sort((a, b) => b.total - a.total);

  return (
    <div className="space-y-6">
      {ranked.length > 0 && (
        <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5">
          <h2 className="mb-1 text-xl font-bold">Implied team totals</h2>
          <p className="mb-4 text-xs text-slate-500">Points each team is expected to score, from the spread and over/under.</p>
          <div className="flex flex-wrap gap-2">
            {ranked.map(({ team, total, g }) => (
              <span key={`${g.id}-${team}`} className="rounded-full border border-slate-700 bg-slate-950/70 px-3 py-1 text-sm">
                <span className="font-semibold text-white">{team}</span>
                <span className="ml-2 text-emerald-300">{total.toFixed(1)}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {games.map((g) => {
          const implied = impliedTotals(g);
          // pointSpread is home-relative: negative = home favored.
          const homeSpread = g.pointSpread;
          const awaySpread = g.pointSpread === null ? null : -g.pointSpread;
          const final = g.status === "Final";
          return (
            <article key={g.id} className={`rounded-3xl border border-slate-800 bg-slate-900/70 p-5 ${final ? "opacity-60" : ""}`}>
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-xl font-bold">
                    {g.awayTeam} <span className="text-slate-500">@</span> {g.homeTeam}
                  </h3>
                  <p className="text-xs text-emerald-300">{final ? `Final: ${g.awayScore ?? "–"}–${g.homeScore ?? "–"}` : formatKickoff(g.kickoff)}</p>
                  {g.stadium && <p className="text-xs text-slate-500">{g.stadium}</p>}
                </div>
                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Total</p>
                  <p className="text-2xl font-black">{g.overUnder ?? "—"}</p>
                </div>
              </div>

              <table className="mb-4 w-full text-sm">
                <thead className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
                  <tr>
                    <th className="pb-1 text-left font-medium">Team</th>
                    <th className="pb-1 text-left font-medium">Spread</th>
                    <th className="pb-1 text-left font-medium">ML</th>
                    <th className="pb-1 text-right font-medium">Implied</th>
                  </tr>
                </thead>
                <tbody>
                  <TeamLine team={g.awayTeam} spread={awaySpread} moneyline={g.awayMoneyline} implied={implied?.away ?? null} favored={(awaySpread ?? 0) < 0} />
                  <TeamLine team={g.homeTeam} spread={homeSpread} moneyline={g.homeMoneyline} implied={implied?.home ?? null} favored={(homeSpread ?? 0) < 0} />
                </tbody>
              </table>

              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-3">
                <div className="mb-1 flex items-center justify-between">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Kickoff forecast</p>
                  {roofLabel(g.roof) && <span className="text-[10px] uppercase tracking-[0.14em] text-slate-500">{roofLabel(g.roof)}</span>}
                </div>
                <WeatherBlock game={g} />
              </div>
            </article>
          );
        })}
      </div>
      <p className="text-xs text-slate-500">
        Lines: nflverse schedule (closing/consensus lines). Weather: Open-Meteo hourly forecast at kickoff for the stadium.
      </p>
    </div>
  );
}
