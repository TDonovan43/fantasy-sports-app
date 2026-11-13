"use client";

import { useMemo, useState } from "react";
import { StartButton } from "@/app/components/lineup-tab";
import { money, ordinal, pct } from "@/lib/format";
import type { StarterControls } from "@/lib/starters";
import type { OffensePosition, PlayerResearch, PoolPlayer, SlateData, TeamProfile } from "@/lib/types";

type PositionFilter = "ALL" | "QB" | "RB" | "WR" | "TE" | "DST";
const POSITION_FILTERS: PositionFilter[] = ["ALL", "QB", "RB", "WR", "TE", "DST"];
const OFFENSE: OffensePosition[] = ["QB", "RB", "WR", "TE"];
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
const ALWAYS_SHOWN = new Set(["salary", "etr", "etrCeil", "ownLarge", "ownSmall"]);

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
];

/** Green for a soft matchup, red for a tough one. `goodIsHigh`: rank 1 helps the player. */
function rankTone(rank: number, count: number, goodIsHigh: boolean) {
  const third = Math.ceil(count / 3);
  const good = goodIsHigh ? rank <= third : rank > count - third;
  const bad = goodIsHigh ? rank > count - third : rank <= third;
  return good ? "text-emerald-300" : bad ? "text-rose-300" : "text-slate-300";
}

type Hover = { player: PoolPlayer; x: number; y: number };

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
  const [hover, setHover] = useState<Hover | null>(null);

  const teams = slate.teams ?? {};
  const teamCount = Object.keys(teams).length;
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

  function showCard(player: PoolPlayer, el: HTMLElement) {
    const rect = el.getBoundingClientRect();
    setHover({ player, x: rect.right + 12, y: rect.top });
  }

  return (
    <section className="min-w-0 overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/70">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-4 py-4">
        <div className="mr-auto">
          <h2 className="text-2xl font-bold">Projection inputs</h2>
          <p className="text-xs text-slate-500">Per-game stats this season. Hover (or tap) a player to see the opposing unit.</p>
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
                    <button
                      className="text-left"
                      onMouseEnter={(e) => showCard(p, e.currentTarget)}
                      onMouseLeave={() => setHover(null)}
                      onFocus={(e) => showCard(p, e.currentTarget)}
                      onBlur={() => setHover(null)}
                      onClick={(e) => (hover?.player.id === p.id ? setHover(null) : showCard(p, e.currentTarget))}
                    >
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
                  <td className="px-3 py-2 text-slate-400">{p.opponent ?? "—"}</td>
                  {columns.map((c) => {
                    const v = c.value(p, r);
                    const isFactor = c.key === "matchup" || c.key === "vegas";
                    const tone = isFactor && typeof v === "number" ? (v > 1.02 ? "text-emerald-300" : v < 0.98 ? "text-rose-300" : "text-slate-400") : "";
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

      {hover && <OpponentCard hover={hover} teams={teams} teamCount={teamCount} />}
    </section>
  );
}

function OpponentCard({ hover, teams, teamCount }: { hover: Hover; teams: Record<string, TeamProfile>; teamCount: number }) {
  const { player } = hover;
  const opp = player.opponent ? teams[player.opponent] : undefined;
  const width = 300;
  const left = typeof window !== "undefined" ? Math.min(hover.x, window.innerWidth - width - 12) : hover.x;
  const top = typeof window !== "undefined" ? Math.min(hover.y, window.innerHeight - 340) : hover.y;

  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 rounded-2xl border border-slate-700 bg-slate-950/95 p-4 text-sm shadow-2xl"
      style={{ left: Math.max(12, left), top: Math.max(12, top), width }}
    >
      {!opp ? (
        <p className="text-slate-400">No season data for {player.opponent ?? "this opponent"} yet.</p>
      ) : player.position === "DST" ? (
        <>
          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{player.name} vs</p>
          <p className="mb-3 text-lg font-bold">
            {opp.team} offense <span className="text-xs font-normal text-slate-500">{opp.games} games</span>
          </p>
          <StatRow label="Points / game" value={opp.offense.points} rank={opp.offense.ranks.points} count={teamCount} goodIsHigh={false} />
          <StatRow label="Pass yds / game" value={opp.offense.passYds} rank={opp.offense.ranks.passYds} count={teamCount} goodIsHigh={false} />
          <StatRow label="Rush yds / game" value={opp.offense.rushYds} rank={opp.offense.ranks.rushYds} count={teamCount} goodIsHigh={false} />
          <StatRow
            label="DK pts allowed to DSTs"
            value={opp.offense.dstPointsAllowed}
            rank={opp.offense.ranks.dstPointsAllowed}
            count={teamCount}
            goodIsHigh
          />
          <p className="mt-3 text-[11px] text-slate-500">Rank 1 = most in the league. Green = good for this defense.</p>
        </>
      ) : (
        <>
          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{player.name} vs</p>
          <p className="mb-3 text-lg font-bold">
            {opp.team} defense <span className="text-xs font-normal text-slate-500">{opp.games} games</span>
          </p>
          <p className="mb-1 text-[11px] uppercase tracking-[0.16em] text-slate-500">DK points allowed / game</p>
          {OFFENSE.map((pos) => (
            <StatRow
              key={pos}
              label={`to ${pos}s`}
              value={opp.defense.dkAllowed[pos]}
              rank={opp.defense.ranks.dkAllowed[pos]}
              count={teamCount}
              goodIsHigh
              highlight={pos === player.position}
            />
          ))}
          <div className="my-2 border-t border-slate-800" />
          <StatRow label="Points allowed / game" value={opp.defense.pointsAllowed} rank={opp.defense.ranks.pointsAllowed} count={teamCount} goodIsHigh />
          <StatRow label="Pass yds allowed / game" value={opp.defense.passYdsAllowed} rank={opp.defense.ranks.passYdsAllowed} count={teamCount} goodIsHigh />
          <StatRow label="Rush yds allowed / game" value={opp.defense.rushYdsAllowed} rank={opp.defense.ranks.rushYdsAllowed} count={teamCount} goodIsHigh />
          <p className="mt-3 text-[11px] text-slate-500">Rank 1 = allows the most. Green = softer matchup.</p>
        </>
      )}
    </div>
  );
}

function StatRow({
  label,
  value,
  rank,
  count,
  goodIsHigh,
  highlight = false,
}: {
  label: string;
  value: number;
  rank: number;
  count: number;
  goodIsHigh: boolean;
  highlight?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between rounded-lg px-2 py-1 ${highlight ? "bg-emerald-500/10 ring-1 ring-emerald-400/40" : ""}`}>
      <span className={highlight ? "font-semibold text-white" : "text-slate-400"}>{label}</span>
      <span>
        <span className="font-semibold text-white">{value.toFixed(1)}</span>
        <span className={`ml-2 inline-block w-10 text-right text-xs ${rankTone(rank, count, goodIsHigh)}`}>{ordinal(rank)}</span>
      </span>
    </div>
  );
}
