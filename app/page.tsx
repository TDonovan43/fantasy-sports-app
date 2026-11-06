import { getLiveWeekContext, getResearchPlayers } from "@/lib/player-data";

const matchups = [
  ["PHI at DAL", "Sunday 4:25 PM"],
  ["DET at GB", "Sunday 1:00 PM"],
  ["SF at MIN", "Sunday 8:20 PM"],
];

export default async function Home() {
  const playerTable = await getResearchPlayers();
  const liveContext = await getLiveWeekContext();
  const bestValuePlayer = playerTable.reduce((best, player) =>
    (player.value > best.value ? player : best),
    playerTable[0] ?? {
      name: "N/A",
      value: 0,
      projected: 0,
      floor: 0,
      ceiling: 0,
      position: "N/A",
      team: "N/A",
      salary: "N/A",
      trend: "flat",
    },
  );

  const slateSummary = [
    { label: "Projected players", value: String(playerTable.length) },
    { label: "Best value", value: bestValuePlayer.name },
    { label: "Live source", value: liveContext.source },
    { label: "Current week", value: liveContext.label },
  ];

return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-8 flex items-center justify-between border-b border-slate-800 pb-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-400 font-black text-slate-950">
              F
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.28em] text-emerald-300">
                DFS RESEARCH
              </p>
              <h1 className="text-xl font-bold">FieldGoal</h1>
            </div>
          </div>

          <nav className="hidden items-center gap-6 text-sm text-slate-300 md:flex">
            <a href="#research" className="hover:text-white">Research</a>
            <a href="#slate" className="hover:text-white">Slate</a>
            <a href="#players" className="hover:text-white">Players</a>
            <button className="rounded-full bg-emerald-400 px-4 py-2 font-semibold text-slate-950">
              New Slate
            </button>
          </nav>
        </header>

        <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6">
            <p className="mb-4 inline-flex rounded-full border border-emerald-400/40 bg-emerald-500/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-emerald-300">
              Weekly research // {liveContext.label}
            </p>
            <h2 className="max-w-xl text-4xl font-black tracking-tight text-white md:text-5xl">
              Daily fantasy football research built around real player data.
            </h2>
            <p className="mt-4 max-w-2xl text-base text-slate-300">
              This dashboard is pulling live NFL data from {liveContext.source}. DraftKings salary data still requires a licensed DFS feed, but the research layer is ready for that integration.
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <button className="rounded-full bg-emerald-400 px-5 py-3 text-sm font-bold text-slate-950">
                Review Slate
              </button>
              <button className="rounded-full border border-slate-700 bg-slate-950/60 px-5 py-3 text-sm font-bold text-white">
                Export Picks
              </button>
            </div>
          </div>

          <div id="slate" className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-400">Slate Snapshot</p>
                <h3 className="text-2xl font-bold">Top research</h3>
              </div>
              <span className="rounded-full bg-emerald-500/20 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-300">
                LIVE
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {slateSummary.map((item) => (
                <div key={item.label} className="rounded-2xl border border-slate-800 bg-slate-950/80 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{item.label}</p>
                  <p className="mt-2 text-lg font-bold text-white">{item.value}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="research" className="mt-8 grid gap-4 md:grid-cols-3">
          {matchups.map(([game, time]) => (
            <div key={game} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Matchup</p>
              <h3 className="mt-3 text-lg font-bold text-white">{game}</h3>
              <p className="mt-2 text-sm text-emerald-300">{time}</p>
            </div>
          ))}
        </section>

        <section id="players" className="mt-10 overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/70">
          <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
            <div>
              <p className="text-sm text-slate-400">Projected plays</p>
              <h3 className="text-2xl font-bold text-white">Player board</h3>
            </div>
            <div className="flex gap-2 text-xs uppercase tracking-[0.18em] text-slate-400">
              <span className="rounded-full border border-slate-700 px-2 py-1">QB</span>
              <span className="rounded-full border border-slate-700 px-2 py-1">RB</span>
              <span className="rounded-full border border-slate-700 px-2 py-1">WR</span>
              <span className="rounded-full border border-slate-700 px-2 py-1">TE</span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm text-slate-200">
              <thead className="bg-slate-950/80 text-xs uppercase tracking-[0.18em] text-slate-400">
                <tr>
                  <th className="px-5 py-4">Player</th>
                  <th className="px-5 py-4">Pos</th>
                  <th className="px-5 py-4">Team</th>
                  <th className="px-5 py-4">Salary</th>
                  <th className="px-5 py-4">Proj</th>
                  <th className="px-5 py-4">Floor</th>
                  <th className="px-5 py-4">Ceiling</th>
                  <th className="px-5 py-4">Value</th>
                  <th className="px-5 py-4">Trend</th>
                </tr>
              </thead>
              <tbody>
                {playerTable.map((player) => (
                  <tr key={player.name} className="border-t border-slate-800 hover:bg-slate-800/60">
                    <td className="px-5 py-4 font-semibold text-white">{player.name}</td>
                    <td className="px-5 py-4 text-slate-300">{player.position}</td>
                    <td className="px-5 py-4 text-slate-300">{player.team}</td>
                    <td className="px-5 py-4 text-slate-300">{player.salary}</td>
                    <td className="px-5 py-4 font-bold text-emerald-300">{player.projected.toFixed(1)}</td>
                    <td className="px-5 py-4 text-slate-300">{player.floor.toFixed(1)}</td>
                    <td className="px-5 py-4 text-slate-300">{player.ceiling.toFixed(1)}</td>
                    <td className="px-5 py-4 text-amber-300">{player.value.toFixed(2)}</td>
                    <td className="px-5 py-4">
                      <span
                        className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${
                          player.trend === "up"
                            ? "bg-emerald-500/20 text-emerald-300"
                            : "bg-slate-700 text-slate-300"
                        }`}
                      >
                        {player.trend}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
