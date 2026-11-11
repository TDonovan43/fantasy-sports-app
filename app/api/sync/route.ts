import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { SLATE_GAME_TYPE, getLiveSlate, refreshSlateSnapshot, withStoredDkSalaries } from "@/lib/player-data";

export const maxDuration = 60;

const MODEL_VERSIONS: Record<string, string> = { SportsDataIO: "sdio-dk-v1", "nflverse model": "fieldgoal-nflverse-v1" };

function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET ?? process.env.SYNC_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/** Provider kickoff strings are Eastern wall-clock; store the digits as-is (UTC-tagged). */
function toKickoff(value: string | null) {
  if (!value) return null;
  const date = new Date(`${value.slice(0, 19)}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function sync(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized. Send `Authorization: Bearer $CRON_SECRET`." }, { status: 401 });
  }
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 500 });
  }

  const raw = await getLiveSlate();
  const live = raw ? await withStoredDkSalaries(raw) : null;
  if (!live) {
    return NextResponse.json({ error: "No live projection source returned players (SportsDataIO / nflverse)." }, { status: 502 });
  }
  const SOURCE = live.source;
  const MODEL_VERSION = MODEL_VERSIONS[live.source] ?? live.source;

  const slate = await prisma.slate.upsert({
    where: { source_season_week_gameType: { source: SOURCE, season: live.season, week: live.week, gameType: SLATE_GAME_TYPE } },
    update: { salaryCap: live.salaryCap },
    create: {
      source: SOURCE,
      season: live.season,
      week: live.week,
      gameType: SLATE_GAME_TYPE,
      salaryCap: live.salaryCap,
      slateDate: toKickoff(live.games[0]?.kickoff ?? null) ?? new Date(),
    },
  });

  // Insert new players, then update team/status for any that changed.
  const ids = live.players.map((p) => p.id);
  await prisma.player.createMany({
    data: live.players.map((p) => ({ id: p.id, externalId: p.id, name: p.name, position: p.position, team: p.team, status: p.injury })),
    skipDuplicates: true,
  });
  const existing = await prisma.player.findMany({ where: { id: { in: ids } }, select: { id: true, team: true, status: true, name: true } });
  const existingById = new Map(existing.map((p) => [p.id, p]));
  const changed = live.players.filter((p) => {
    const row = existingById.get(p.id);
    return row && (row.team !== p.team || row.status !== p.injury || row.name !== p.name);
  });

  await prisma.$transaction([
    ...changed.map((p) => prisma.player.update({ where: { id: p.id }, data: { team: p.team, status: p.injury, name: p.name } })),
    prisma.playerSalary.deleteMany({ where: { slateId: slate.id, source: SOURCE } }),
    prisma.playerProjection.deleteMany({ where: { slateId: slate.id, source: SOURCE } }),
    prisma.game.deleteMany({ where: { slateId: slate.id } }),
    prisma.playerSalary.createMany({
      data: live.players
        .filter((p) => p.salary > 0)
        .map((p) => ({ playerId: p.id, slateId: slate.id, source: SOURCE, salary: Math.round(p.salary), rosterPosition: p.position })),
    }),
    prisma.playerProjection.createMany({
      data: live.players.map((p) => ({
        playerId: p.id,
        slateId: slate.id,
        source: SOURCE,
        projectedFantasyPoints: p.projected,
        floor: p.rangeEstimated ? null : p.floor,
        ceiling: p.rangeEstimated ? null : p.ceiling,
        opponent: p.opponent,
        gameKey: p.gameKey,
        modelVersion: MODEL_VERSION,
      })),
    }),
    prisma.game.createMany({
      data: live.games.map((g) => ({
        id: `${slate.id}-${g.id}`,
        slateId: slate.id,
        season: live.season,
        week: live.week,
        awayTeam: g.awayTeam,
        homeTeam: g.homeTeam,
        kickoff: toKickoff(g.kickoff),
        pointSpread: g.pointSpread,
        overUnder: g.overUnder,
        channel: g.channel,
        status: g.status,
      })),
    }),
    prisma.slate.update({ where: { id: slate.id }, data: { updatedAt: new Date() } }),
  ]);

  // Also refresh the saved slate that pages serve.
  await refreshSlateSnapshot();

  return NextResponse.json({
    slateId: slate.id,
    season: live.season,
    week: live.week,
    players: live.players.length,
    playersUpdated: changed.length,
    games: live.games.length,
  });
}

export const GET = sync;
export const POST = sync;
