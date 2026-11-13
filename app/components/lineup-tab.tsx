"use client";

import { useMemo, useState } from "react";
import { isInactive } from "@/lib/dk-salaries";
import { formatKickoff, formatLine, impliedTotals, money } from "@/lib/format";
import { DEFAULT_STACK_RULES, NO_RULES, describeStack, type StackRules } from "@/lib/stack-rules";
import {
  ROSTER_SLOTS,
  assignSlots,
  canExportForDraftKings,
  lineupProjection,
  lineupSalary,
  lineupToCsv,
  lineupToDraftKingsCsv,
  lineupsToCsv,
  lineupsToDraftKingsCsv,
  generateLineups,
  optimizeLineup,
  type MultiLineupResult,
} from "@/lib/optimizer";
import type { StarterControls } from "@/lib/starters";
import type { PoolPlayer, Position, SlateData } from "@/lib/types";

type SortKey = "name" | "salary" | "projected" | "floor" | "ceiling" | "value" | "etr" | "own";

/** Sum of ETR projected ownership (large field) across a lineup, in %. */
function totalOwnership(players: PoolPlayer[]) {
  return players.reduce((sum, p) => sum + (p.etr?.ownLarge ?? 0), 0);
}

/** Sort value for a column (ETR columns sort players without ETR data last). */
function sortValue(p: PoolPlayer, key: Exclude<SortKey, "name">) {
  if (key === "etr") return p.etr?.projected ?? -1;
  if (key === "own") return p.etr?.ownLarge ?? -1;
  return p[key];
}
type PositionFilter = "ALL" | "QB" | "RB" | "WR" | "TE" | "FLEX" | "DST";

