const topPlayers = [
  { name: "Jalen Carter", team: "QB", points: "219.4" },
  { name: "Tyreek Hill", team: "WR", points: "204.8" },
  { name: "Christian McCaffrey", team: "RB", points: "198.7" },
  { name: "Sam LaPorta", team: "TE", points: "187.5" },
];

const matchups = [
  ["Lions vs. Bears", "7:00 PM"],
  ["Shockwave FC vs. Dynasty", "8:30 PM"],
  ["Night Owls vs. Summit", "9:00 PM"],
];

export default function Home() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_#1f2937_0%,_#0f172a_36%,_#020817_100%)] text-white">
      <div className="mx-auto max-w-7xl px-6 py-8 lg:px-8">
        <header className="mb-10 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-400 font-black text-slate-950">
              F
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-emerald-300">
                Fantasy League
              </p>
              <h1 className="text-xl font-bold">FieldGoal</h1>
            </div>
          </div>

          <nav className="hidden items-center gap-8 text-sm text-slate-300 md:flex">
            <a href="#league">League</a>
            <a href="#players">Players</a>
            <a href="#matchups">Matchups</a>
            <button className="rounded-full bg-emerald-400 px-4 py-2 font-semibold text-slate-950">
              Draft Now
            </button>
          </nav>
        </header>

        <section className="grid gap-8 pb-12 pt-10 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
          <div>
            <p className="mb-4 inline-flex rounded-full border border-emerald-400/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.2em] text-emerald-300">
              Season 2026
            </p>
            <h2 className="max-w-xl text-5xl font-black tracking-tight text-white md:text-6xl">
              Build your dynasty. Own the season.
            </h2>
            <p className="mt-5 max-w-xl text-lg text-slate-300">
              Track team performance, dominate waiver claims, and outmaneuver your
              league with live fantasy insights designed for serious players.
            </p>

            <div className="mt-8 flex flex-wrap gap-4">
              <button className="rounded-full bg-emerald-400 px-6 py-3 text-sm font-bold text-slate-950 transition hover:bg-emerald-300">
                Join League
              </button>
              <button className="rounded-full border border-slate-600 bg-slate-900/40 px-6 py-3 text-sm font-bold text-white transition hover:border-slate-400">
                View Rankings
              </button>
            </div>

            <div className="mt-10 flex flex-wrap gap-8 text-sm text-slate-300">
              <div>
                <p className="text-3xl font-black text-white">12</p>
                <span>teams</span>
              </div>
              <div>
                <p className="text-3xl font-black text-white">12</p>
                <span>weeks</span>
              </div>
              <div>
                <p className="text-3xl font-black text-white">$150</p>
                <span>entry fee</span>
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-700 bg-slate-900/60 p-5 shadow-2xl shadow-emerald-500/10 backdrop-blur">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-400">League Pulse</p>
                <h3 className="text-2xl font-bold">Top performers</h3>
              </div>
              <span className="rounded-full bg-emerald-500/15 px-2 py-1 text-xs font-semibold text-emerald-300">
                Live
              </span>
            </div>

            <div className="space-y-3">
              {topPlayers.map((player, index) => (
                <div
                  key={player.name}
                  className="flex items-center justify-between rounded-2xl border border-slate-800 bg-slate-950/80 px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/20 font-bold text-emerald-300">
                      {index + 1}
                    </div>
                    <div>
                      <p className="font-semibold">{player.name}</p>
                      <p className="text-xs text-slate-400">{player.team}</p>
                    </div>
                  </div>
                  <span className="font-bold text-emerald-300">{player.points}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="matchups" className="grid gap-6 pb-12 md:grid-cols-3">
          {matchups.map(([matchup, time]) => (
            <div key={matchup} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
              <p className="text-xs uppercase tracking-[0.22em] text-slate-400">Tonight</p>
              <h3 className="mt-3 text-xl font-bold">{matchup}</h3>
              <p className="mt-2 text-sm text-emerald-300">{time}</p>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
