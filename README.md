# FieldGoal — DFS research

A Next.js 16 dashboard for DraftKings NFL Classic contests: a filterable player board, this week's matchups, and a lineup builder with an exact salary-cap optimizer.

## Features

- **Player board**: the full weekly pool with position tabs (QB/RB/WR/TE/FLEX/DST), search, a game filter (click a matchup), sortable columns, and per-player exclude.
- **Lineup builder**: DraftKings Classic slots (QB, 2 RB, 3 WR, TE, FLEX, DST) with a $50K cap and remaining salary per open slot.
- **Optimizer**: finds the max-projection lineup under the cap, keeping any players you've already added. It's an exact knapsack search, not greedy. If the feed has no defenses, it holds back $3,000 for one.
- **Export**: once DraftKings salaries are loaded, downloads a DraftKings upload file (slot header + player IDs) for Lineups → Upload Lineups; otherwise a readable CSV.
- **Injuries**: DraftKings status is shown on the board; the optimizer skips OUT, IR and Doubtful players.
- **Matchups**: kickoff time, spread and total from SportsDataIO.

## Data sources

`getSlateData()` in `lib/player-data.ts` uses the first source that returns players:

1. **Live projections**, chosen by `PROJECTION_SOURCE` (default `auto`):
   - **SportsDataIO** (`PlayerGameProjectionStatsByWeek` + `ScoresByWeek`). With `auto`, it's used only when the key is a paid key.
   - **FieldGoal model on nflverse data** (`lib/nflverse.ts`). It's free, with no R needed; it downloads the [nflverse-data](https://github.com/nflverse/nflverse-data) CSV releases. With `auto`, it's used when the SportsDataIO key is missing or a trial key.
2. **`DFS_FEED_URL`**: any JSON feed of player rows. Common field names are detected automatically.
3. **Database**: the last slate written by `/api/sync`.
4. **Sample data**: a small illustrative pool, so the UI still works offline.

Floor and ceiling are estimated from the projection and positional volatility unless the source supplies them.
A SportsDataIO trial key returns scrambled salaries and lines; the dashboard shows a notice when it detects one.

## Projection model (nflverse)

Inputs: weekly player stats for this season and last, the schedule (with closing spread and total), and the injury report.

1. **DraftKings points** for each past game are computed from the stats: 0.04/pass yd, 4/pass TD, −1/INT, 0.1/rush or rec yd, 6/TD, 1/reception, +3 bonuses at 300 passing, 100 rushing or 100 receiving yards, 2/2-pt conversion, and −1/fumble lost.
2. **Recency-weighted average**, with weight 0.95^games-ago, and last season's games at 0.7×. Games where a regular left early (usage under 30% of their median) are ignored.
3. **Shrinkage** toward a salary-implied prior, worth 1 game. The prior is a per-position regression of points on DraftKings salary, used when salaries are loaded.
4. **Matchup adjustment**: the geometric mean of (a) DraftKings points the opponent allows to the position, against the league average, and (b) the Vegas implied team total, against the team's season scoring. Both are shrunk and clamped.
5. **Starting QB**: the QB with the most attempts in the team's latest game is the starter, and other QBs keep 10% of their projection. If the starter is OUT (per the nflverse injury report or DraftKings' status), the backup is promoted and shrunk harder toward his salary-implied prior, since his own sample is relief work.
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

SportsDataIO trial keys scramble salaries, so the real salaries come from DraftKings' own file. On DraftKings, open any **Classic** contest for the slate and choose **Export to CSV** (`DKSalaries.csv`). Then do one of the following:

- **Browser upload**: click **Upload DK salaries** on the dashboard. It applies instantly and is remembered in that browser for the week.
- **Shared (database) upload**: everyone sees it, and the next sync stores it.

  ```bash
  curl -X POST -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: text/csv"     --data-binary @DKSalaries.csv https://<your-app>/api/salaries
  ```

When a file is loaded, the pool is limited to that slate. Salaries, DraftKings IDs and injury status come from DraftKings, and projections stay from SportsDataIO. Players are matched by name and team, or by name and position if a player changed teams. Defenses have no SportsDataIO projection, so they use DraftKings' average points per game (marked "avg"). Unmatched players at other positions are dropped, because SportsDataIO leaving them out means it projects them at 0.

## Setup

```bash
npm install            # also runs prisma generate
cp .env.example .env.local   # fill in DATABASE_URL, SPORTS_DATA_IO_API_KEY, CRON_SECRET
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
| `GET/POST /api/sync` | Writes the current SportsDataIO slate to Postgres. Requires `Authorization: Bearer $CRON_SECRET`. Runs daily via `vercel.json`. |

## Scripts

`npm run dev`, `build`, `lint`, `typecheck`, `db:migrate`, `db:status`.
