"use client";

import { useEffect, useRef, useState } from "react";
import type { AccuracyReport, Stats, WeekReport } from "@/lib/accuracy";

// Categorical slots 1–2 (dark steps), validated on the slate-900 surface: CVD ΔE 26.8, contrast ≥ 3:1.
const MODEL_COLOR = "#3987e5";
const BASELINE_COLOR = "#d95926";
const SURFACE = "#0f172a";
const FLOOR_TARGET = 0.2;
const CEILING_TARGET = 0.1;

const pct = (v: number) => `${Math.round(v * 100)}%`;
const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}`;

function calibration(actual: number, target: number) {
  const gap = actual - target;
  if (Math.abs(gap) <= 0.03) return { label: "on target", tone: "text-emerald-300" };
  return { label: gap > 0 ? `${pct(gap)} above target` : `${pct(-gap)} below target`, tone: "text-amber-300" };
}

export default function AccuracyTab({ active }: { active: boolean }) {
  const [report, setReport] = useState<AccuracyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);
  const started = useRef(false);

  // The report is heavier than the slate, so load it the first time the tab is opened.
  useEffect(() => {
    if (!active || started.current) return;
    started.current = true;
    fetch("/api/accuracy")
      .then(async (res) => {
        const json = (await res.json()) as AccuracyReport & { error?: string };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setReport(json);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load the accuracy report."));
  }, [active]);

  if (error) {
    return <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-8 text-center text-rose-300">{error}</section>;
  }
  if (!report) {
    return <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-8 text-center text-slate-400">Scoring past weeks…</section>;
  }

  const { weeks, totals, pending } = report;
  const week = weeks.find((w) => w.week === selectedWeek) ?? weeks.at(-1) ?? null;

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5">
        <h2 className="text-2xl font-bold">Projection accuracy</h2>
        {totals ? (
          <p className="mt-1 max-w-3xl text-sm text-slate-300">
            Across {totals.weeks} week{totals.weeks > 1 ? "s" : ""} ({totals.players.toLocaleString("en-US")} player-games), projections missed by{" "}
            <span className="font-semibold text-white">{totals.mae.toFixed(2)}</span> DraftKings points on average
            {totals.baselineMae !== null && (
              <>
                , against <span className="font-semibold text-white">{totals.baselineMae.toFixed(2)}</span> for each player&apos;s season average
              </>
            )}
            .
          </p>
        ) : (
          <p className="mt-1 text-sm text-slate-400">No completed weeks to score yet.</p>
        )}
        {pending.map((p) => (
          <p key={p.week} className="mt-2 text-xs text-slate-400">
            Week {p.week}: {p.recorded} projections recorded before kickoff. Results appear once every game is final and nflverse posts the stats.
          </p>
        ))}

        {totals && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile
              label="Average miss"
              value={totals.mae.toFixed(2)}
              unit="pts"
              note={totals.baselineMae !== null ? `Season average: ${totals.baselineMae.toFixed(2)}` : undefined}
              tone={totals.baselineMae !== null && totals.mae < totals.baselineMae ? "text-emerald-300" : "text-slate-400"}
            />
            <Tile
              label="Bias"
              value={signed(totals.bias)}
              unit="pts"
              note={totals.bias < 0 ? "Projections run low" : totals.bias > 0 ? "Projections run high" : "Balanced"}
              tone="text-slate-400"
            />
            <Tile label="Below floor" value={pct(totals.belowFloor)} note={`Target 20% · ${calibration(totals.belowFloor, FLOOR_TARGET).label}`} tone={calibration(totals.belowFloor, FLOOR_TARGET).tone} />
            <Tile
              label="Above ceiling"
              value={pct(totals.aboveCeiling)}
              note={`Target 10% · ${calibration(totals.aboveCeiling, CEILING_TARGET).label}`}
              tone={calibration(totals.aboveCeiling, CEILING_TARGET).tone}
            />
          </div>
        )}
      </section>

      {weeks.length > 0 && (
        <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5">
          <h3 className="text-lg font-bold">Average miss by week</h3>
          <p className="text-xs text-slate-500">Lower is better. Same players for both lines: those projected 3+ points who played and had a season average.</p>
          <MissChart weeks={weeks} />
        </section>
      )}

      {weeks.length > 0 && (
        <section className="overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/70">
          <div className="border-b border-slate-800 px-5 py-4">
            <h3 className="text-lg font-bold">By week</h3>
            <p className="text-xs text-slate-500">
              Replayed weeks are projected with only the games before them, without depth charts or injury news from that week, so treat them as a rough guide. Recorded weeks use the actual pre-kickoff projections. Click a week for detail.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full whitespace-nowrap text-left text-sm text-slate-200">
              <thead className="bg-slate-950/80 text-xs uppercase tracking-[0.14em] text-slate-400">
                <tr>
                  <th className="px-4 py-3">Week</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3 text-right">Players</th>
                  <th className="px-4 py-3 text-right">Avg miss</th>
                  <th className="px-4 py-3 text-right">Season avg miss</th>
                  <th className="px-4 py-3 text-right">Bias</th>
                  <th className="px-4 py-3 text-right">Correlation</th>
                  <th className="px-4 py-3 text-right">Below floor</th>
                  <th className="px-4 py-3 text-right">Above ceiling</th>
                </tr>
              </thead>
              <tbody>
                {[...weeks].reverse().map((w) => (
                  <tr
                    key={w.week}
                    onClick={() => setSelectedWeek(w.week)}
                    className={`cursor-pointer border-t border-slate-800 hover:bg-slate-800/50 ${week?.week === w.week ? "bg-slate-800/40" : ""}`}
                  >
                    <td className="px-4 py-2 font-semibold">Week {w.week}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] ${w.source === "recorded" ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-700 text-slate-300"}`}>
                        {w.source}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right">{w.overall.n}</td>
                    <td className="px-4 py-2 text-right font-semibold text-white">{w.overall.mae.toFixed(2)}</td>
                    <td className="px-4 py-2 text-right text-slate-400">{w.baseline ? w.baseline.baselineMae.toFixed(2) : "—"}</td>
                    <td className="px-4 py-2 text-right">{signed(w.overall.bias)}</td>
                    <td className="px-4 py-2 text-right">{w.overall.r?.toFixed(2) ?? "—"}</td>
                    <td className="px-4 py-2 text-right">{pct(w.belowFloor)}</td>
                    <td className="px-4 py-2 text-right">{pct(w.aboveCeiling)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {week && <WeekDetail week={week} />}
    </div>
  );
}

