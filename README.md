# FieldGoal — DFS research

A Next.js 16 dashboard for DraftKings NFL Classic contests: a filterable player board, this week's matchups, and a lineup builder with an exact salary-cap optimizer.

## Features

The dashboard has three tabs (each linkable: `#lineup`, `#research`, `#games`):

- **Lineup builder**: the player pool and lineup panel described below.
- **Projections**: the inputs behind each projection: weighted, season and last-3 DK points per game, the salary prior, base projection, matchup and Vegas adjustments, implied total, and position-specific per-game stats (passing, rushing, receiving; sacks, takeaways and points allowed for DST). Hover or tap a player to see the opposing defense's DK points allowed to each position, plus points, pass yards and rush yards allowed per game, each with a league rank. For a DST, the card shows the opposing offense instead.
- **Games & weather**: each game's spread, moneylines, over/under, implied team totals and kickoff-hour forecast (temperature, wind, chance of precipitation, conditions; dome games are marked indoors). Wind of 15+ mph and precipitation chances of 50%+ are flagged.

A **DK slate** selector on the Lineup builder and Projections tabs limits the pool, game strip and optimizer to one DraftKings Sunday Classic slate. **Early** is the Sunday 1:00 PM ET kickoffs, **Late** is 4:05/4:25 PM (DraftKings calls it Afternoon), and **Main** is both. Thursday, Sunday night, Monday and international morning games appear only under **All games**. DraftKings player IDs are specific to each slate, so for an Early- or Late-only contest, upload that contest's salary CSV before exporting a lineup.

**Show unprojected** lists DraftKings players with no projection; you can add them to a lineup by hand, but the optimizer only uses them if you have. **Mark starting** (on QBs and unprojected players) tells the model to treat a player as this week's starter, for news that breaks before Sleeper updates. Overrides are saved in your browser for the week and sent to `/api/research?starters=[...]`, which recalculates the slate. Marking a QB demotes the team's other QBs to backup.

Players listed **OUT** or **IR** (DraftKings status or the nflverse injury report) are removed from the pool; the header shows how many were hidden.

