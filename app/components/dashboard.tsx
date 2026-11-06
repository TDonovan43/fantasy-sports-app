"use client";

import { useMemo, useState } from "react";
import { ROSTER_SLOTS, assignSlots, lineupProjection, lineupSalary, lineupToCsv, optimizeLineup } from "@/lib/optimizer";
import type { Matchup, PoolPlayer, SlateData } from "@/lib/types";

type SortKey = "name" | "salary" | "projected" | "floor" | "ceiling" | "value";
type PositionFilter = "ALL" | "QB" | "RB" | "WR" | "TE" | "FLEX" | "DST";

const POSITION_FILTERS: PositionFilter[] = ["ALL", "QB", "RB", "WR", "TE", "FLEX", "DST"];
const PAGE_SIZE = 50;

const money = (n: number) => (n > 0 ? `$${n.toLocaleString("en-US")}` : "—");

/** Provider times are Eastern wall-clock; format the digits without shifting time zones. */
function formatKickoff(value: string | null) {
  if (!value) return "TBD";
  const date = new Date(`${value.slice(0, 19)}Z`);
  if (Number.isNaN(date.getTime())) return "TBD";
  const day = date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  return `${day} ${time} ET`;
}

function formatLine(game: Matchup) {
  const parts: string[] = [];
  if (game.pointSpread !== null && game.pointSpread !== 0) {
    // SportsDataIO spreads are relative to the home team.
    const fav = game.pointSpread < 0 ? game.homeTeam : game.awayTeam;
    parts.push(`${fav} -${Math.abs(game.pointSpread)}`);
  }
  if (game.overUnder !== null) parts.push(`O/U ${game.overUnder}`);
  return parts.join(" · ");
}

function downloadCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Dashboard({ slate }: { slate: SlateData }) {
  const [position, setPosition] = useState<PositionFilter>("ALL");
  const [gameFilter, setGameFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "projected", desc: true });
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [lineupIds, setLineupIds] = useState<string[]>([]);
  const [excludedIds, setExcludedIds] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const byId = useMemo(() => new Map(slate.players.map((p) => [p.id, p])), [slate.players]);
  const lineup = useMemo(() => lineupIds.map((id) => byId.get(id)).filter((p): p is PoolPlayer => !!p), [lineupIds, byId]);
  const slots = assignSlots(lineup) ?? ROSTER_SLOTS.map(() => null);
  const salaryUsed = lineupSalary(lineup);
  const remaining = slate.salaryCap - salaryUsed;
  const openSlots = slots.filter((s) => s === null).length;
  const hasDst = slate.players.some((p) => p.position === "DST");

  const selectedGame = slate.games.find((g) => g.id === gameFilter) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = slate.players.filter((p) => {
      if (position === "FLEX" ? !["RB", "WR", "TE"].includes(p.position) : position !== "ALL" && p.position !== position) return false;
      if (selectedGame && p.team !== selectedGame.awayTeam && p.team !== selectedGame.homeTeam) return false;
      if (q && !p.name.toLowerCase().includes(q) && !p.team.toLowerCase().includes(q)) return false;
      return true;
    });
    const dir = sort.desc ? -1 : 1;
    return rows.sort((a, b) => (sort.key === "name" ? a.name.localeCompare(b.name) : a[sort.key] - b[sort.key]) * dir);
  }, [slate.players, position, selectedGame, query, sort]);

  const topValue = useMemo(
    () => slate.players.filter((p) => p.salary > 0).reduce<PoolPlayer | null>((best, p) => (!best || p.value > best.value ? p : best), null),
    [slate.players],
  );

  function resetPaging<T>(fn: (v: T) => void) {
    return (v: T) => {
      fn(v);
      setVisible(PAGE_SIZE);
    };
  }

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== "name" }));
  }

  function addPlayer(player: PoolPlayer) {
    if (lineupIds.includes(player.id)) return;
    if (!assignSlots([...lineup, player])) {
      setMessage(`No open ${player.position === "QB" || player.position === "DST" ? player.position : `${player.position}/FLEX`} slot for ${player.name}.`);
      return;
    }
    setMessage(player.salary > remaining ? `Heads up: ${player.name} puts you over the cap.` : null);
    setLineupIds((ids) => [...ids, player.id]);
  }

  function removePlayer(id: string) {
    setLineupIds((ids) => ids.filter((x) => x !== id));
    setMessage(null);
  }

  function toggleExclude(id: string) {
    setExcludedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
    removePlayer(id);
  }

  function runOptimizer() {
    const result = optimizeLineup({ pool: slate.players, salaryCap: slate.salaryCap, lockedIds: lineupIds, excludedIds });
    if (!result.ok) {
      setMessage(result.reason);
      return;
    }
    setLineupIds(result.players.map((p) => p.id));
    setMessage(
      `Optimal lineup: ${result.projected.toFixed(1)} pts for ${money(result.salary)}${lineupIds.length ? ` (kept your ${lineupIds.length} pick${lineupIds.length > 1 ? "s" : ""})` : ""}.`,
    );
  }

  function exportLineup() {
    if (lineup.length === 0) {
      setMessage("Add players or run the optimizer before exporting.");
      return;
    }
    downloadCsv(`fieldgoal-week${slate.week}-lineup.csv`, lineupToCsv(lineup));
  }

  const sortHeader = (k: SortKey, label: string) => (
    <th key={k} className="px-3 py-3">
      <button onClick={() => toggleSort(k)} className={`uppercase tracking-[0.18em] hover:text-white ${sort.key === k ? "text-emerald-300" : ""}`}>
        {label}
        {sort.key === k ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-400 font-black text-slate-950">F</div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.28em] text-emerald-300">DFS Research</p>
              <h1 className="text-xl font-bold">FieldGoal</h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-full border border-slate-700 px-3 py-1 text-slate-300">
              Week {slate.week} · {slate.season}
            </span>
            <span className="rounded-full border border-emerald-400/40 bg-emerald-500/10 px-3 py-1 text-emerald-300">{slate.source}</span>
            <span className="rounded-full border border-slate-700 px-3 py-1 text-slate-300">{slate.players.length} players</span>
            {topValue && (
              <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-amber-300">
                Top value: {topValue.name} ({topValue.value.toFixed(2)}x)
              </span>
            )}
          </div>
        </header>

        {slate.notices.length > 0 && (
          <ul className="mb-6 space-y-1 rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
            {slate.notices.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}

        {slate.games.length > 0 && (
          <section aria-label="Matchups" className="mb-6">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm uppercase tracking-[0.22em] text-slate-400">This week&apos;s games</h2>
              {selectedGame && (
                <button onClick={() => resetPaging(setGameFilter)(null)} className="text-xs text-emerald-300 hover:text-white">
                  Clear game filter
                </button>
              )}
            </div>
            <div className="flex gap-3 overflow-x-auto pb-2">
              {slate.games.map((game) => {
                const active = game.id === gameFilter;
                return (
                  <button
                    key={game.id}
                    onClick={() => resetPaging(setGameFilter)(active ? null : game.id)}
                    className={`min-w-[150px] shrink-0 rounded-2xl border p-3 text-left transition ${
                      active ? "border-emerald-400 bg-emerald-500/10" : "border-slate-800 bg-slate-900/60 hover:border-slate-600"
                    }`}
                  >
                    <p className="font-bold">
                      {game.awayTeam} <span className="text-slate-500">@</span> {game.homeTeam}
                    </p>
                    <p className="mt-1 text-xs text-emerald-300">{game.status === "Final" ? "Final" : formatKickoff(game.kickoff)}</p>
                    <p className="mt-1 text-xs text-slate-400">{formatLine(game) || game.channel || " "}</p>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
          <section className="min-w-0 overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/70">
            <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-4 py-4">
              <h2 className="mr-auto text-2xl font-bold">Player board</h2>
              <input
                type="search"
                value={query}
                onChange={(e) => resetPaging(setQuery)(e.target.value)}
                placeholder="Search player or team"
                className="w-48 rounded-full border border-slate-700 bg-slate-950 px-4 py-2 text-sm outline-none focus:border-emerald-400"
              />
            </div>
            <div className="flex flex-wrap gap-2 border-b border-slate-800 px-4 py-3">
              {POSITION_FILTERS.map((pos) => (
                <button
                  key={pos}
                  onClick={() => resetPaging(setPosition)(pos)}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] ${
                    position === pos ? "border-emerald-400 bg-emerald-400 text-slate-950" : "border-slate-700 text-slate-300 hover:border-slate-500"
                  }`}
                >
                  {pos}
                </button>
              ))}
              <span className="ml-auto self-center text-xs text-slate-500">{filtered.length} shown</span>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm text-slate-200">
                <thead className="bg-slate-950/80 text-xs text-slate-400">
                  <tr>
                    <th className="px-3 py-3" />
                    {sortHeader("name", "Player")}
                    <th className="px-3 py-3 uppercase tracking-[0.18em]">Matchup</th>
                    {sortHeader("salary", "Salary")}
                    {sortHeader("projected", "Proj")}
                    {sortHeader("floor", "Floor")}
                    {sortHeader("ceiling", "Ceil")}
                    {sortHeader("value", "Value")}
                    <th className="px-3 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, visible).map((p) => {
                    const inLineup = lineupIds.includes(p.id);
                    const excluded = excludedIds.includes(p.id);
                    return (
                      <tr key={p.id} className={`border-t border-slate-800 hover:bg-slate-800/50 ${excluded ? "opacity-40" : ""}`}>
                        <td className="px-3 py-2">
                          <button
                            onClick={() => (inLineup ? removePlayer(p.id) : addPlayer(p))}
                            disabled={excluded}
                            aria-label={inLineup ? `Remove ${p.name}` : `Add ${p.name}`}
                            className={`flex h-7 w-7 items-center justify-center rounded-full text-base font-bold ${
                              inLineup ? "bg-emerald-400 text-slate-950" : "border border-slate-600 text-slate-300 hover:border-emerald-400 hover:text-emerald-300"
                            }`}
                          >
                            {inLineup ? "✓" : "+"}
                          </button>
                        </td>
                        <td className="px-3 py-2">
                          <p className="font-semibold text-white">{p.name}</p>
                          <p className="text-xs text-slate-500">
                            {p.position} · {p.team}
                            {p.injury && <span className="ml-1 text-rose-400">{p.injury}</span>}
                          </p>
                        </td>
                        <td className="px-3 py-2 text-slate-400">{p.opponent ? `vs ${p.opponent}` : "—"}</td>
                        <td className="px-3 py-2">{money(p.salary)}</td>
                        <td className="px-3 py-2 font-bold text-emerald-300">{p.projected.toFixed(1)}</td>
                        <td className="px-3 py-2 text-slate-400">{p.floor.toFixed(1)}</td>
                        <td className="px-3 py-2 text-slate-400">{p.ceiling.toFixed(1)}</td>
                        <td className="px-3 py-2 text-amber-300">{p.value > 0 ? `${p.value.toFixed(2)}x` : "—"}</td>
                        <td className="px-3 py-2">
                          <button onClick={() => toggleExclude(p.id)} className="text-xs text-slate-500 hover:text-rose-400">
                            {excluded ? "Undo" : "Exclude"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filtered.length === 0 && <p className="px-4 py-10 text-center text-slate-500">No players match these filters.</p>}
            </div>
            {visible < filtered.length && (
              <button onClick={() => setVisible((v) => v + PAGE_SIZE)} className="w-full border-t border-slate-800 py-3 text-sm text-emerald-300 hover:bg-slate-800/50">
                Show more ({filtered.length - visible} remaining)
              </button>
            )}
          </section>

          <aside className="h-fit rounded-3xl border border-slate-800 bg-slate-900/70 p-5 lg:sticky lg:top-6">
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className="text-xl font-bold">Lineup</h2>
              <span className="text-xs uppercase tracking-[0.18em] text-slate-400">DK Classic</span>
            </div>

            <div className="mb-1 flex justify-between text-sm">
              <span className={remaining < 0 ? "font-bold text-rose-400" : "text-slate-300"}>{remaining < 0 ? "-" : ""}${Math.abs(remaining).toLocaleString("en-US")} left</span>
              <span className="font-bold text-emerald-300">{lineupProjection(lineup).toFixed(1)} pts</span>
            </div>
            <div className="mb-1 h-2 overflow-hidden rounded-full bg-slate-800">
              <div
                className={`h-full ${remaining < 0 ? "bg-rose-500" : "bg-emerald-400"}`}
                style={{ width: `${Math.min(100, (salaryUsed / slate.salaryCap) * 100)}%` }}
              />
            </div>
            <p className="mb-4 text-xs text-slate-500">
              {openSlots > 0 && remaining > 0 ? `${money(Math.floor(remaining / openSlots))} avg per open slot` : `${money(salaryUsed)} of ${money(slate.salaryCap)}`}
            </p>

            <ol className="space-y-2">
              {ROSTER_SLOTS.map((slot, i) => {
                const p = slots[i];
                return (
                  <li key={`${slot}-${i}`} className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2">
                    <span className="w-10 text-xs font-bold text-slate-500">{slot}</span>
                    {p ? (
                      <>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold">{p.name}</p>
                          <p className="text-xs text-slate-500">
                            {p.team} · {money(p.salary)} · {p.projected.toFixed(1)}
                          </p>
                        </div>
                        <button onClick={() => removePlayer(p.id)} aria-label={`Remove ${p.name}`} className="text-slate-500 hover:text-rose-400">
                          ×
                        </button>
                      </>
                    ) : (
                      <span className="text-sm text-slate-600">{slot === "DST" && !hasDst ? "Not in feed — pick on DK" : "Empty"}</span>
                    )}
                  </li>
                );
              })}
            </ol>

            {message && <p className="mt-4 rounded-xl bg-slate-800/70 px-3 py-2 text-sm text-slate-200">{message}</p>}

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button onClick={runOptimizer} className="col-span-2 rounded-full bg-emerald-400 px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-emerald-300">
                {lineup.length > 0 ? "Optimize around picks" : "Optimize lineup"}
              </button>
              <button onClick={exportLineup} className="rounded-full border border-slate-700 px-4 py-2 text-sm font-semibold hover:border-slate-500">
                Export CSV
              </button>
              <button
                onClick={() => {
                  setLineupIds([]);
                  setMessage(null);
                }}
                className="rounded-full border border-slate-700 px-4 py-2 text-sm font-semibold hover:border-slate-500"
              >
                Clear
              </button>
            </div>
            {!hasDst && <p className="mt-3 text-xs text-slate-500">Optimizer holds back $3,000 for a defense.</p>}
          </aside>
        </div>
      </div>
    </main>
  );
}
