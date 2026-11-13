"use client";

import { useState, type FocusEvent, type MouseEvent } from "react";
import { ordinal } from "@/lib/format";
import type { GameLogEntry, OffensePosition, PoolPlayer, TeamProfile } from "@/lib/types";

/**
 * Hover cards shared by the Projections tab and the Lineup builder:
 *  - opponent: hover the opponent to see the defense's ranks vs each position (the offense, for a DST)
 *  - log: hover a player to see his recent game log
 */

type Kind = "opponent" | "log";
export type Hover = { kind: Kind; player: PoolPlayer; x: number; y: number };

const OFFENSE: OffensePosition[] = ["QB", "RB", "WR", "TE"];
const CARD_WIDTH = { opponent: 300, log: 380 };

/** Hover/focus/tap handlers for a trigger element, and the card currently shown. */
export function useHoverCards() {
  const [hover, setHover] = useState<Hover | null>(null);

  function show(kind: Kind, player: PoolPlayer, el: HTMLElement) {
    const rect = el.getBoundingClientRect();
    setHover({ kind, player, x: rect.right + 12, y: rect.top });
  }

  /** Spread onto a <button>: hover or focus shows the card, tap toggles it (touch screens). */
  function bind(kind: Kind, player: PoolPlayer) {
    return {
      onMouseEnter: (e: MouseEvent<HTMLElement>) => show(kind, player, e.currentTarget),
      onMouseLeave: () => setHover(null),
      onFocus: (e: FocusEvent<HTMLElement>) => show(kind, player, e.currentTarget),
      onBlur: () => setHover(null),
      onClick: (e: MouseEvent<HTMLElement>) =>
        hover?.kind === kind && hover.player.id === player.id ? setHover(null) : show(kind, player, e.currentTarget),
    };
  }

  return { hover, bind };
}

/** The card for the current hover, if any. */
export function HoverCards({ hover, teams }: { hover: Hover | null; teams: Record<string, TeamProfile> | undefined }) {
  if (!hover) return null;
  const width = CARD_WIDTH[hover.kind];
  const left = typeof window !== "undefined" ? Math.min(hover.x, window.innerWidth - width - 12) : hover.x;
  const top = typeof window !== "undefined" ? Math.min(hover.y, window.innerHeight - 360) : hover.y;
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 rounded-2xl border border-slate-700 bg-slate-950/95 p-4 text-sm shadow-2xl"
      style={{ left: Math.max(12, left), top: Math.max(12, top), width }}
    >
      {hover.kind === "opponent" ? (
        <OpponentCard player={hover.player} teams={teams ?? {}} />
      ) : (
        <GameLogCard player={hover.player} />
      )}
    </div>
  );
}

/** Green for a soft matchup, red for a tough one. `goodIsHigh`: rank 1 helps the player. */
function rankTone(rank: number, count: number, goodIsHigh: boolean) {
  const third = Math.ceil(count / 3);
  const good = goodIsHigh ? rank <= third : rank > count - third;
  const bad = goodIsHigh ? rank > count - third : rank <= third;
  return good ? "text-emerald-300" : bad ? "text-rose-300" : "text-slate-300";
}

