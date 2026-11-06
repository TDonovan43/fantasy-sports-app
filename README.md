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

1. **SportsDataIO**: `PlayerGameProjectionStatsByWeek` (DK salary and DK points) plus `ScoresByWeek`.
2. **`DFS_FEED_URL`**: any JSON feed of player rows. Common field names are detected automatically.
3. **Database**: the last slate written by `/api/sync`.
4. **Sample data**: a small illustrative pool, so the UI still works offline.

Floor and ceiling are estimated from the projection and positional volatility unless the source supplies them.
A SportsDataIO trial key returns scrambled salaries and lines; the dashboard shows a notice when it detects one.

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