- **Player pool**: the full weekly pool with position tabs (QB/RB/WR/TE/FLEX/DST), search, a game filter (click a matchup), sortable columns, and per-player exclude.
- **Lineup builder**: DraftKings Classic slots (QB, 2 RB, 3 WR, TE, FLEX, DST) with a $50K cap and remaining salary per open slot.
- **Optimizer**: finds the max-projection lineup under the cap, keeping any players you've already added. It's an exact knapsack search, not greedy. If the feed has no defenses, it holds back $3,000 for one.
- **Export**: once DraftKings salaries are loaded, downloads a DraftKings upload file (slot header + player IDs) for Lineups → Upload Lineups; otherwise a readable CSV.
- **Injuries**: DraftKings status is shown on the board; the optimizer skips OUT, IR and Doubtful players.
- **Matchups and weather**: lines come from the nflverse schedule. Forecasts come from [Open-Meteo](https://open-meteo.com), which is free and needs no key (non-commercial use; a commercial deployment needs an Open-Meteo plan).

## Data sources

`getSlateData()` in `lib/player-data.ts` uses the first source that returns players:

1. **FieldGoal model on nflverse data** (`lib/nflverse.ts`), the default. It's free, with no R or API key needed; it downloads the [nflverse-data](https://github.com/nflverse/nflverse-data) CSV releases. The current week also comes from the nflverse schedule (the first week with unplayed games).
   - **SportsDataIO** is used only when `PROJECTION_SOURCE=sportsdataio` (for a paid key). It is never called otherwise, and a trial key's scrambled data is never shown; the nflverse model is used instead.
2. **`DFS_FEED_URL`**: any JSON feed of player rows. Common field names are detected automatically.
3. **Database**: the last slate written by `/api/sync`.
4. **Sample data**: a small illustrative pool, so the UI still works offline.

Floor and ceiling are estimated from the projection and positional volatility unless the source supplies them.
If nflverse can't be reached, the app shows the last slate saved by `/api/sync` rather than any scrambled data.

## Projection model (nflverse)

Inputs: weekly player stats for this season and last, the schedule (with closing spread and total), and the injury report.

1. **DraftKings points** for each past game are computed from the stats: 0.04/pass yd, 4/pass TD, −1/INT, 0.1/rush or rec yd, 6/TD, 1/reception, +3 bonuses at 300 passing, 100 rushing or 100 receiving yards, 2/2-pt conversion, and −1/fumble lost.
2. **Recency-weighted average**, with weight 0.95^games-ago, and last season's games at 0.7×. Games where a regular left early (usage under 30% of their median) are ignored.
3. **Shrinkage** toward a salary-implied prior, worth 1 game. The prior is a per-position regression of points on DraftKings salary, used when salaries are loaded.
4. **Matchup adjustment**: the geometric mean of (a) DraftKings points the opponent allows to the position, against the league average, and (b) the Vegas implied team total, against the team's season scoring. Both are shrunk and clamped.
5. **Starting QB**: a manual override wins; otherwise it's the first healthy QB on [Sleeper's](https://docs.sleeper.com) depth chart (free public feed, cached 6 hours); otherwise the QB with the most attempts in the team's latest game. Other QBs keep 10% of their projection. A backup promoted to starter is shrunk harder toward his salary-implied prior, since his own sample is relief work.
   - **Limited-data starters**: a designated starter with fewer than 2 real games this season (e.g. a newly named QB) is projected from his real games across the last three seasons (QB: 15+ attempts; RB: 8+ touches/targets; WR/TE: 4+ targets). Those are blended with a role baseline worth 3 games: 90% of the team's QB production this season, or 85% of the depth-chart starter's average for other positions. Then the usual matchup and Vegas adjustments apply. These players are tagged "limited data" with the breakdown.
   - **Injury status** comes from DraftKings first, then the nflverse injury report, then Sleeper.
6. **Floor and ceiling** come from the player's own game-to-game spread (blended with a positional default): the 20th and 90th percentiles.
7. **DST** uses DraftKings defense scoring (sacks, turnovers, defensive and return TDs, safeties, blocks, points-allowed tiers), adjusted for the opponent offense and its implied total.

**Backtest** (2026 weeks 4–8, each projected only from earlier games; 890 player-games with real usage; run without salaries, since historical salaries aren't available):

| | Avg error | Correlation |
| --- | --- | --- |
| FieldGoal model | 6.03 | 0.490 |
| Season average | 6.47 | 0.447 |
| Last game | 7.83 | 0.325 |

The model only adjusts roles for QBs, so an RB or WR whose role changed recently is reflected only gradually. It doesn't know about late news such as depth-chart changes or weather, so check player status before lock.

## DraftKings salaries

Salaries come from DraftKings' own file. On DraftKings, open any **Classic** contest for the slate and choose **Export to CSV** (`DKSalaries.csv`). Then do one of the following:

- **Browser upload**: click **Upload DK salaries** on the dashboard. It applies instantly and is remembered in that browser for the week.
- **Shared (database) upload**: everyone sees it, and the next sync stores it.

  ```bash
  curl -X POST -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: text/csv"     --data-binary @DKSalaries.csv https://<your-app>/api/salaries
  ```

When a file is loaded, the pool is limited to that slate. Salaries, DraftKings IDs and injury status come from DraftKings, and projections stay from the model. Players are matched by name and team, or by name and position if a player changed teams. If the projection source has no players at a position (defenses under SportsDataIO), they use DraftKings' average points per game (marked "avg"). Other unmatched players go to the "Show unprojected" list.

## Setup

```bash
npm install            # also runs prisma generate
cp .env.example .env.local   # fill in DATABASE_URL and CRON_SECRET
npm run db:migrate     # apply migrations in prisma/migrations
npm run dev
```

### Existing databases created with `prisma db push`

`prisma/migrations/0_init` matches the original schema. Mark it as applied once, then deploy the rest:

```bash
npx prisma migrate resolve --applied 0_init --config prisma7.config.ts
npm run db:migrate
```

## API

| Route | Description |
| --- | --- |
| `GET /api/research` | Full slate: players, games, notices |
| `GET /api/players` | Player pool only |
| `GET /api/games` | This week's matchups |
| `GET /api/salaries` | Uploaded DraftKings salary count for the week |
| `POST/DELETE /api/salaries` | Replace or clear the week's DraftKings salaries (raw CSV body). Requires `Authorization: Bearer $CRON_SECRET`. |
| `GET/POST /api/sync` | Writes the current live slate to Postgres. Requires `Authorization: Bearer $CRON_SECRET`. Runs daily via `vercel.json`. |

## Scripts

`npm run dev`, `build`, `lint`, `typecheck`, `db:migrate`, `db:status`.
