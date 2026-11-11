"use client";

import { useMemo, useState } from "react";
import { isInactive } from "@/lib/dk-salaries";
import { formatKickoff, formatLine, money } from "@/lib/format";
import {
  ROSTER_SLOTS,
  assignSlots,
  canExportForDraftKings,
  lineupProjection,
  lineupSalary,
  lineupToCsv,
  lineupToDraftKingsCsv,
  optimizeLineup,
} from "@/lib/optimizer";
import type { StarterControls } from "@/lib/starters";
import type { PoolPlayer, Position, SlateData } from "@/lib/types";

type SortKey = "name" | "salary" | "projected" | "floor" | "ceiling" | "value";
type PositionFilter = "ALL" | "QB" | "RB" | "WR" | "TE" | "FLEX" | "DST";

const POSITION_FILTERS: PositionFilter[] = ["ALL", "QB", "RB", "WR", "TE", "FLEX", "DST"];
const PAGE_SIZE = 50;
const TOP_VALUE_POSITIONS: Position[] = ["QB", "RB", "WR", "TE", "DST"];

export function StartButton({ marked, pending, onClick }: { marked: boolean; pending: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={pending}
      title={marked ? "Remove the manual starter override" : "Treat this player as the starter and recalculate projections"}
      className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold disabled:opacity-50 ${
        marked ? "border-sky-400 bg-sky-400 text-slate-950" : "border-slate-600 text-slate-300 hover:border-sky-400 hover:text-sky-300"
      }`}
    >
      {marked ? "Starting ✓" : "Mark starting"}
    </button>
  );
}

function downloadCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function LineupTab({
  slate,
  showUnprojected,
  starterControls,
}: {
  slate: SlateData;
  showUnprojected: boolean;
  starterControls: StarterControls;
}) {
  const [position, setPosition] = useState<PositionFilter>("ALL");
  const [gameFilter, setGameFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "projected", desc: true });
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [lineupIds, setLineupIds] = useState<string[]>([]);
  const [excludedIds, setExcludedIds] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  /** Projected players plus (optionally) unprojected ones, which can only be added by hand. */
  const pool = useMemo(
    () => (showUnprojected ? [...slate.players, ...(slate.unprojected ?? [])] : slate.players),
    [slate.players, slate.unprojected, showUnprojected],
  );
  const byId = useMemo(
    () => new Map([...slate.players, ...(slate.unprojected ?? [])].map((p) => [p.id, p])),
    [slate.players, slate.unprojected],
  );
  const lineup = useMemo(() => lineupIds.map((id) => byId.get(id)).filter((p): p is PoolPlayer => !!p), [lineupIds, byId]);
  const slots = assignSlots(lineup) ?? ROSTER_SLOTS.map(() => null);
  const salaryUsed = lineupSalary(lineup);
  const remaining = slate.salaryCap - salaryUsed;
  const openSlots = slots.filter((s) => s === null).length;
  const hasDst = slate.players.some((p) => p.position === "DST");

  /** Best points-per-$1K player at each position among those the optimizer could use. */
  const topValue = useMemo(() => {
    const best = new Map<Position, PoolPlayer>();
    for (const p of slate.players) {
      if (p.salary <= 0 || p.projected <= 0 || isInactive(p.injury) || excludedIds.includes(p.id)) continue;
      const cur = best.get(p.position);
      if (!cur || p.value > cur.value || (p.value === cur.value && p.projected > cur.projected)) best.set(p.position, p);
    }
    return best;
  }, [slate.players, excludedIds]);

  const selectedGame = slate.games.find((g) => g.id === gameFilter) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = pool.filter((p) => {
      if (position === "FLEX" ? !["RB", "WR", "TE"].includes(p.position) : position !== "ALL" && p.position !== position) return false;
      if (selectedGame && p.team !== selectedGame.awayTeam && p.team !== selectedGame.homeTeam) return false;
      if (q && !p.name.toLowerCase().includes(q) && !p.team.toLowerCase().includes(q)) return false;
      return true;
    });
    const dir = sort.desc ? -1 : 1;
    return rows.sort((a, b) => (sort.key === "name" ? a.name.localeCompare(b.name) : a[sort.key] - b[sort.key]) * dir);
  }, [pool, position, selectedGame, query, sort]);

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
    setMessage(
      isInactive(player.injury)
        ? `Heads up: ${player.name} is listed ${player.injury}.`
        : player.salary > remaining
          ? `Heads up: ${player.name} puts you over the cap.`
          : null,
    );
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
    // Unprojected players are only used if you've added them yourself (they're locked in).
    const result = optimizeLineup({ pool: [...slate.players, ...(slate.unprojected ?? [])], salaryCap: slate.salaryCap, lockedIds: lineupIds, excludedIds });
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
    if (canExportForDraftKings(lineup)) {
      downloadCsv(`DKUpload-week${slate.week}.csv`, lineupToDraftKingsCsv(lineup));
      setMessage("Downloaded a DraftKings upload file. On DraftKings: Lineups → Upload Lineups.");
    } else {
      downloadCsv(`fieldgoal-week${slate.week}-lineup.csv`, lineupToCsv(lineup));
      setMessage(
        lineup.length < ROSTER_SLOTS.length
          ? "Lineup isn't full, so this is a readable CSV. Fill every slot for a DraftKings upload file."
          : "Downloaded a readable CSV. Upload your DKSalaries.csv to get a DraftKings upload file.",
      );
    }
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
    <>
      {slate.games.length > 0 && (
        <section aria-label="Filter by game" className="mb-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm uppercase tracking-[0.22em] text-slate-400">Filter by game</h2>
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

      <section aria-label="Top value by position" className="mb-6">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="text-sm uppercase tracking-[0.22em] text-slate-400">Top value by position</h2>
          <span className="text-xs text-slate-500">Projected points per $1,000 of salary</span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {TOP_VALUE_POSITIONS.map((pos) => {
            const p = topValue.get(pos);
            const inLineup = !!p && lineupIds.includes(p.id);
            return (
              <div key={pos} className="flex min-w-0 flex-col rounded-2xl border border-slate-800 bg-slate-900/60 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">{pos}</p>
                {p ? (
                  <>
                    <p className="mt-1 truncate font-bold text-white" title={p.name}>
                      {p.name}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                      {p.team}
                      {p.opponent ? ` vs ${p.opponent}` : ""} · {money(p.salary)}
                      {p.injury && <span className="ml-1 font-semibold text-amber-300">{p.injury}</span>}
                    </p>
                    <p className="mt-2 flex items-baseline justify-between gap-2">
                      <span className="text-xl font-black text-amber-300">{p.value.toFixed(2)}x</span>
                      <span className="text-xs text-emerald-300">{p.projected.toFixed(1)} pts</span>
                    </p>
                    <button
                      onClick={() => (inLineup ? removePlayer(p.id) : addPlayer(p))}
                      aria-label={inLineup ? `Remove ${p.name}` : `Add ${p.name}`}
                      className={`mt-2 rounded-full px-3 py-1 text-xs font-semibold ${
                        inLineup ? "bg-emerald-400 text-slate-950" : "border border-slate-600 text-slate-300 hover:border-emerald-400 hover:text-emerald-300"
                      }`}
                    >
                      {inLineup ? "In lineup ✓" : "Add"}
                    </button>
                  </>
                ) : (
                  <p className="mt-1 text-sm text-slate-500">No eligible players</p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <section className="min-w-0 overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/70">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-4 py-4">
            <h2 className="mr-auto text-2xl font-bold">Player pool</h2>
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
                          {p.injury && (
                            <span className={`ml-1 font-semibold ${isInactive(p.injury) ? "text-rose-400" : "text-amber-300"}`}>{p.injury}</span>
                          )}
                          {p.research?.limitedData && (
                            <span title="Starter with little recent data: projected from past games plus the role baseline" className="ml-1 text-sky-300">
                              limited data
                            </span>
                          )}
                          {p.projected === 0 && <span className="ml-1 text-slate-400">no projection</span>}
                        </p>
                      </td>
                      <td className="px-3 py-2 text-slate-400">{p.opponent ? `vs ${p.opponent}` : "—"}</td>
                      <td className="px-3 py-2">{money(p.salary)}</td>
                      <td className="px-3 py-2 font-bold text-emerald-300">
                        {p.projected === 0 ? "—" : p.projected.toFixed(1)}
                        {p.projectionFromDkAvg && (
                          <span title="No projection available; DraftKings season average" className="ml-1 text-[10px] font-normal text-slate-500">
                            avg
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-400">{p.floor.toFixed(1)}</td>
                      <td className="px-3 py-2 text-slate-400">{p.ceiling.toFixed(1)}</td>
                      <td className="px-3 py-2 text-amber-300">{p.value > 0 ? `${p.value.toFixed(2)}x` : "—"}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-3">
                          {starterControls.canMark(p) && (
                            <StartButton marked={starterControls.isMarked(p)} pending={starterControls.pending} onClick={() => starterControls.toggle(p)} />
                          )}
                          <button onClick={() => toggleExclude(p.id)} className="text-xs text-slate-500 hover:text-rose-400">
                            {excluded ? "Undo" : "Exclude"}
                          </button>
                        </div>
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
            <span className={remaining < 0 ? "font-bold text-rose-400" : "text-slate-300"}>
              {remaining < 0 ? "-" : ""}${Math.abs(remaining).toLocaleString("en-US")} left
            </span>
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
              Export
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
    </>
  );
}
