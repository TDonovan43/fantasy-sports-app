"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import GamesTab from "@/app/components/games-tab";
import LineupTab from "@/app/components/lineup-tab";
import ResearchTab from "@/app/components/research-tab";
import { applyDkSalariesToSlate, parseDkSalariesCsv } from "@/lib/dk-salaries";
import { SLATE_OPTIONS, filterSlate, gameInSlate, type SlateFilter } from "@/lib/slates";
import type { PoolPlayer, SlateData } from "@/lib/types";

type Upload = { csv: string; uploadedAt: string; fileName: string };

const TABS = [
  { id: "lineup", label: "Lineup builder" },
  { id: "research", label: "Projections" },
  { id: "games", label: "Games & weather" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const isTab = (v: string): v is TabId => TABS.some((t) => t.id === v);

export default function Dashboard({ slate: initialSlate }: { slate: SlateData }) {
  const storageKey = `fieldgoal-dk-salaries-${initialSlate.season}-${initialSlate.week}`;
  const [upload, setUpload] = useState<Upload | null>(null);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("lineup");
  const [slateFilter, setSlateFilter] = useState<SlateFilter>("all");
  const fileInput = useRef<HTMLInputElement>(null);

  // Browser-only state (saved upload, tab in the URL hash) is read after mount.
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync from the URL
    if (isTab(hash)) setTab(hash);
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) setUpload(JSON.parse(raw) as Upload);
    } catch {
      // Storage unavailable; uploads just won't persist.
    }
  }, [storageKey]);

  function selectTab(id: TabId) {
    setTab(id);
    window.history.replaceState(null, "", `#${id}`);
  }

  const slate = useMemo(() => {
    if (!upload) return initialSlate;
    try {
      return applyDkSalariesToSlate(initialSlate, parseDkSalariesCsv(upload.csv), upload.uploadedAt);
    } catch {
      return initialSlate;
    }
  }, [initialSlate, upload]);

  const slateView = useMemo(() => filterSlate(slate, slateFilter), [slate, slateFilter]);
  const slateCounts = useMemo(
    () => Object.fromEntries(SLATE_OPTIONS.map((o) => [o.id, slate.games.filter((g) => gameInSlate(g, o.id)).length])) as Record<SlateFilter, number>,
    [slate.games],
  );

  const topValue = useMemo(
    () => slate.players.filter((p) => p.salary > 0).reduce<PoolPlayer | null>((best, p) => (!best || p.value > best.value ? p : best), null),
    [slate.players],
  );

  async function handleSalaryFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const csv = await file.text();
      const rows = parseDkSalariesCsv(csv);
      const next: Upload = { csv, uploadedAt: new Date().toISOString(), fileName: file.name };
      setUpload(next);
      setUploadMessage(`Loaded ${rows.length} DraftKings salaries from ${file.name}. Your lineup was reset for the new pool.`);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Too large or storage blocked; still applied for this session.
      }
    } catch (error) {
      setUploadMessage(error instanceof Error ? error.message : "Couldn't read that file.");
    }
  }

  function clearUpload() {
    setUpload(null);
    setUploadMessage("Removed the uploaded salary file.");
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-5">
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
            <span className="rounded-full border border-slate-700 px-3 py-1 text-slate-300">
              {slate.players.length} players
              {slate.hiddenInactive ? <span className="text-slate-500"> · {slate.hiddenInactive} OUT/IR hidden</span> : null}
            </span>
            <input ref={fileInput} type="file" accept=".csv,text/csv" onChange={handleSalaryFile} className="hidden" />
            <button
              onClick={() => fileInput.current?.click()}
              className="rounded-full bg-emerald-400 px-3 py-1 font-semibold text-slate-950 hover:bg-emerald-300"
            >
              {slate.dkSalaries ? "Replace DK salaries" : "Upload DK salaries"}
            </button>
            {upload && (
              <button onClick={clearUpload} className="rounded-full border border-slate-700 px-3 py-1 text-slate-300 hover:border-rose-400">
                Remove {upload.fileName}
              </button>
            )}
            {topValue && (
              <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-amber-300">
                Top value: {topValue.name} ({topValue.value.toFixed(2)}x)
              </span>
            )}
          </div>
        </header>

        {(slate.notices.length > 0 || uploadMessage) && (
          <ul className="mb-4 space-y-1 rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
            {uploadMessage && <li className="font-semibold">{uploadMessage}</li>}
            {slate.notices.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}

        <nav role="tablist" aria-label="Sections" className="mb-6 flex gap-1 overflow-x-auto rounded-full border border-slate-800 bg-slate-900/70 p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              onClick={() => selectTab(t.id)}
              className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition ${
                tab === t.id ? "bg-emerald-400 text-slate-950" : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {tab !== "games" && (
          <div className="mb-6 flex flex-wrap items-center gap-2" role="group" aria-label="DraftKings slate">
            <span className="mr-1 text-xs uppercase tracking-[0.2em] text-slate-500">DK slate</span>
            {SLATE_OPTIONS.map((o) => {
              const count = slateCounts[o.id];
              const active = slateFilter === o.id;
              return (
                <button
                  key={o.id}
                  title={o.hint}
                  disabled={count === 0}
                  aria-pressed={active}
                  onClick={() => setSlateFilter(o.id)}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
                    active ? "border-sky-400 bg-sky-400 text-slate-950" : "border-slate-700 text-slate-300 hover:border-slate-500"
                  }`}
                >
                  {o.label}
                  <span className={active ? "ml-1 text-slate-800" : "ml-1 text-slate-500"}>{count}</span>
                </button>
              );
            })}
            <span className="text-xs text-slate-500">
              {SLATE_OPTIONS.find((o) => o.id === slateFilter)?.hint} · {slateView.players.length} players
            </span>
          </div>
        )}

        {/* Panels stay mounted so the lineup survives tab switches. */}
        <div role="tabpanel" id="panel-lineup" aria-labelledby="tab-lineup" hidden={tab !== "lineup"}>
          <LineupTab key={upload?.uploadedAt ?? "base"} slate={slateView} />
        </div>
        <div role="tabpanel" id="panel-research" aria-labelledby="tab-research" hidden={tab !== "research"}>
          <ResearchTab slate={slateView} />
        </div>
        <div role="tabpanel" id="panel-games" aria-labelledby="tab-games" hidden={tab !== "games"}>
          <GamesTab slate={slate} />
        </div>
      </div>
    </main>
  );
}
