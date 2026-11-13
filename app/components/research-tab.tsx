"use client";

import { useMemo, useState } from "react";
import { StartButton } from "@/app/components/lineup-tab";
import { HoverCards, useHoverCards } from "@/app/components/hover-cards";
import { money, opponentLabel, pct } from "@/lib/format";
import type { StarterControls } from "@/lib/starters";
import type { PlayerResearch, PoolPlayer, SlateData } from "@/lib/types";

type PositionFilter = "ALL" | "QB" | "RB" | "WR" | "TE" | "DST";
const POSITION_FILTERS: PositionFilter[] = ["ALL", "QB", "RB", "WR", "TE", "DST"];
const PAGE_SIZE = 60;

type Column = {
  key: string;
  label: string;
  title: string;
  value: (p: PoolPlayer, r: PlayerResearch) => number | null | undefined;
  format?: (v: number) => string;
};

const fmt1 = (v: number) => v.toFixed(1);

const BASE_COLUMNS: Column[] = [
  { key: "salary", label: "Salary", title: "DraftKings salary", value: (p) => p.salary, format: (v) => money(v) },
  { key: "projected", label: "Proj", title: "Final projection (DK points)", value: (p) => p.projected, format: fmt1 },
  { key: "base", label: "Base", title: "Projection before matchup, Vegas and role adjustments", value: (_, r) => r.baseProjection, format: fmt1 },
  { key: "weighted", label: "Wtd", title: "Recency-weighted DK points per game (incl. last season at reduced weight)", value: (_, r) => r.weightedAvg, format: fmt1 },
  { key: "season", label: "Szn", title: "DK points per game this season", value: (_, r) => r.seasonAvg, format: fmt1 },
  { key: "last3", label: "L3", title: "DK points per game, last 3 games", value: (_, r) => r.last3Avg, format: fmt1 },
  { key: "games", label: "G", title: "Games this season used by the model", value: (_, r) => r.games, format: (v) => String(v) },
];

const STAT_COLUMNS: Record<PositionFilter, Column[]> = {
  ALL: [
    { key: "passYds", label: "Pass Yds", title: "Passing yards per game", value: (_, r) => r.passYds, format: fmt1 },
    { key: "rushYds", label: "Rush Yds", title: "Rushing yards per game", value: (_, r) => r.rushYds, format: fmt1 },
    { key: "recYds", label: "Rec Yds", title: "Receiving yards per game", value: (_, r) => r.recYds, format: fmt1 },
    { key: "targets", label: "Tgt", title: "Targets per game", value: (_, r) => r.targets, format: fmt1 },
  ],
  QB: [
    { key: "passAtt", label: "Att", title: "Pass attempts per game", value: (_, r) => r.passAtt, format: fmt1 },
    { key: "passYds", label: "Pass Yds", title: "Passing yards per game", value: (_, r) => r.passYds, format: fmt1 },
    { key: "passTds", label: "Pass TD", title: "Passing TDs per game", value: (_, r) => r.passTds, format: (v) => v.toFixed(2) },
    { key: "rushYds", label: "Rush Yds", title: "Rushing yards per game", value: (_, r) => r.rushYds, format: fmt1 },
  ],
  RB: [
    { key: "rushAtt", label: "Att", title: "Rush attempts per game", value: (_, r) => r.rushAtt, format: fmt1 },
    { key: "rushYds", label: "Rush Yds", title: "Rushing yards per game", value: (_, r) => r.rushYds, format: fmt1 },
    { key: "targets", label: "Tgt", title: "Targets per game", value: (_, r) => r.targets, format: fmt1 },
    { key: "recYds", label: "Rec Yds", title: "Receiving yards per game", value: (_, r) => r.recYds, format: fmt1 },
  ],
  WR: [
    { key: "targets", label: "Tgt", title: "Targets per game", value: (_, r) => r.targets, format: fmt1 },
    { key: "receptions", label: "Rec", title: "Receptions per game", value: (_, r) => r.receptions, format: fmt1 },
    { key: "recYds", label: "Rec Yds", title: "Receiving yards per game", value: (_, r) => r.recYds, format: fmt1 },
    { key: "rushYds", label: "Rush Yds", title: "Rushing yards per game", value: (_, r) => r.rushYds, format: fmt1 },
  ],
  TE: [
    { key: "targets", label: "Tgt", title: "Targets per game", value: (_, r) => r.targets, format: fmt1 },
    { key: "receptions", label: "Rec", title: "Receptions per game", value: (_, r) => r.receptions, format: fmt1 },
    { key: "recYds", label: "Rec Yds", title: "Receiving yards per game", value: (_, r) => r.recYds, format: fmt1 },
  ],
  DST: [
    { key: "sacks", label: "Sacks", title: "Sacks per game", value: (_, r) => r.sacks, format: fmt1 },
    { key: "takeaways", label: "TO", title: "Takeaways (INT + fumble recoveries) per game", value: (_, r) => r.takeaways, format: fmt1 },
    { key: "pointsAllowed", label: "PA", title: "Points allowed per game", value: (_, r) => r.pointsAllowed, format: fmt1 },
  ],
};

