"use client";

import { useEffect, useMemo, useState } from "react";
import { HoverCards, useHoverCards } from "@/app/components/hover-cards";
import { isInactive } from "@/lib/dk-salaries";
import { OWNERSHIP_TARGET, isOwnershipMode, type OwnershipMode } from "@/lib/ownership-weighting";
import { formatKickoff, formatLine, impliedTotals, money, opponentLabel } from "@/lib/format";
import { SCORING_TARGETS, SCORING_TARGET_LABEL, isScoringTarget, targetPoints, type ScoringTarget } from "@/lib/scoring-target";
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

/** Which ETR ownership projection to use: large-field GPPs or small-field contests. */
type OwnField = "large" | "small";
const OWN_FIELD_KEY = "fieldgoal-own-field";
const OWN_FIELD_LABEL: Record<OwnField, string> = { large: "large field", small: "small field" };

/** ETR projected ownership (%) for the chosen field, or null if ETR has none. */
function ownOf(p: PoolPlayer, field: OwnField): number | null {
  const v = field === "small" ? p.etr?.ownSmall : p.etr?.ownLarge;
  return typeof v === "number" ? v : null;
}

/** Sum of ETR projected ownership across a lineup, in %. */
function totalOwnership(players: PoolPlayer[], field: OwnField) {
  return players.reduce((sum, p) => sum + (ownOf(p, field) ?? 0), 0);
}

/** Sort value for a column (ETR columns sort players without ETR data last). */
function sortValue(p: PoolPlayer, key: Exclude<SortKey, "name">, field: OwnField) {
  if (key === "etr") return p.etr?.projected ?? -1;
  if (key === "own") return ownOf(p, field) ?? -1;
  return p[key];
}
type PositionFilter = "ALL" | "QB" | "RB" | "WR" | "TE" | "FLEX" | "DST";

const POSITION_FILTERS: PositionFilter[] = ["ALL", "QB", "RB", "WR", "TE", "FLEX", "DST"];
const POOL_POSITIONS: Position[] = ["QB", "RB", "WR", "TE", "DST"];
/** Players a DK Classic lineup needs at each position, before the FLEX. */
const ROSTER_NEEDS: Record<Position, number> = { QB: 1, RB: 2, WR: 3, TE: 1, DST: 1 };
const FLEX_POSITIONS: Position[] = ["RB", "WR", "TE"];
const PAGE_SIZE = 50;
const TOP_VALUE_POSITIONS: Position[] = ["QB", "RB", "WR", "TE", "DST"];
const RANDOMNESS = { none: 0, low: 0.25, medium: 0.5, high: 1 } as const;
type Randomness = keyof typeof RANDOMNESS;

type ContestType = "large" | "small" | "cash";
/** Starting settings for each kind of contest (rules of thumb; every value stays editable). */
const CONTEST_PRESETS: Record<
  ContestType,
  {
    label: string;
    blurb: string;
    target: ScoringTarget;
    ownField: OwnField;
    ownershipMode: OwnershipMode | null;
    stack: Pick<StackRules, "qbStack" | "bringBack" | "maxPerTeam">;
    randomness: Randomness;
    count: number;
    minUnique: number;
    maxExposurePct: number;
    maxStackExposurePct: number;
  }