const POSITION_FILTERS: PositionFilter[] = ["ALL", "QB", "RB", "WR", "TE", "FLEX", "DST"];
const PAGE_SIZE = 50;
const TOP_VALUE_POSITIONS: Position[] = ["QB", "RB", "WR", "TE", "DST"];
const RANDOMNESS = { none: 0, low: 0.25, medium: 0.5, high: 1 } as const;
type Randomness = keyof typeof RANDOMNESS;
const MAX_LINEUPS = 50;

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
  /** Games chosen in the strip; empty = every game in the slate. */
  const [selectedGameIds, setSelectedGameIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "projected", desc: true });
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [lineupIds, setLineupIds] = useState<string[]>([]);
  const [excludedIds, setExcludedIds] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [multiCount, setMultiCount] = useState(5);
  const [minUnique, setMinUnique] = useState(2);
  const [maxExposurePct, setMaxExposurePct] = useState(60);
  const [randomness, setRandomness] = useState<Randomness>("medium");
  const [built, setBuilt] = useState<MultiLineupResult | null>(null);
  const [stackRules, setStackRules] = useState<StackRules>(DEFAULT_STACK_RULES);
  const [maxStackExposurePct, setMaxStackExposurePct] = useState(40);
  /** Share of built lineups with 2 TEs (a TE in the FLEX); null = the optimizer decides. */
  const [twoTeShare, setTwoTeShare] = useState<number | null>(null);
  const [busy, setBusy] = useState<null | "optimize" | "build">(null);

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
  /** ETR projections were uploaded in this browser. */
  const hasEtr = slate.players.some((p) => p.etr);
  const hasOwnership = slate.players.some((p) => p.etr?.ownLarge !== null && p.etr?.ownLarge !== undefined);

  /** Selected games still in this slate (the DK slate selector can remove some). */
  const activeGames = useMemo(() => slate.games.filter((g) => selectedGameIds.includes(g.id)), [slate.games, selectedGameIds]);
  /** Teams in the selected games, or null when no game is selected (= all games). */
  const selectedTeams = useMemo(
    () => (activeGames.length ? new Set(activeGames.flatMap((g) => [g.awayTeam, g.homeTeam])) : null),
    [activeGames],
  );
  const gameOfTeam = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of slate.games) {
      map.set(g.awayTeam, g.id);
      map.set(g.homeTeam, g.id);
    }
    return map;
  }, [slate.games]);
  const playersPerGame = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of slate.players) {
      const id = gameOfTeam.get(p.team);
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [slate.players, gameOfTeam]);
  const selectedPlayerCount = selectedTeams ? slate.players.filter((p) => selectedTeams.has(p.team)).length : slate.players.length;

  function toggleGame(id: string) {
    setSelectedGameIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
    setVisible(PAGE_SIZE);
  }

  /** Best points-per-$1K player at each position among those the optimizer could use. */
  const topValue = useMemo(() => {
    const best = new Map<Position, PoolPlayer>();
    for (const p of slate.players) {
      if (p.salary <= 0 || p.projected <= 0 || isInactive(p.injury) || excludedIds.includes(p.id)) continue;
      if (selectedTeams && !selectedTeams.has(p.team)) continue;
      const cur = best.get(p.position);
      if (!cur || p.value > cur.value || (p.value === cur.value && p.projected > cur.projected)) best.set(p.position, p);
    }
    return best;
  }, [slate.players, excludedIds, selectedTeams]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = pool.filter((p) => {
      if (position === "FLEX" ? !["RB", "WR", "TE"].includes(p.position) : position !== "ALL" && p.position !== position) return false;
      if (selectedTeams && !selectedTeams.has(p.team)) return false;
      if (q && !p.name.toLowerCase().includes(q) && !p.team.toLowerCase().includes(q)) return false;
      return true;
    });
    const dir = sort.desc ? -1 : 1;
    const key = sort.key;
    return rows.sort((a, b) => (key === "name" ? a.name.localeCompare(b.name) : sortValue(a, key) - sortValue(b, key)) * dir);
  }, [pool, position, selectedTeams, query, sort]);

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

  const opponentOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of slate.games) {
      map.set(g.awayTeam, g.homeTeam);
      map.set(g.homeTeam, g.awayTeam);
    }
    return map;
  }, [slate.games]);

  /** Teams that can anchor a QB stack (in the selected games), highest implied total first. */
  const stackTeamOptions = useMemo(() => {
    const games = activeGames.length ? activeGames : slate.games;
    const withQb = new Set(slate.players.filter((p) => p.position === "QB").map((p) => p.team));
    return games
      .flatMap((g) => {
        const it = impliedTotals(g);
        return [
          { team: g.awayTeam, implied: it?.away ?? null },
          { team: g.homeTeam, implied: it?.home ?? null },
        ];
      })
      .filter((t) => withQb.has(t.team))
      .sort((a, b) => (b.implied ?? 0) - (a.implied ?? 0));
  }, [activeGames, slate.games, slate.players]);

  const stacking = stackRules.qbStack > 0;
  const rulesOff = !stacking && stackRules.bringBack === 0 && !stackRules.avoidVsDst && stackRules.maxPerTeam >= 9;

  function setRule<K extends keyof StackRules>(key: K, value: StackRules[K]) {
    setStackRules((r) => ({ ...r, [key]: value }));
  }

  function toggleStackTeam(team: string) {
    setStackRules((r) => {
      const current = r.stackTeams ?? [];
      const next = current.includes(team) ? current.filter((t) => t !== team) : [...current, team];
      return { ...r, stackTeams: next.length ? next : null };
    });
  }

  /** Players the optimizer may use: the selected games (or all), plus anyone already in the lineup. */
  function optimizerPool() {
    const everyone = [...slate.players, ...(slate.unprojected ?? [])];
    return selectedTeams ? everyone.filter((p) => selectedTeams.has(p.team) || lineupIds.includes(p.id)) : everyone;
  }

  type SolverResponse = { lineups: { ids: string[]; salary: number; projected: number }[]; exposure: Record<string, number>; warnings: string[] };

  /** Asks the server's integer-programming solver (with the stacking rules) for one or more lineups. */
  async function callSolver(extra: Record<string, unknown>): Promise<SolverResponse> {
    const players = optimizerPool().map(({ id, name, position, team, salary, projected, floor, ceiling, injury }) => ({
      id,
      name,
      position,
      team,
      salary,
      projected,
      floor,
      ceiling,
      injury,
    }));
    const res = await fetch("/api/optimize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        players,
        games: slate.games.map(({ id, awayTeam, homeTeam }) => ({ id, awayTeam, homeTeam })),
        salaryCap: slate.salaryCap,
        lockedIds: lineupIds,
        excludedIds,
        rules: stackRules,
        ...extra,
      }),
    });
    const json = (await res.json()) as SolverResponse & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  }

  const toPlayers = (ids: string[]) => ids.map((id) => byId.get(id)).filter((p): p is PoolPlayer => !!p);
  const FALLBACK_NOTE = " The stacking solver was unavailable, so stacking rules weren't applied.";

  async function buildLineups() {
    if (selectedTeams && activeGames.length < 2) {
      setMessage("Select at least 2 games: DraftKings Classic lineups need players from 2 or more games.");
      return;
    }
    const count = Math.min(MAX_LINEUPS, Math.max(1, Math.round(multiCount)));
    const settings = {
      count,
      minUnique: Math.min(9, Math.max(1, Math.round(minUnique))),
      maxExposure: Math.min(100, Math.max(10, maxExposurePct)) / 100,
      randomness: RANDOMNESS[randomness],
      // A new seed each click, so "Build" again gives a different set.
      seed: Math.floor(Math.random() * 2 ** 31),
    };
    setBusy("build");
    setMessage(`Building ${count} lineups…`);
    let result: MultiLineupResult;
    let note = "";
    try {
      const r = await callSolver({ ...settings, maxStackExposure: Math.min(100, Math.max(5, maxStackExposurePct)) / 100, twoTeShare });
      result = {
        lineups: r.lineups.map((l) => ({ players: toPlayers(l.ids), salary: l.salary, projected: l.projected })),
        exposure: new Map(Object.entries(r.exposure)),
        warnings: r.warnings,
      };
    } catch {
      result = generateLineups({
        pool: optimizerPool(),
        salaryCap: slate.salaryCap,
        lockedIds: lineupIds,
        excludedIds,
        ...settings,
        gameOf: (p) => gameOfTeam.get(p.team) ?? p.team,
      });
      note = FALLBACK_NOTE;
    } finally {
      setBusy(null);
    }
    setBuilt(result);
    setMessage(
      result.lineups.length
        ? `Built ${result.lineups.length} lineup${result.lineups.length > 1 ? "s" : ""}${lineupIds.length ? ` around your ${lineupIds.length} pick${lineupIds.length > 1 ? "s" : ""}` : ""}. See them below the player pool.${note}`
        : (result.warnings.at(0) ?? "Couldn't build lineups with these settings.") + note,
    );
  }

  function exportBuilt() {
    if (!built?.lineups.length) return;
    const dk = lineupsToDraftKingsCsv(built.lineups);
    if (dk) {
      downloadCsv(`DKUpload-week${slate.week}-${built.lineups.length}-lineups.csv`, dk);
      setMessage(`Downloaded ${built.lineups.length} lineups for DraftKings: Lineups → Upload Lineups.`);
    } else {
      downloadCsv(`fieldgoal-week${slate.week}-${built.lineups.length}-lineups.csv`, lineupsToCsv(built.lineups));
      setMessage("Downloaded a readable CSV. Upload your DKSalaries.csv to get a DraftKings upload file.");
    }
  }

  async function runOptimizer() {
    if (selectedTeams && activeGames.length < 2) {
      setMessage("Select at least 2 games: DraftKings Classic lineups need players from 2 or more games.");
      return;
    }
    // Unprojected players are only used if you've added them yourself (they're locked in).
    // With games selected, only their players are eligible; your current picks stay locked in either way.
    setBusy("optimize");
    let picked: { players: PoolPlayer[]; salary: number; projected: number } | null = null;
    let failure: string | null = null;
    let note = "";
    try {
      const r = await callSolver({ count: 1 });
      const l = r.lineups.at(0);
      if (l) picked = { players: toPlayers(l.ids), salary: l.salary, projected: l.projected };
      else failure = r.warnings.at(0) ?? "No lineup found.";
    } catch {
      const result = optimizeLineup({ pool: optimizerPool(), salaryCap: slate.salaryCap, lockedIds: lineupIds, excludedIds });
      if (result.ok) picked = result;
      else failure = result.reason;
      note = FALLBACK_NOTE;
    } finally {
      setBusy(null);
    }
    if (!picked) {
      setMessage((selectedTeams ? `${failure} Try selecting more games.` : (failure ?? "No lineup found.")) + note);
      return;
    }
    setLineupIds(picked.players.map((p) => p.id));
    const gamesUsed = new Set(picked.players.map((p) => gameOfTeam.get(p.team) ?? p.team)).size;
    const kept = lineupIds.length ? ` Kept your ${lineupIds.length} pick${lineupIds.length > 1 ? "s" : ""}.` : "";
    const scope = selectedTeams ? ` from ${activeGames.length} selected games` : "";
    const stack = stacking && !note ? describeStack(picked.players, opponentOf, stackRules) : null;
    setMessage(
      gamesUsed < 2
        ? `Heads up: every player is from one game, which DraftKings Classic doesn't allow. Select or add players from another game.`
        : `Optimal lineup${scope}: ${picked.projected.toFixed(1)} pts for ${money(picked.salary)}.${stack ? ` ${stack.label}.` : ""}${kept}${note}`,
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
        <section aria-label="Games" className="mb-6">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="text-sm uppercase tracking-[0.22em] text-slate-400">Games</h2>
              <p className="text-xs text-slate-500">Select one or more games to limit the player pool and the optimizer.</p>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="text-slate-400">
                {activeGames.length ? `${activeGames.length} of ${slate.games.length} selected` : "All games"} · {selectedPlayerCount} players
              </span>
              {activeGames.length > 0 && (
                <button onClick={() => resetPaging(setSelectedGameIds)([])} className="text-emerald-300 hover:text-white">
                  All in slate
                </button>
              )}
            </div>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {slate.games.map((game) => {
              const active = selectedGameIds.includes(game.id);
              const count = playersPerGame.get(game.id) ?? 0;
              return (
                <button
                  key={game.id}
                  onClick={() => toggleGame(game.id)}
                  disabled={count === 0 && !active}
                  aria-pressed={active}
                  title={count === 0 ? "No players from this game in the pool (not on this DraftKings slate)" : undefined}
                  className={`min-w-[150px] shrink-0 rounded-2xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${
                    active ? "border-emerald-400 bg-emerald-500/10" : "border-slate-800 bg-slate-900/60 hover:border-slate-600"
                  }`}
                >
                  <p className="flex items-center justify-between gap-2 font-bold">
                    <span>
                      {game.awayTeam} <span className="text-slate-500">@</span> {game.homeTeam}
                    </span>
                    <span
                      aria-hidden
                      className={`flex h-4 w-4 items-center justify-center rounded border text-[10px] ${
                        active ? "border-emerald-400 bg-emerald-400 text-slate-950" : "border-slate-600"
                      }`}
                    >
                      {active ? "✓" : ""}
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-emerald-300">{game.status === "Final" ? "Final" : formatKickoff(game.kickoff)}</p>
                  <p className="mt-1 text-xs text-slate-400">{formatLine(game) || game.channel || " "}</p>
                  <p className="mt-1 text-[11px] text-slate-500">{count} players</p>
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
                    {p.etr?.ownLarge !== null && p.etr?.ownLarge !== undefined && (
                      <p className="text-[11px] text-slate-500" title="ETR projected ownership, large-field contests">
                        Own {p.etr.ownLarge.toFixed(1)}%
                      </p>
                    )}
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
                  {hasEtr && sortHeader("etr", "ETR")}
                  {hasOwnership && sortHeader("own", "Own")}
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
                          {hasEtr && !p.etr && p.projected > 0 && (
                            <span title="Establish The Run's file doesn't include this player (often means he's not expected to play)" className="ml-1 text-violet-300">
                              not in ETR
                            </span>
                          )}
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
                        {p.fieldgoal && (
                          <span title="FieldGoal's own projection" className="block text-[10px] font-normal text-slate-500">
                            FG {p.fieldgoal.projected.toFixed(1)}
                          </span>
                        )}
                      </td>
                      {hasEtr && <td className="px-3 py-2 text-violet-200">{p.etr ? p.etr.projected.toFixed(1) : "—"}</td>}
                      {hasOwnership && (
                        <td className="px-3 py-2 text-slate-300" title={p.etr?.ownSmall !== null && p.etr?.ownSmall !== undefined ? `Small field: ${p.etr.ownSmall.toFixed(1)}%` : undefined}>
                          {p.etr?.ownLarge !== null && p.etr?.ownLarge !== undefined ? `${p.etr.ownLarge.toFixed(1)}%` : "—"}
                        </td>
                      )}
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
            <span className="font-bold text-emerald-300">
              {lineupProjection(lineup).toFixed(1)} pts
              {hasOwnership && lineup.length > 0 && (
                <span className="ml-2 text-xs font-normal text-slate-400" title="Sum of ETR projected ownership (large field)">
                  Own {totalOwnership(lineup).toFixed(0)}%
                </span>
              )}
            </span>
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
            <button
              onClick={runOptimizer}
              disabled={busy !== null}
              className="col-span-2 rounded-full bg-emerald-400 px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-emerald-300 disabled:opacity-60"
            >
              {busy === "optimize" ? "Optimizing…" : lineup.length > 0 ? "Optimize around picks" : "Optimize lineup"}
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

          <div className="mt-6 border-t border-slate-800 pt-5">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-bold">Stacking</h3>
              <button
                onClick={() => setStackRules(rulesOff ? DEFAULT_STACK_RULES : NO_RULES)}
                className="text-xs text-emerald-300 hover:text-white"
              >
                {rulesOff ? "Use defaults" : "No rules"}
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-500">Applies to Optimize and Build multiple lineups.</p>
            <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
              <label className="flex flex-col gap-1 text-slate-400" title="Pass catchers from the QB's own team in every lineup">
                QB stack
                <select
                  value={stackRules.qbStack}
                  onChange={(e) => setRule("qbStack", Number(e.target.value))}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white outline-none focus:border-emerald-400"
                >
                  <option value={0}>None</option>
                  <option value={1}>QB + 1</option>
                  <option value={2}>QB + 2</option>
                  <option value={3}>QB + 3</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-slate-400" title="Players from the QB's opponent (RB, WR or TE)">
                Bring-back
                <select
                  value={stackRules.bringBack}
                  onChange={(e) => setRule("bringBack", Number(e.target.value))}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white outline-none focus:border-emerald-400"
                >
                  <option value={0}>None</option>
                  <option value={1}>1 player</option>
                  <option value={2}>2 players</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-slate-400" title="Most players from one team, defense included">
                Max per team
                <select
                  value={stackRules.maxPerTeam}
                  onChange={(e) => setRule("maxPerTeam", Number(e.target.value))}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white outline-none focus:border-emerald-400"
                >
                  {[3, 4, 5, 6, 7, 8].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                  <option value={9}>No limit</option>
                </select>
              </label>
              <div className="flex flex-col justify-end gap-1.5 text-slate-300">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={stackRules.stackPositions.includes("RB")}
                    onChange={(e) =>
                      setRule("stackPositions", e.target.checked ? ["RB", "WR", "TE"] : ["WR", "TE"])
                    }
                    disabled={!stacking}
                    className="h-4 w-4 accent-emerald-400"
                  />
                  RB counts in stack
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={stackRules.avoidVsDst}
                    onChange={(e) => setRule("avoidVsDst", e.target.checked)}
                    className="h-4 w-4 accent-emerald-400"
                  />
                  None vs my DST
                </label>
              </div>
              <label className="col-span-2 flex flex-col gap-1 text-slate-400" title="Play a second TE in the FLEX: cheap, and often strong in tournaments">
                TE in FLEX
                <select
                  value={stackRules.teCount ?? "auto"}
                  onChange={(e) => setRule("teCount", e.target.value === "auto" ? null : (Number(e.target.value) as 1 | 2))}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white outline-none focus:border-emerald-400"
                >
                  <option value="auto">Optimizer decides</option>
                  <option value={2}>Always (2 TEs)</option>
                  <option value={1}>Never (1 TE)</option>
                </select>
              </label>
            </div>
            {stacking && stackTeamOptions.length > 0 && (
              <div className="mt-3">
                <p className="mb-1 text-xs text-slate-400">
                  Stack teams <span className="text-slate-500">({stackRules.stackTeams?.length ? `${stackRules.stackTeams.length} chosen` : "any"}; by implied total)</span>
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {stackTeamOptions.map(({ team, implied }) => {
                    const on = stackRules.stackTeams?.includes(team) ?? false;
                    return (
                      <button
                        key={team}
                        onClick={() => toggleStackTeam(team)}
                        aria-pressed={on}
                        className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                          on ? "border-emerald-400 bg-emerald-400 text-slate-950" : "border-slate-700 text-slate-300 hover:border-slate-500"
                        }`}
                      >
                        {team}
                        {implied !== null && <span className={on ? "ml-1 text-slate-800" : "ml-1 text-slate-500"}>{implied.toFixed(1)}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="mt-6 border-t border-slate-800 pt-5">
            <h3 className="font-bold">Build multiple lineups</h3>
            <p className="mt-1 text-xs text-slate-500">
              Lineup 1 is the optimal one; the rest vary players while staying strong. Players in the editor stay in every lineup.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
              <label className="flex flex-col gap-1 text-slate-400">
                Lineups
                <input
                  type="number"
                  min={1}
                  max={MAX_LINEUPS}
                  value={multiCount}
                  onChange={(e) => setMultiCount(Number(e.target.value))}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white outline-none focus:border-emerald-400"
                />
              </label>
              <label className="flex flex-col gap-1 text-slate-400" title="Each lineup differs from every other by at least this many players">
                Min. different players
                <input
                  type="number"
                  min={1}
                  max={9}
                  value={minUnique}
                  onChange={(e) => setMinUnique(Number(e.target.value))}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white outline-none focus:border-emerald-400"
                />
              </label>
              <label className="flex flex-col gap-1 text-slate-400" title="No player appears in more than this share of lineups (players you added are exempt)">
                Max exposure %
                <input
                  type="number"
                  min={10}
                  max={100}
                  step={5}
                  value={maxExposurePct}
                  onChange={(e) => setMaxExposurePct(Number(e.target.value))}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white outline-none focus:border-emerald-400"
                />
              </label>
              <label className="flex flex-col gap-1 text-slate-400" title="How much projections are shaken up within each player's floor-to-ceiling range">
                Randomness
                <select
                  value={randomness}
                  onChange={(e) => setRandomness(e.target.value as Randomness)}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white outline-none focus:border-emerald-400"
                >
                  <option value="none">None (next best)</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </label>
              <label className="col-span-2 flex flex-col gap-1 text-slate-400" title="Exactly this share of lineups use 2 TEs (one in the FLEX); the rest use 1">
                2-TE lineups
                <select
                  value={twoTeShare === null ? "auto" : String(twoTeShare)}
                  onChange={(e) => setTwoTeShare(e.target.value === "auto" ? null : Number(e.target.value))}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white outline-none focus:border-emerald-400"
                >
                  <option value="auto">Optimizer decides{stackRules.teCount ? ` (TE in FLEX: ${stackRules.teCount === 2 ? "always" : "never"})` : ""}</option>
                  {[0, 0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1].map((v) => (
                    <option key={v} value={String(v)}>
                      {Math.round(v * 100)}% of lineups
                      {v > 0 && v < 1 ? ` (${Math.round(v * Math.min(MAX_LINEUPS, Math.max(1, Math.round(multiCount) || 1)))} of ${Math.min(MAX_LINEUPS, Math.max(1, Math.round(multiCount) || 1))})` : ""}
                    </option>
                  ))}
                </select>
              </label>
              {stacking && (
                <label className="col-span-2 flex flex-col gap-1 text-slate-400" title="No team's QB stack appears in more than this share of lineups">
                  Max % of lineups per stack team
                  <input
                    type="number"
                    min={5}
                    max={100}
                    step={5}
                    value={maxStackExposurePct}
                    onChange={(e) => setMaxStackExposurePct(Number(e.target.value))}
                    className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white outline-none focus:border-emerald-400"
                  />
                </label>
              )}
            </div>
            <button
              onClick={buildLineups}
              disabled={busy !== null}
              className="mt-3 w-full rounded-full border border-emerald-400 px-4 py-2 text-sm font-bold text-emerald-300 hover:bg-emerald-400 hover:text-slate-950 disabled:opacity-60"
            >
              {busy === "build" ? "Building…" : built ? "Build again" : `Build ${Math.min(MAX_LINEUPS, Math.max(1, Math.round(multiCount) || 1))} lineups`}
            </button>
          </div>
        </aside>
      </div>

      {built && built.lineups.length > 0 && (
        <BuiltLineups
          result={built}
          players={byId}
          opponentOf={opponentOf}
          rules={stackRules}
          showOwnership={hasOwnership}
          onLoad={(ids) => {
            setLineupIds(ids);
            setMessage("Loaded into the editor.");
          }}
          onExport={exportBuilt}
          onClear={() => setBuilt(null)}
        />
      )}
    </>
  );
}

function BuiltLineups({
  result,
  players,
  opponentOf,
  rules,
  showOwnership,
  onLoad,
  onExport,
  onClear,
}: {
  result: MultiLineupResult;
  players: Map<string, PoolPlayer>;
  opponentOf: Map<string, string>;
  rules: StackRules;
  showOwnership: boolean;
  onLoad: (ids: string[]) => void;
  onExport: () => void;
  onClear: () => void;
}) {
  const { lineups, exposure, warnings } = result;
  const stacks = lineups.map((l) => describeStack(l.players, opponentOf, rules));
  const stackShare = [...stacks.reduce((m, st) => (st ? m.set(st.team, (m.get(st.team) ?? 0) + 1) : m), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1])
    .map(([team, n]) => ({ team, pct: Math.round((n / lineups.length) * 100) }));
  const ranked = lineups.map((l, i) => ({ l, n: i + 1 })).sort((a, b) => b.l.projected - a.l.projected);
  const avg = lineups.reduce((sum, l) => sum + l.projected, 0) / lineups.length;
  const mostUsed = [...exposure]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([id, n]) => ({ p: players.get(id), pct: Math.round((n / lineups.length) * 100) }))
    .filter((x): x is { p: PoolPlayer; pct: number } => !!x.p);

  return (
    <section aria-label="Built lineups" className="mt-8 rounded-3xl border border-slate-800 bg-slate-900/70 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h2 className="text-2xl font-bold">Built lineups ({lineups.length})</h2>
          <p className="text-xs text-slate-500">
            Best {ranked[0].l.projected.toFixed(1)} · average {avg.toFixed(1)} · lowest {ranked.at(-1)!.l.projected.toFixed(1)} projected points ·{" "}
            {lineups.filter((l) => l.players.filter((p) => p.position === "TE").length === 2).length} with 2 TEs
          </p>
        </div>
        <button onClick={onExport} className="rounded-full bg-emerald-400 px-4 py-2 text-sm font-bold text-slate-950 hover:bg-emerald-300">
          Export all
        </button>
        <button onClick={onClear} className="rounded-full border border-slate-700 px-4 py-2 text-sm font-semibold hover:border-slate-500">
          Clear
        </button>
      </div>

      {warnings.length > 0 && <p className="mt-3 rounded-xl bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{warnings.join(" ")}</p>}

      {stackShare.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs uppercase tracking-[0.18em] text-slate-500">QB stacks by team: share of lineups</p>
          <div className="flex flex-wrap gap-2">
            {stackShare.map(({ team, pct }) => (
              <span key={team} className="rounded-full border border-slate-700 bg-slate-950/70 px-3 py-1 text-xs">
                <span className="font-semibold text-white">{team}</span>
                <span className="ml-2 text-amber-300">{pct}%</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4">
        <p className="mb-2 text-xs uppercase tracking-[0.18em] text-slate-500">Exposure: share of lineups each player is in</p>
        <div className="flex flex-wrap gap-2">
          {mostUsed.map(({ p, pct }) => (
            <span key={p.id} className="rounded-full border border-slate-700 bg-slate-950/70 px-3 py-1 text-xs">
              <span className="font-semibold text-white">{p.name}</span>
              <span className="ml-1 text-slate-500">{p.position}</span>
              <span className="ml-2 text-amber-300">{pct}%</span>
            </span>
          ))}
        </div>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {ranked.map(({ l, n }) => {
          const slots = assignSlots(l.players) ?? [];
          const stack = stacks.at(n - 1);
          return (
            <article key={n} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
              <div className="mb-2 flex items-baseline justify-between">
                <p className="font-bold">Lineup {n}</p>
                <p className="text-sm">
                  <span className="font-bold text-emerald-300">{l.projected.toFixed(1)} pts</span>
                  <span className="ml-2 text-slate-500">{money(l.salary)}</span>
                  {showOwnership && <span className="ml-2 text-xs text-slate-500">Own {totalOwnership(l.players).toFixed(0)}%</span>}
                </p>
              </div>
              {(stack || l.players.filter((p) => p.position === "TE").length === 2) && (
                <p className="mb-2 text-xs text-sky-300">
                  {stack?.label}
                  {l.players.filter((p) => p.position === "TE").length === 2 && (
                    <span className="ml-2 rounded-full border border-sky-400/40 px-1.5 text-[10px]">2 TE</span>
                  )}
                </p>
              )}
              <ol className="space-y-0.5 text-sm">
                {ROSTER_SLOTS.map((slot, i) => {
                  const p = slots[i];
                  return (
                    <li key={`${slot}-${i}`} className="flex gap-2">
                      <span className="w-9 shrink-0 text-xs font-bold leading-5 text-slate-500">{slot}</span>
                      <span className="min-w-0 flex-1 truncate">{p?.name ?? "—"}</span>
                      <span className="shrink-0 text-xs leading-5 text-slate-500">{p ? `${p.team} · ${money(p.salary)}` : ""}</span>
                    </li>
                  );
                })}
              </ol>
              <button
                onClick={() => onLoad(l.players.map((p) => p.id))}
                className="mt-3 w-full rounded-full border border-slate-700 px-3 py-1.5 text-xs font-semibold hover:border-emerald-400 hover:text-emerald-300"
              >
                Load into editor
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