/** FieldGoal's own projection (Proj may be ETR or a blend, depending on the Projections setting). */
const fieldgoalProj = (p: PoolPlayer) => p.fieldgoal?.projected ?? p.projected;
const pctCol = (v: number) => `${v.toFixed(1)}%`;

/** Columns that don't depend on FieldGoal's research data. */
const ALWAYS_SHOWN = new Set(["salary", "etr", "etrCeil", "ownLarge", "ownSmall", "weather"]);

/** Shown when ETR projections are loaded in this browser. */
const ETR_COLUMNS: Column[] = [
  { key: "fg", label: "FG", title: "FieldGoal's projection", value: (p) => (p.projected > 0 || p.fieldgoal ? fieldgoalProj(p) : null), format: fmt1 },
  { key: "etr", label: "ETR", title: "Establish The Run's DraftKings projection", value: (p) => p.etr?.projected, format: fmt1 },
  {
    key: "diff",
    label: "Diff",
    title: "ETR minus FieldGoal: positive means ETR is higher",
    value: (p) => (p.etr && (p.projected > 0 || p.fieldgoal) ? Math.round((p.etr.projected - fieldgoalProj(p)) * 10) / 10 : null),
    format: (v) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1)),
  },
  { key: "etrCeil", label: "ETR Ceil", title: "ETR's ceiling", value: (p) => p.etr?.ceiling, format: fmt1 },
  { key: "ownLarge", label: "Own LF", title: "ETR projected ownership, large-field contests", value: (p) => p.etr?.ownLarge, format: pctCol },
  { key: "ownSmall", label: "Own SF", title: "ETR projected ownership, small-field contests", value: (p) => p.etr?.ownSmall, format: pctCol },
];

const FACTOR_COLUMNS: Column[] = [
  { key: "matchup", label: "Matchup", title: "Opponent adjustment vs. this position", value: (_, r) => r.matchupFactor, format: pct },
  { key: "vegas", label: "Vegas", title: "Implied team total vs. team scoring average (DST: opponent's implied total)", value: (_, r) => r.vegasFactor, format: pct },
  { key: "implied", label: "Implied", title: "Implied team total (DST: opponent's)", value: (_, r) => r.impliedTotal, format: fmt1 },
  {
    key: "weather",
    label: "Weather",
    title: "Estimated weather effect at kickoff (2023–26 results). For awareness only: not applied to projections.",
    value: (p) => p.weatherImpact?.pct,
  },
];

/** Stand-in research for unprojected players so the table can render them. */
const EMPTY_RESEARCH: PlayerResearch = {
  games: 0,
  seasonAvg: 0,
  last3Avg: 0,
  weightedAvg: 0,
  salaryPrior: null,
  baseProjection: 0,
  matchupFactor: 1,
  vegasFactor: null,
  impliedTotal: null,
  roleFactor: 1,
};