> = {
  large: {
    label: "Large-field GPP (top-heavy)",
    blurb: "Chase a rare, high score: ceiling projections, QB + 2 with a bring-back, chalk underweighted, lots of variety.",
    target: "ceiling",
    ownField: "large",
    ownershipMode: "under",
    stack: { qbStack: 2, bringBack: 1, maxPerTeam: 4 },
    randomness: "high",
    count: 20,
    minUnique: 3,
    maxExposurePct: 40,
    maxStackExposurePct: 25,
  },
  small: {
    label: "Small-field GPP (top-heavy)",
    blurb: "A high score with a few pivots: some upside, QB + 1, ownership in line with the small field.",
    target: "upside",
    ownField: "small",
    ownershipMode: "match",
    stack: { qbStack: 1, bringBack: 0, maxPerTeam: 4 },
    randomness: "medium",
    count: 5,
    minUnique: 2,
    maxExposurePct: 60,
    maxStackExposurePct: 60,
  },
  cash: {
    label: "Cash: 50/50, double-up, head-to-head",
    blurb: "Beat half the field: floor projections, no forced stack, chalk is fine, one best lineup.",
    target: "floor",
    ownField: "small",
    ownershipMode: null,
    stack: { qbStack: 0, bringBack: 0, maxPerTeam: 3 },
    randomness: "none",
    count: 1,
    minUnique: 1,
    maxExposurePct: 100,
    maxStackExposurePct: 100,
  },
};
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
  /** Editor players kept in every optimized/built lineup. Players you add are locked; ones the optimizer fills in aren't. */
  const [lockIds, setLockIds] = useState<string[]>([]);
  /** Player pool: positions with picks only use those players in Optimize and Build; the rest use everyone. */
  const [poolIds, setPoolIds] = useState<string[]>([]);
  const [poolOnly, setPoolOnly] = useState(false);
  const poolKey = `fieldgoal-pool-${slate.season}-${slate.week}`;
  const [excludedIds, setExcludedIds] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [multiCount, setMultiCount] = useState(5);
  const [minUnique, setMinUnique] = useState(2);
  const [maxExposurePct, setMaxExposurePct] = useState(60);
  const [randomness, setRandomness] = useState<Randomness>("medium");
  const [built, setBuilt] = useState<(MultiLineupResult & { ownershipMode: OwnershipMode | null; ownField: OwnField }) | null>(null);
  const [stackRules, setStackRules] = useState<StackRules>(DEFAULT_STACK_RULES);
  const [maxStackExposurePct, setMaxStackExposurePct] = useState(40);
  /** Share of built lineups with 2 TEs (a TE in the FLEX); null = the optimizer decides. */
  const [twoTeShare, setTwoTeShare] = useState<number | null>(null);
  const [ownershipMode, setOwnershipMode] = useState<OwnershipMode | null>(null);
  const [ownFieldChoice, setOwnFieldChoice] = useState<OwnField>("large");
  /** What Optimize and Build maximize. */
  const [target, setTarget] = useState<ScoringTarget>("median");
  /** The last contest preset applied (settings may have been changed since). */
  const [contestType, setContestType] = useState<ContestType | null>(null);
  const [busy, setBusy] = useState<null | "optimize" | "build">(null);
  const { hover, bind } = useHoverCards();

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
  const lockedPlayers = lineup.filter((p) => lockIds.includes(p.id));

  // The ownership field choice is remembered in this browser.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(OWN_FIELD_KEY);
      if (saved === "small") setOwnFieldChoice("small");
    } catch {
      // Storage unavailable: default to large field.
    }
  }, []);

  function chooseOwnField(field: OwnField) {
    setOwnFieldChoice(field);
    try {
      localStorage.setItem(OWN_FIELD_KEY, field);
    } catch {
      // Storage unavailable.
    }
  }

  // The pool is saved in this browser for the week.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(poolKey);
      setPoolIds(saved ? (JSON.parse(saved) as string[]) : []);
    } catch {
      // Storage unavailable: the pool just won't persist.
    }
  }, [poolKey]);

  function savePool(ids: string[]) {
    setPoolIds(ids);
    try {
      if (ids.length) localStorage.setItem(poolKey, JSON.stringify(ids));
      else localStorage.removeItem(poolKey);
    } catch {
      // Storage unavailable.
    }
  }

  function togglePool(id: string) {
    savePool(poolIds.includes(id) ? poolIds.filter((x) => x !== id) : [...poolIds, id]);
  }

  /** Pool picks by position (players still in this slate). */
  const poolByPosition = useMemo(() => {
    const map = new Map<Position, PoolPlayer[]>();
    for (const id of poolIds) {
      const p = byId.get(id);
      if (p) map.set(p.position, [...(map.get(p.position) ?? []), p]);
    }
    return map;
  }, [poolIds, byId]);
  const slots = assignSlots(lineup) ?? ROSTER_SLOTS.map(() => null);
  const salaryUsed = lineupSalary(lineup);
  const remaining = slate.salaryCap - salaryUsed;
  const openSlots = slots.filter((s) => s === null).length;
  const hasDst = slate.players.some((p) => p.position === "DST");
  /** ETR projections were uploaded in this browser. */
  const hasEtr = slate.players.some((p) => p.etr);
  const hasLargeOwn = slate.players.some((p) => ownOf(p, "large") !== null);
  const hasSmallOwn = slate.players.some((p) => ownOf(p, "small") !== null);
  const hasOwnership = hasLargeOwn || hasSmallOwn;
  /** The field actually used: the chosen one if ETR has it, else whichever it has. */
  const ownField: OwnField = ownFieldChoice === "small" ? (hasSmallOwn ? "small" : "large") : hasLargeOwn ? "large" : "small";

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
      if (poolOnly && !poolIds.includes(p.id)) return false;
      return true;
    });
    const dir = sort.desc ? -1 : 1;
    const key = sort.key;
    return rows.sort((a, b) => (key === "name" ? a.name.localeCompare(b.name) : sortValue(a, key, ownField) - sortValue(b, key, ownField)) * dir);
  }, [pool, position, selectedTeams, query, sort, poolOnly, poolIds, ownField]);

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
    setLockIds((ids) => [...ids, player.id]);
  }

  function removePlayer(id: string) {
    setLineupIds((ids) => ids.filter((x) => x !== id));
    setLockIds((ids) => ids.filter((x) => x !== id));
    setMessage(null);
  }

  function toggleLock(id: string) {
    setLockIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  /** Replaces the editor; only the given players stay locked. */
  function setEditor(ids: string[], locked: string[]) {
    setLineupIds(ids);
    setLockIds(locked.filter((id) => ids.includes(id)));
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

  function applyContest(type: ContestType | null) {
    setContestType(type);
    if (!type) return;
    const p = CONTEST_PRESETS[type];
    setTarget(p.target);
    chooseOwnField(p.ownField);
    setOwnershipMode(p.ownershipMode);
    setStackRules((r) => ({ ...r, ...p.stack, avoidVsDst: true }));
    setRandomness(p.randomness);
    setMultiCount(p.count);
    setMinUnique(p.minUnique);
    setMaxExposurePct(p.maxExposurePct);
    setMaxStackExposurePct(p.maxStackExposurePct);
  }

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
    return everyone.filter(
      (p) =>
        lockIds.includes(p.id) ||
        ((!selectedTeams || selectedTeams.has(p.team)) && (!poolByPosition.has(p.position) || poolIds.includes(p.id))),
    );
  }

  /** Why the player pool can't fill a lineup, or null if it can. */
  function poolShortfall(): string | null {
    if (!poolByPosition.size) return null;
    const usable = optimizerPool().filter(
      (p) => lockIds.includes(p.id) || (p.salary > 0 && p.projected > 0 && !isInactive(p.injury) && !excludedIds.includes(p.id)),
    );
    const count = (pos: Position) => usable.filter((p) => p.position === pos).length;
    const short = POOL_POSITIONS.filter((pos) => poolByPosition.has(pos) && count(pos) < ROSTER_NEEDS[pos]).map(
      (pos) => `${pos} needs ${ROSTER_NEEDS[pos]}, pool has ${count(pos)}`,
    );
    if (short.length) return `Your player pool can't fill a lineup: ${short.join("; ")}. Add players or clear that position.`;
    if (FLEX_POSITIONS.every((pos) => poolByPosition.has(pos))) {
      const flexTotal = FLEX_POSITIONS.reduce((n, pos) => n + count(pos), 0);
      if (flexTotal < 7) return `Your player pool can't fill the FLEX: RB + WR + TE picks total ${flexTotal}, a lineup needs 7.`;
    }
    // Cheapest lineup the pool allows (locked players first, then the cheapest at each spot, then the FLEX).
    const leftovers: PoolPlayer[] = [];
    let cheapest = 0;
    for (const pos of POOL_POSITIONS) {
      const ranked = usable
        .filter((p) => p.position === pos)
        .sort((a, b) => Number(lockIds.includes(b.id)) - Number(lockIds.includes(a.id)) || a.salary - b.salary);
      cheapest += ranked.slice(0, ROSTER_NEEDS[pos]).reduce((sum, p) => sum + p.salary, 0);
      if (FLEX_POSITIONS.includes(pos)) leftovers.push(...ranked.slice(ROSTER_NEEDS[pos]));
    }
    leftovers.sort((a, b) => Number(lockIds.includes(b.id)) - Number(lockIds.includes(a.id)) || a.salary - b.salary);
    cheapest += leftovers[0]?.salary ?? 0;
    if (cheapest > slate.salaryCap) {
      return `Your player pool is too expensive: its cheapest possible lineup costs ${money(cheapest)}, over the ${money(slate.salaryCap)} cap. Add some cheaper players.`;
    }
    return null;
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
        lockedIds: lockIds,
        excludedIds,
        rules: stackRules,
        target,
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
    const shortfall = poolShortfall();
    if (shortfall) {
      setMessage(shortfall);
      return;
    }
    const count = Math.min(MAX_LINEUPS, Math.max(1, Math.round(multiCount)));
    const free = ROSTER_SLOTS.length - lockIds.length;
    const unique = Math.min(9, Math.max(1, Math.round(minUnique)));
    if (count > 1 && free < unique) {
      setMessage(
        `${lockIds.length} players are locked, so only ${free} spot${free === 1 ? "" : "s"} can change, but each lineup must differ by ${unique}. Unlock some players (click the lock) or lower "Min. different players".`,
      );
      return;
    }
    const settings = {
      count,
      minUnique: Math.min(9, Math.max(1, Math.round(minUnique))),
      maxExposure: Math.min(100, Math.max(10, maxExposurePct)) / 100,
      randomness: RANDOMNESS[randomness],
      // A new seed each click, so "Build" again gives a different set.
      seed: Math.floor(Math.random() * 2 ** 31),
      target,
      ...(ownershipMode && hasOwnership
        ? {
            ownershipMode,
            ownership: Object.fromEntries(
              optimizerPool().flatMap((p) => {
                const own = ownOf(p, ownField);
                return own === null ? [] : [[p.id, own / 100]];
              }),
            ) as Record<string, number>,
          }
        : {}),
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
        lockedIds: lockIds,
        excludedIds,
        ...settings,
        gameOf: (p) => gameOfTeam.get(p.team) ?? p.team,
      });
      note = FALLBACK_NOTE;
    } finally {
      setBusy(null);
    }
    setBuilt({ ...result, ownershipMode: settings.ownershipMode ?? null, ownField });
    setMessage(
      result.lineups.length
        ? `Built ${result.lineups.length} lineup${result.lineups.length > 1 ? "s" : ""}${lockIds.length ? ` around your ${lockIds.length} locked player${lockIds.length > 1 ? "s" : ""}` : ""}. See them below the player pool.${note}`
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
      downloadCsv(`stacklab-week${slate.week}-${built.lineups.length}-lineups.csv`, lineupsToCsv(built.lineups));
      setMessage("Downloaded a readable CSV. Upload your DKSalaries.csv to get a DraftKings upload file.");
    }
  }

  async function runOptimizer() {
    if (selectedTeams && activeGames.length < 2) {
      setMessage("Select at least 2 games: DraftKings Classic lineups need players from 2 or more games.");
      return;
    }
    const shortfall = poolShortfall();
    if (shortfall) {
      setMessage(shortfall);
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
      const result = optimizeLineup({
        pool: optimizerPool().map((p) => ({ ...p, projected: targetPoints(p, target) })),
        salaryCap: slate.salaryCap,
        lockedIds: lockIds,
        excludedIds,
      });
      if (result.ok) {
        const players = toPlayers(result.players.map((p) => p.id));
        picked = { players, salary: result.salary, projected: lineupProjection(players) };
      }
      else failure = result.reason;
      note = FALLBACK_NOTE;
    } finally {
      setBusy(null);
    }
    if (!picked) {
      setMessage((selectedTeams ? `${failure} Try selecting more games.` : (failure ?? "No lineup found.")) + note);
      return;
    }
    setEditor(
      picked.players.map((p) => p.id),
      lockIds,
    );
    const gamesUsed = new Set(picked.players.map((p) => gameOfTeam.get(p.team) ?? p.team)).size;
    const kept = lockIds.length ? ` Kept your ${lockIds.length} locked player${lockIds.length > 1 ? "s" : ""}.` : "";
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
      downloadCsv(`stacklab-week${slate.week}-lineup.csv`, lineupToCsv(lineup));
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
                      {p.opponent ? ` ${opponentLabel(p)}` : ""} · {money(p.salary)}
                      {p.injury && <span className="ml-1 font-semibold text-amber-300">{p.injury}</span>}
                    </p>
                    <p className="mt-2 flex items-baseline justify-between gap-2">
                      <span className="text-xl font-black text-amber-300">{p.value.toFixed(2)}x</span>
                      <span className="text-xs text-emerald-300">{p.projected.toFixed(1)} pts</span>
                    </p>
                    {ownOf(p, ownField) !== null && (
                      <p className="text-[11px] text-slate-500" title={`ETR projected ownership, ${OWN_FIELD_LABEL[ownField]}`}>
                        Own {ownOf(p, ownField)!.toFixed(1)}%
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
            <button
              onClick={() => resetPaging(setPoolOnly)(!poolOnly)}
              aria-pressed={poolOnly}
              title="Show only players in your player pool"
              className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] ${
                poolOnly ? "border-sky-400 bg-sky-400 text-slate-950" : "border-slate-700 text-sky-300 hover:border-sky-400"
              }`}
            >
              Pool only ({poolIds.filter((id) => byId.has(id)).length})
            </button>
            <span className="ml-auto self-center text-xs text-slate-500">{filtered.length} shown</span>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm text-slate-200">
              <thead className="bg-slate-950/80 text-xs text-slate-400">
                <tr>
                  <th className="px-3 py-3" />
                  <th className="px-1 py-3 uppercase tracking-[0.18em]" title="Player pool: positions with picks only use those players when building">
                    Pool
                  </th>
                  {sortHeader("name", "Player")}
                  <th className="px-3 py-3 uppercase tracking-[0.18em]">Matchup</th>
                  {sortHeader("salary", "Salary")}
                  {sortHeader("projected", "Proj")}
                  {hasEtr && sortHeader("etr", "ETR")}
                  {hasOwnership && sortHeader("own", ownField === "small" ? "Own SF" : "Own LF")}
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
                      <td className="px-1 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={poolIds.includes(p.id)}
                          onChange={() => togglePool(p.id)}
                          disabled={excluded}
                          aria-label={`${poolIds.includes(p.id) ? "Remove" : "Add"} ${p.name} ${poolIds.includes(p.id) ? "from" : "to"} the player pool`}
                          className="h-4 w-4 cursor-pointer accent-sky-400"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <button
                          className="text-left font-semibold text-white underline decoration-slate-600 decoration-dotted underline-offset-4"
                          {...bind("log", p)}
                        >
                          {p.name}
                        </button>
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
                      <td className="px-3 py-2 text-slate-400">
                        {p.opponent ? (
                          <button className="underline decoration-slate-600 decoration-dotted underline-offset-4 hover:text-white" {...bind("opponent", p)}>
                            {opponentLabel(p)}
                          </button>
                        ) : (
                          opponentLabel(p)
                        )}
                      </td>
                      <td className="px-3 py-2">{money(p.salary)}</td>
                      <td className="px-3 py-2 font-bold text-emerald-300">
                        {p.projected === 0 ? "—" : p.projected.toFixed(1)}
                        {p.projectionFromDkAvg && (
                          <span title="No projection available; DraftKings season average" className="ml-1 text-[10px] font-normal text-slate-500">
                            avg
                          </span>
                        )}
                        {p.fieldgoal && (
                          <span title="Stack Lab's own projection" className="block text-[10px] font-normal text-slate-500">
                            SL {p.fieldgoal.projected.toFixed(1)}
                          </span>
                        )}
                      </td>
                      {hasEtr && <td className="px-3 py-2 text-violet-200">{p.etr ? p.etr.projected.toFixed(1) : "—"}</td>}
                      {hasOwnership && (
                        <td
                          className="px-3 py-2 text-slate-300"
                          title={(() => {
                            const other: OwnField = ownField === "small" ? "large" : "small";
                            const v = ownOf(p, other);
                            return v === null ? undefined : `${other === "small" ? "Small" : "Large"} field: ${v.toFixed(1)}%`;
                          })()}
                        >
                          {ownOf(p, ownField) !== null ? `${ownOf(p, ownField)!.toFixed(1)}%` : "—"}
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
                <span className="ml-2 text-xs font-normal text-slate-400" title={`Sum of ETR projected ownership (${OWN_FIELD_LABEL[ownField]})`}>
                  Own {totalOwnership(lineup, ownField).toFixed(0)}%
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
                      <button
                        onClick={() => toggleLock(p.id)}
                        aria-pressed={lockIds.includes(p.id)}
                        aria-label={`${lockIds.includes(p.id) ? "Unlock" : "Lock"} ${p.name}`}
                        title={lockIds.includes(p.id) ? "Locked: in every optimized and built lineup. Click to unlock." : "Unlocked: the optimizer may replace him. Click to lock."}
                        className={lockIds.includes(p.id) ? "text-amber-300 hover:text-amber-200" : "text-slate-600 hover:text-slate-300"}
                      >
                        <LockIcon locked={lockIds.includes(p.id)} />
                      </button>
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

          {lineup.length > 0 && (
            <p className="mt-2 text-[11px] text-slate-500">
              <span className="text-amber-300">Locked</span> players stay in every optimized and built lineup; the rest can change. Click a lock to toggle.
            </p>
          )}

          {message && <p className="mt-4 rounded-xl bg-slate-800/70 px-3 py-2 text-sm text-slate-200">{message}</p>}

          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              onClick={runOptimizer}
              disabled={busy !== null}
              className="col-span-2 rounded-full bg-emerald-400 px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-emerald-300 disabled:opacity-60"
            >
              {busy === "optimize" ? "Optimizing…" : lockIds.length > 0 ? "Optimize around locked" : "Optimize lineup"}
            </button>
            <button onClick={exportLineup} className="rounded-full border border-slate-700 px-4 py-2 text-sm font-semibold hover:border-slate-500">
              Export
            </button>
            <button
              onClick={() => {
                setEditor([], []);
                setMessage(null);
              }}
              className="rounded-full border border-slate-700 px-4 py-2 text-sm font-semibold hover:border-slate-500"
            >
              Clear
            </button>
          </div>
          {!hasDst && <p className="mt-3 text-xs text-slate-500">Optimizer holds back $3,000 for a defense.</p>}

          <div className="mt-6 border-t border-slate-800 pt-5">
            <h3 className="font-bold">Contest type</h3>
            <p className="mt-1 text-xs text-slate-500">Fills in the settings below for the kind of contest. Change any of them afterward.</p>
            <div className="mt-3 grid grid-cols-1 gap-3 text-xs">
              <label className="flex flex-col gap-1 text-slate-400">
                Preset
                <select
                  value={contestType ?? "custom"}
                  onChange={(e) => applyContest(e.target.value === "custom" ? null : (e.target.value as ContestType))}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white outline-none focus:border-emerald-400"
                >
                  <option value="custom">Custom (my own settings)</option>
                  {(Object.keys(CONTEST_PRESETS) as ContestType[]).map((type) => (
                    <option key={type} value={type}>
                      {CONTEST_PRESETS[type].label}
                    </option>
                  ))}
                </select>
              </label>
              {contestType && <p className="text-sky-300">{CONTEST_PRESETS[contestType].blurb}</p>}
              <label
                className="flex flex-col gap-1 text-slate-400"
                title="What Optimize and Build maximize. Lineup totals always show the plain projection."
              >
                Optimize for
                <select
                  value={target}
                  onChange={(e) => isScoringTarget(e.target.value) && setTarget(e.target.value)}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white outline-none focus:border-emerald-400"
                >
                  {SCORING_TARGETS.map((t) => (
                    <option key={t} value={t}>
                      {SCORING_TARGET_LABEL[t]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

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
              Lineup 1 is the optimal one; the rest vary players while staying strong. Locked players are in every lineup; everyone else is
              mixed.
            </p>
            <div className="mt-2 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs">
              {lockedPlayers.length ? (
                <>
                  <span className="text-slate-400">Locked in every lineup ({lockedPlayers.length}): </span>
                  <span className="font-semibold text-amber-300">{lockedPlayers.map((p) => p.name).join(", ")}</span>
                  <span className="text-slate-500"> · {ROSTER_SLOTS.length - lockedPlayers.length} spots vary</span>
                </>
              ) : (
                <span className="text-slate-500">No players locked: all 9 spots vary. Add players with + to lock them in.</span>
              )}
            </div>
            <div className="mt-2 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-slate-400">Player pool</span>
                {poolIds.length > 0 && (
                  <button onClick={() => savePool([])} className="text-sky-300 hover:text-white">
                    Clear pool
                  </button>
                )}
              </div>
              {poolByPosition.size ? (
                <>
                  <ul className="mt-1 space-y-0.5">
                    {POOL_POSITIONS.map((pos) => {
                      const picks = poolByPosition.get(pos);
                      return (
                        <li key={pos} className="flex gap-2">
                          <span className="w-8 shrink-0 font-bold text-slate-500">{pos}</span>
                          {picks ? (
                            <span className={picks.length < ROSTER_NEEDS[pos] ? "text-rose-300" : "text-sky-300"}>
                              {picks.length}: {picks.map((p) => p.name).join(", ")}
                            </span>
                          ) : (
                            <span className="text-slate-500">any player</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-1 text-slate-500">Optimize and Build only use these players at positions with picks.</p>
                </>
              ) : (
                <p className="mt-1 text-slate-500">Check players in the Pool column to limit a position to your picks.</p>
              )}
            </div>
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
              {hasOwnership && (
                <div className="col-span-2 flex flex-col gap-1 text-slate-400">
                  <span title="Which ETR ownership projection the Own column, Ownership vs. field, exposure chips and lineup totals use">
                    Ownership projection
                  </span>
                  <div className="grid grid-cols-2 gap-1" role="group" aria-label="Ownership projection">
                    {(["large", "small"] as const).map((field) => {
                      const available = field === "small" ? hasSmallOwn : hasLargeOwn;
                      const active = ownField === field;
                      return (
                        <button
                          key={field}
                          type="button"
                          onClick={() => chooseOwnField(field)}
                          disabled={!available}
                          aria-pressed={active}
                          title={
                            available
                              ? field === "small"
                                ? "Small-field contests: cash games, single-entry and small GPPs"
                                : "Large-field GPPs (thousands of entries)"
                              : "Not in your ETR upload"
                          }
                          className={`rounded-lg border px-2 py-1.5 text-xs font-semibold ${
                            active
                              ? "border-emerald-400 bg-emerald-400 text-slate-950"
                              : "border-slate-700 text-slate-300 hover:border-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
                          }`}
                        >
                          {field === "small" ? "Small field" : "Large field"}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {hasOwnership && (
                <label
                  className="col-span-2 flex flex-col gap-1 text-slate-400"
                  title="Your exposure to each chalk player (ETR projected 10%+ owned, in the ownership projection chosen above) compared with the field. Lower-owned players are left to the optimizer, and Max exposure % still applies."
                >
                  Ownership vs. field
                  <select
                    value={ownershipMode ?? "ignore"}
                    onChange={(e) => setOwnershipMode(isOwnershipMode(e.target.value) ? e.target.value : null)}
                    className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white outline-none focus:border-emerald-400"
                  >
                    <option value="ignore">Ignore ownership</option>
                    <option value="under">Underweight chalk: at most ½ projected own</option>
                    <option value="match">In line: about projected own</option>
                    <option value="over">Overweight chalk: up to 1.5× projected own</option>
                  </select>
                </label>
              )}
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
          ownershipMode={hasOwnership ? built.ownershipMode : null}
          ownField={built.ownField}
          onLoad={(ids) => {
            setEditor(ids, lockIds);
            setMessage("Loaded into the editor.");
          }}
          onExport={exportBuilt}
          onClear={() => setBuilt(null)}
        />
      )}
      <HoverCards hover={hover} teams={slate.teams} />
    </>
  );
}

function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.5" fill={locked ? "currentColor" : "none"} />
      <path d={locked ? "M5 7V5a3 3 0 0 1 6 0v2" : "M5 7V5a3 3 0 0 1 5.8-1"} strokeLinecap="round" />
    </svg>
  );
}

function BuiltLineups({
  result,
  players,
  opponentOf,
  rules,
  showOwnership,
  ownershipMode,
  ownField,
  onLoad,
  onExport,
  onClear,
}: {
  result: MultiLineupResult;
  players: Map<string, PoolPlayer>;
  opponentOf: Map<string, string>;
  rules: StackRules;
  showOwnership: boolean;
  ownershipMode: OwnershipMode | null;
  ownField: OwnField;
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
        <p className="mb-2 text-xs uppercase tracking-[0.18em] text-slate-500">
          Exposure: share of lineups each player is in
          {showOwnership && (
            <span className="normal-case tracking-normal"> · vs. projected {OWN_FIELD_LABEL[ownField]} ownership (▲ over, ▼ under the field)</span>
          )}
          {ownershipMode && (
            <span className="normal-case tracking-normal text-sky-300">
              {" "}
              · built {ownershipMode === "under" ? "underweight" : ownershipMode === "over" ? "overweight" : "in line"} (chalk target {OWNERSHIP_TARGET[ownershipMode]}× own)
            </span>
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          {mostUsed.map(({ p, pct }) => {
            const own = showOwnership ? ownOf(p, ownField) : null;
            const diff = typeof own === "number" ? pct - own : null;
            return (
              <span key={p.id} className="rounded-full border border-slate-700 bg-slate-950/70 px-3 py-1 text-xs">
                <span className="font-semibold text-white">{p.name}</span>
                <span className="ml-1 text-slate-500">{p.position}</span>
                <span className="ml-2 text-amber-300">{pct}%</span>
                {typeof own === "number" && diff !== null && (
                  <span
                    title={`Projected ownership ${own.toFixed(1)}%`}
                    className={`ml-1 ${diff > 5 ? "text-amber-200" : diff < -5 ? "text-sky-300" : "text-slate-500"}`}
                  >
                    {diff > 5 ? "▲" : diff < -5 ? "▼" : "≈"} {own.toFixed(0)}%
                  </span>
                )}
              </span>
            );
          })}
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
                  {showOwnership && <span className="ml-2 text-xs text-slate-500">Own {totalOwnership(l.players, ownField).toFixed(0)}%</span>}
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
                      <span className="shrink-0 text-xs leading-5 text-slate-500">
                        {p ? (
                          <>
                            {p.team} <span className="text-slate-300">{p.opponent ? opponentLabel(p) : ""}</span> · {money(p.salary)}
                          </>
                        ) : (
                          ""
                        )}
                      </span>
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