function OpponentCard({ player, teams }: { player: PoolPlayer; teams: Record<string, TeamProfile> }) {
  const opp = player.opponent ? teams[player.opponent] : undefined;
  const teamCount = Object.keys(teams).length;
  if (!opp) return <p className="text-slate-400">No season data for {player.opponent ?? "this opponent"} yet.</p>;

  if (player.position === "DST") {
    return (
      <>
        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{player.name} vs</p>
        <p className="mb-3 text-lg font-bold">
          {opp.team} offense <span className="text-xs font-normal text-slate-500">{opp.games} games</span>
        </p>
        <StatRow label="Points / game" value={opp.offense.points} rank={opp.offense.ranks.points} count={teamCount} goodIsHigh={false} />
        <StatRow label="Pass yds / game" value={opp.offense.passYds} rank={opp.offense.ranks.passYds} count={teamCount} goodIsHigh={false} />
        <StatRow label="Rush yds / game" value={opp.offense.rushYds} rank={opp.offense.ranks.rushYds} count={teamCount} goodIsHigh={false} />
        <StatRow label="DK pts allowed to DSTs" value={opp.offense.dstPointsAllowed} rank={opp.offense.ranks.dstPointsAllowed} count={teamCount} goodIsHigh />
        <p className="mt-3 text-[11px] text-slate-500">Rank 1 = most in the league. Green = good for this defense.</p>
      </>
    );
  }

  return (
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

type LogColumn = { label: string; title: string; value: (g: GameLogEntry) => number | undefined; decimals?: number };

/** Stat columns for each position's game log. */
const LOG_COLUMNS: Record<PoolPlayer["position"], LogColumn[]> = {
  QB: [
    { label: "Att", title: "Pass attempts", value: (g) => g.passAtt },
    { label: "PaYd", title: "Passing yards", value: (g) => g.passYds },
    { label: "TD", title: "Passing TDs", value: (g) => g.passTds },
    { label: "INT", title: "Interceptions", value: (g) => g.ints },
    { label: "RuYd", title: "Rushing yards", value: (g) => g.rushYds },
  ],
  RB: [
    { label: "Car", title: "Carries", value: (g) => g.rushAtt },
    { label: "RuYd", title: "Rushing yards", value: (g) => g.rushYds },
    { label: "Tgt", title: "Targets", value: (g) => g.targets },
    { label: "Rec", title: "Receptions", value: (g) => g.receptions },
    { label: "ReYd", title: "Receiving yards", value: (g) => g.recYds },
    { label: "TD", title: "Rushing + receiving TDs", value: (g) => g.tds },
  ],
  WR: [
    { label: "Tgt", title: "Targets", value: (g) => g.targets },
    { label: "Rec", title: "Receptions", value: (g) => g.receptions },
    { label: "Yds", title: "Receiving yards", value: (g) => g.recYds },
    { label: "TD", title: "Rushing + receiving TDs", value: (g) => g.tds },
  ],
  TE: [
    { label: "Tgt", title: "Targets", value: (g) => g.targets },
    { label: "Rec", title: "Receptions", value: (g) => g.receptions },
    { label: "Yds", title: "Receiving yards", value: (g) => g.recYds },
    { label: "TD", title: "Rushing + receiving TDs", value: (g) => g.tds },
  ],
  DST: [
    { label: "Sck", title: "Sacks", value: (g) => g.sacks, decimals: 1 },
    { label: "TO", title: "Takeaways (INT + fumble recoveries)", value: (g) => g.takeaways },
    { label: "PA", title: "Points allowed", value: (g) => g.pointsAllowed },
  ],
};

function GameLogCard({ player }: { player: PoolPlayer }) {
  const log = player.research?.gameLog ?? [];
  const columns = LOG_COLUMNS[player.position];
  const currentSeason = Math.max(...log.map((g) => g.season));
  const fmt = (v: number | undefined, decimals = 0) => (v === undefined ? "—" : decimals ? v.toFixed(decimals) : String(Math.round(v)));
  const avg = (pick: (g: GameLogEntry) => number | undefined) => {
    const values = log.map(pick).filter((v): v is number => v !== undefined);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
  };

  return (
    <>
      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
        {player.position} · {player.team}
      </p>
      <p className="mb-2 text-lg font-bold">
        {player.name} <span className="text-xs font-normal text-slate-500">last {log.length} games</span>
      </p>
      {log.length === 0 ? (
        <p className="text-slate-400">No recent games on record.</p>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-[0.12em] text-slate-500">
            <tr>
              <th className="pb-1 text-left font-medium">Wk</th>
              <th className="pb-1 text-left font-medium">Opp</th>
              <th className="pb-1 text-right font-medium" title="DraftKings points">DK</th>
              {columns.map((c) => (
                <th key={c.label} className="pb-1 text-right font-medium" title={c.title}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {log.map((g) => (
              <tr key={`${g.season}-${g.week}`} className="border-t border-slate-800">
                <td className="py-1 text-slate-400">
                  {g.season !== currentSeason ? <span className="text-slate-500">&apos;{String(g.season).slice(2)} </span> : null}
                  {g.week}
                </td>
                <td className="py-1 text-slate-300">
                  {g.home === false ? "@" : g.home === true ? "vs" : ""} {g.opponent}
                </td>
                <td className="py-1 text-right font-semibold text-emerald-300">{g.points.toFixed(1)}</td>
                {columns.map((c) => (
                  <td key={c.label} className="py-1 text-right text-slate-200">
                    {fmt(c.value(g), c.decimals)}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="border-t border-slate-700 text-slate-400">
              <td className="py-1" colSpan={2}>
                Avg
              </td>
              <td className="py-1 text-right font-semibold text-emerald-300">{avg((g) => g.points)?.toFixed(1)}</td>
              {columns.map((c) => (
                <td key={c.label} className="py-1 text-right">
                  {fmt(avg(c.value), 1)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      )}
      {log.some((g) => g.season !== currentSeason) && (
        <p className="mt-2 text-[11px] text-slate-500">&apos;{String(currentSeason - 1).slice(2)} marks last season&apos;s games.</p>
      )}
    </>
  );
}