export default function ResearchTab({
  slate,
  showUnprojected,
  starterControls,
}: {
  slate: SlateData;
  showUnprojected: boolean;
  starterControls: StarterControls;
}) {
  const [position, setPosition] = useState<PositionFilter>("ALL");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: "projected", desc: true });
  const [visible, setVisible] = useState(PAGE_SIZE);
  const { hover, bind } = useHoverCards();

  const hasEtr = slate.players.some((p) => p.etr);
  const columns = useMemo(() => {
    if (!hasEtr) return [...BASE_COLUMNS, ...STAT_COLUMNS[position], ...FACTOR_COLUMNS];
    // Proj, then the FieldGoal vs ETR comparison, then the rest.
    const [salary, projected, ...rest] = BASE_COLUMNS;
    return [salary, projected, ...ETR_COLUMNS, ...rest, ...STAT_COLUMNS[position], ...FACTOR_COLUMNS];
  }, [position, hasEtr]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const col = columns.find((c) => c.key === sort.key);
    const source = showUnprojected ? [...slate.players, ...(slate.unprojected ?? [])] : slate.players;
    const list = source.filter(
      (p) =>
        (p.research || p.projected === 0 || p.etr) &&
        (position === "ALL" || p.position === position) &&
        (!q || p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q)),
    );
    const dir = sort.desc ? -1 : 1;
    return list.sort((a, b) => {
      if (sort.key === "name") return a.name.localeCompare(b.name) * dir;
      const va = col?.value(a, a.research ?? EMPTY_RESEARCH) ?? -Infinity;
      const vb = col?.value(b, b.research ?? EMPTY_RESEARCH) ?? -Infinity;
      return (va - vb) * dir;
    });
  }, [slate.players, slate.unprojected, showUnprojected, position, query, sort, columns]);

  if (!slate.players.some((p) => p.research)) {
    return (
      <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-8 text-center text-slate-400">
        Projection inputs come from the FieldGoal model on nflverse data, which isn&apos;t the active source right now ({slate.source}).
      </section>
    );
  }

  function toggleSort(key: string) {
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== "name" }));
  }

  return (
    <section className="min-w-0 overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/70">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-4 py-4">
        <div className="mr-auto">
          <h2 className="text-2xl font-bold">Projection inputs</h2>
          <p className="text-xs text-slate-500">Per-game stats this season. Hover (or tap) a player for his recent games, or the opponent for its ranks by position.</p>
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setVisible(PAGE_SIZE);
          }}
          placeholder="Search player or team"
          className="w-48 rounded-full border border-slate-700 bg-slate-950 px-4 py-2 text-sm outline-none focus:border-emerald-400"
        />
      </div>
      <div className="flex flex-wrap gap-2 border-b border-slate-800 px-4 py-3">
        {POSITION_FILTERS.map((pos) => (
          <button
            key={pos}
            onClick={() => {
              setPosition(pos);
              setVisible(PAGE_SIZE);
            }}
            className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] ${
              position === pos ? "border-emerald-400 bg-emerald-400 text-slate-950" : "border-slate-700 text-slate-300 hover:border-slate-500"
            }`}
          >
            {pos}
          </button>
        ))}
        <span className="ml-auto self-center text-xs text-slate-500">{rows.length} players</span>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full whitespace-nowrap text-left text-sm text-slate-200">
          <thead className="bg-slate-950/80 text-xs text-slate-400">
            <tr>
              <th className="px-3 py-3">
                <button onClick={() => toggleSort("name")} className={`uppercase tracking-[0.14em] hover:text-white ${sort.key === "name" ? "text-emerald-300" : ""}`}>
                  Player{sort.key === "name" ? (sort.desc ? " ↓" : " ↑") : ""}
                </button>
              </th>
              <th className="px-3 py-3 uppercase tracking-[0.14em]">Opp</th>
              {columns.map((c) => (
                <th key={c.key} className="px-3 py-3" title={c.title}>
                  <button
                    onClick={() => toggleSort(c.key)}
                    className={`uppercase tracking-[0.14em] hover:text-white ${sort.key === c.key ? "text-emerald-300" : ""}`}
                  >
                    {c.label}
                    {sort.key === c.key ? (sort.desc ? " ↓" : " ↑") : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, visible).map((p) => {
              const r = p.research ?? EMPTY_RESEARCH;
              const unprojected = !p.research;
              return (
                <tr key={p.id} className="border-t border-slate-800 hover:bg-slate-800/50">
                  <td className="px-3 py-2">
                    <button className="text-left" {...bind("log", p)}>
                      <span className="font-semibold text-white underline decoration-slate-600 decoration-dotted underline-offset-4">{p.name}</span>
                      <span className="block text-xs text-slate-500">
                        {p.position} · {p.team}
                        {p.injury && <span className="ml-1 font-semibold text-amber-300">{p.injury}</span>}
                        {r.roleFactor < 1 && <span className="ml-1 text-slate-400">backup</span>}
                        {unprojected && p.projected === 0 && <span className="ml-1 text-slate-400">no projection</span>}
                        {unprojected && p.projected > 0 && p.etr && (
                          <span title="Only Establish The Run projects this player" className="ml-1 text-violet-300">
                            ETR only
                          </span>
                        )}
                        {hasEtr && !p.etr && p.projected > 0 && (
                          <span title="Establish The Run's file doesn't include this player (often means he's not expected to play)" className="ml-1 text-violet-300">
                            not in ETR
                          </span>
                        )}
                      </span>
                    </button>
                    {r.limitedData && (
                      <p
                        className="mt-1 max-w-[260px] whitespace-normal text-[11px] text-sky-300"
                        title="Projection = past real games blended with the role baseline, then the matchup and Vegas adjustments"
                      >
                        Limited data ({r.limitedData.source === "manual" ? "marked starting" : "Sleeper depth chart"}):{" "}
                        {r.limitedData.historyGames
                          ? `${r.limitedData.historyGames} real game${r.limitedData.historyGames > 1 ? "s" : ""} avg ${r.limitedData.historyAvg}`
                          : "no past games"}
                        , role {r.limitedData.roleBaseline}
                      </p>
                    )}
                    {r.manualStarter && !r.limitedData && <p className="mt-1 text-[11px] text-sky-300">Marked starting</p>}
                    {starterControls.canMark(p) && (
                      <div className="mt-1">
                        <StartButton marked={starterControls.isMarked(p)} pending={starterControls.pending} onClick={() => starterControls.toggle(p)} />
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-400">
                    {p.opponent ? (
                      <button className="underline decoration-slate-600 decoration-dotted underline-offset-4 hover:text-white" {...bind("opponent", p)}>
                        {opponentLabel(p)}
                      </button>
                    ) : (
                      opponentLabel(p)
                    )}
                  </td>
                  {columns.map((c) => {
                    const v = c.value(p, r);
                    const isFactor = c.key === "matchup" || c.key === "vegas";
                    const tone = isFactor && typeof v === "number" ? (v > 1.02 ? "text-emerald-300" : v < 0.98 ? "text-rose-300" : "text-slate-400") : "";
                    if (c.key === "weather") {
                      const w = p.weatherImpact;
                      return (
                        <td
                          key={c.key}
                          title={w?.detail}
                          className={`px-3 py-2 text-xs ${(w?.pct ?? 0) < 0 ? "text-rose-300" : (w?.pct ?? 0) > 0 ? "text-emerald-300" : "text-slate-500"}`}
                        >
                          {w?.label ?? "—"}
                        </td>
                      );
                    }
                    // Players without FieldGoal research still show salary, projection and ETR's numbers.
                    const blank = unprojected && !ALWAYS_SHOWN.has(c.key) && !(c.key === "projected" && p.projected > 0);
                    return (
                      <td key={c.key} className={`px-3 py-2 ${c.key === "projected" ? "font-bold text-emerald-300" : tone || "text-slate-300"}`}>
                        {blank || v === null || v === undefined ? "—" : c.format ? c.format(v) : v}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="px-4 py-10 text-center text-slate-500">No players match these filters.</p>}
      </div>
      {visible < rows.length && (
        <button onClick={() => setVisible((v) => v + PAGE_SIZE)} className="w-full border-t border-slate-800 py-3 text-sm text-emerald-300 hover:bg-slate-800/50">
          Show more ({rows.length - visible} remaining)
        </button>
      )}

      <HoverCards hover={hover} teams={slate.teams} />
    </section>
  );
}
