# FieldGoal — DFS research

A Next.js 16 dashboard for DraftKings NFL Classic contests: a filterable player board, this week's matchups, and a lineup builder with an exact salary-cap optimizer.

## Features

- **Player board**: the full weekly pool with position tabs (QB/RB/WR/TE/FLEX/DST), search, a game filter (click a matchup), sortable columns, and per-player exclude.
- **Lineup builder**: DraftKings Classic slots (QB, 2 RB, 3 WR, TE, FLEX, DST) with a $50K cap and remaining salary per open slot.
- **Optimizer**: finds the max-projection lineup under the cap, keeping any players you've already added. It's an exact knapsack search, not greedy. If the feed has no defenses, it holds back $3,000 for one.
- **Export**: downloads the lineup as a CSV in slot order.
- **Matchups**: kickoff time, spread and total from SportsDataIO.

## Data sources

`getSlateData()` in `lib/player-data.ts` uses the first source that returns players:

1. **SportsDataIO**: `PlayerGameProjectionStatsByWeek` (DK salary and DK points) plus `ScoresByWeek`.
2. **`DFS_FEED_URL`**: any JSON feed of player rows. Common field names are detected automatically.
3. **Database**: the last slate written by `/api/sync`.
4. **Sample data**: a small illustrative pool, so the UI still works offline.

Floor and ceiling are estimated from the projection and positional volatility unless the source supplies them.
A SportsDataIO trial key returns scrambled salaries and lines; the dashboard shows a notice when it detects one.

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
| `GET/POST /api/sync` | Writes the current SportsDataIO slate to Postgres. Requires `Authorization: Bearer $CRON_SECRET`. Runs daily via `vercel.json`. |

## Scripts

`npm run dev`, `build`, `lint`, `typecheck`, `db:migrate`, `db:status`.