function Tile({ label, value, unit, note, tone }: { label: string; value: string; unit?: string; note?: string; tone: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-black text-white">
        {value}
        {unit && <span className="ml-1 text-sm font-normal text-slate-400">{unit}</span>}
      </p>
      {note && <p className={`mt-1 text-xs ${tone}`}>{note}</p>}
    </div>
  );
}

/** Two lines (model vs season average) over weeks, with a crosshair tooltip and direct end labels. */
function MissChart({ weeks }: { weeks: WeekReport[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const points = weeks.filter((w) => w.baseline).map((w) => ({ week: w.week, model: w.baseline!.modelMae, base: w.baseline!.baselineMae, source: w.source }));
  if (points.length === 0) return null;

  const W = 640;
  const H = 240;
  const pad = { l: 40, r: 104, t: 16, b: 32 };
  const max = Math.max(...points.flatMap((p) => [p.model, p.base]));
  const top = Math.max(2, Math.ceil((max * 1.15) / 2) * 2);
  const ticks = Array.from({ length: top / 2 + 1 }, (_, i) => i * 2);
  const x = (i: number) => (points.length === 1 ? (pad.l + W - pad.r) / 2 : pad.l + (i / (points.length - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - v / top) * (H - pad.t - pad.b);
  const path = (key: "model" | "base") => points.map((p, i) => `${i ? "L" : "M"}${x(i)} ${y(p[key])}`).join(" ");
  const last = points.at(-1)!;
  const step = points.length > 1 ? (W - pad.l - pad.r) / (points.length - 1) : W - pad.l - pad.r;
  const h = hover !== null ? points.at(hover) : undefined;

  return (
    <div className="mt-3">
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-slate-300">
        <span className="flex items-center gap-2">
          <svg width="18" height="8" aria-hidden>
            <line x1="0" y1="4" x2="18" y2="4" stroke={MODEL_COLOR} strokeWidth="2" />
          </svg>
          FieldGoal model
        </span>
        <span className="flex items-center gap-2">
          <svg width="18" height="8" aria-hidden>
            <line x1="0" y1="4" x2="18" y2="4" stroke={BASELINE_COLOR} strokeWidth="2" />
          </svg>
          Season average
        </span>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Average projection miss by week, model versus season average">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="#1e293b" strokeWidth="1" />
              <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#94a3b8">
                {t}
              </text>
            </g>
          ))}
          {points.map((p, i) => (
            <text key={p.week} x={x(i)} y={H - 10} textAnchor="middle" fontSize="11" fill="#94a3b8">
              Wk {p.week}
            </text>
          ))}
          {h && <line x1={x(hover!)} x2={x(hover!)} y1={pad.t} y2={H - pad.b} stroke="#475569" strokeWidth="1" strokeDasharray="3 3" />}
          <path d={path("base")} fill="none" stroke={BASELINE_COLOR} strokeWidth="2" strokeLinejoin="round" />
          <path d={path("model")} fill="none" stroke={MODEL_COLOR} strokeWidth="2" strokeLinejoin="round" />
          {points.map((p, i) => (
            <g key={p.week}>
              <circle cx={x(i)} cy={y(p.base)} r="4" fill={BASELINE_COLOR} stroke={SURFACE} strokeWidth="2" />
              <circle cx={x(i)} cy={y(p.model)} r="4" fill={MODEL_COLOR} stroke={SURFACE} strokeWidth="2" />
            </g>
          ))}
          <text x={x(points.length - 1) + 10} y={y(last.model) + (last.model <= last.base ? 12 : -4)} fontSize="11" fill="#e2e8f0">
            Model {last.model.toFixed(2)}
          </text>
          <text x={x(points.length - 1) + 10} y={y(last.base) + (last.base < last.model ? 12 : -4)} fontSize="11" fill="#e2e8f0">
            Season avg {last.base.toFixed(2)}
          </text>
          {points.map((p, i) => (
            <rect
              key={p.week}
              x={x(i) - step / 2}
              y={pad.t}
              width={step}
              height={H - pad.t - pad.b}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          ))}
        </svg>
        {h && (
          <div
            className="pointer-events-none absolute top-2 rounded-xl border border-slate-700 bg-slate-950/95 px-3 py-2 text-xs shadow-xl"
            style={{ left: `${(x(hover!) / W) * 100}%`, transform: hover! > points.length / 2 ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }}
          >
            <p className="font-semibold text-white">
              Week {h.week} <span className="font-normal text-slate-500">({h.source})</span>
            </p>
            <p className="mt-1 flex items-center gap-2 text-slate-300">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: MODEL_COLOR }} />
              Model {h.model.toFixed(2)} pts
            </p>
            <p className="flex items-center gap-2 text-slate-300">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: BASELINE_COLOR }} />
              Season avg {h.base.toFixed(2)} pts
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function StatsRow({ label, s }: { label: string; s: Stats }) {
  return (
    <tr className="border-t border-slate-800">
      <td className="px-4 py-2 font-semibold">{label}</td>
      <td className="px-4 py-2 text-right">{s.n}</td>
      <td className="px-4 py-2 text-right text-white">{s.mae.toFixed(2)}</td>
      <td className="px-4 py-2 text-right">{signed(s.bias)}</td>
      <td className="px-4 py-2 text-right">{s.r?.toFixed(2) ?? "—"}</td>
    </tr>
  );
}

function WeekDetail({ week }: { week: WeekReport }) {
  return (
    <section className="grid gap-6 lg:grid-cols-2">
      <div className="overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/70">
        <div className="border-b border-slate-800 px-5 py-4">
          <h3 className="text-lg font-bold">Week {week.week} by position</h3>
          <p className="text-xs text-slate-500">Bias = projected minus actual: negative means projections ran low.</p>
        </div>
        <table className="min-w-full text-left text-sm text-slate-200">
          <thead className="bg-slate-950/80 text-xs uppercase tracking-[0.14em] text-slate-400">
            <tr>
              <th className="px-4 py-3">Pos</th>
              <th className="px-4 py-3 text-right">Players</th>
              <th className="px-4 py-3 text-right">Avg miss</th>
              <th className="px-4 py-3 text-right">Bias</th>
              <th className="px-4 py-3 text-right">Correlation</th>
            </tr>
          </thead>
          <tbody>
            {(["QB", "RB", "WR", "TE", "DST"] as const).map((pos) => {
              const s = week.byPosition[pos];
              return s ? <StatsRow key={pos} label={pos} s={s} /> : null;
            })}
            <StatsRow label="All" s={week.overall} />
          </tbody>
        </table>
      </div>

      <div className="space-y-6">
        <div className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5">
          <h3 className="text-lg font-bold">Biggest misses</h3>
          <ol className="mt-3 space-y-1.5 text-sm">
            {week.misses.map((m) => (
              <li key={`${m.name}-${m.team}`} className="flex items-baseline gap-3">
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-semibold text-white">{m.name}</span>
                  <span className="ml-1 text-xs text-slate-500">
                    {m.position} · {m.team}
                  </span>
                </span>
                <span className="text-xs text-slate-400">
                  {m.projected.toFixed(1)} → <span className="text-white">{m.actual.toFixed(1)}</span>
                </span>
                <span className={`w-14 text-right text-xs font-semibold ${m.error > 0 ? "text-emerald-300" : "text-rose-300"}`}>
                  {m.error > 0 ? "+" : ""}
                  {m.error.toFixed(1)}
                </span>
              </li>
            ))}
          </ol>
        </div>

        {week.lineup && (
          <div className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5">
            <h3 className="text-lg font-bold">Lineups</h3>
            <p className="text-xs text-slate-500">DraftKings Classic, $50,000, using that week&apos;s salaries (no stacking rules).</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-3">
                <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Optimal by projection</p>
                <p className="mt-1 text-xl font-black text-white">{week.lineup.optimal.actual.toFixed(1)}</p>
                <p className="text-xs text-slate-400">actual · projected {week.lineup.optimal.projected.toFixed(1)}</p>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-3">
                <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Best in hindsight</p>
                <p className="mt-1 text-xl font-black text-white">{week.lineup.hindsight.actual.toFixed(1)}</p>
                <p className="text-xs text-slate-400">actual</p>
              </div>
            </div>
            <p className="mt-3 text-xs text-slate-500">Optimal: {week.lineup.optimal.players.join(", ")}</p>
            <p className="mt-1 text-xs text-slate-500">Hindsight: {week.lineup.hindsight.players.join(", ")}</p>
          </div>
        )}
      </div>
    </section>
  );
}
