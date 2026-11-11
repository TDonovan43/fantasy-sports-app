import { NextResponse, type NextRequest } from "next/server";
import { dkFileDates, parseDkSalariesCsv } from "@/lib/dk-salaries";
import { loadSchedule, weekForDates } from "@/lib/nflverse";
import { getStoredDkSalaries, refreshSlateSnapshot, resolveSeasonWeek } from "@/lib/player-data";
import prisma from "@/lib/prisma";

export const maxDuration = 60;

function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET ?? process.env.SYNC_SECRET;
  return !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
}

async function targetWeek(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const season = Number(params.get("season"));
  const week = Number(params.get("week"));
  if (season > 0 && week > 0) return { season, week };
  return resolveSeasonWeek();
}

/** Summary of the DraftKings salaries stored for the current (or ?season=&week=) week. */
export async function GET(request: NextRequest) {
  const { season, week } = await targetWeek(request);
  const stored = await getStoredDkSalaries(season, week);
  return NextResponse.json({ season, week, players: stored?.rows.length ?? 0, uploadedAt: stored?.uploadedAt ?? null });
}

/**
 * Replaces the week's DraftKings salaries with an uploaded DKSalaries.csv (raw CSV body).
 * Requires `Authorization: Bearer $CRON_SECRET`.
 */
export async function POST(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized. Send `Authorization: Bearer $CRON_SECRET`." }, { status: 401 });
  }

  let rows;
  try {
    rows = parseDkSalariesCsv(await request.text());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not parse CSV." }, { status: 400 });
  }

  // Store the file under the week its games are in (from Game Info dates), unless ?season=&week= is given.
  const explicit = request.nextUrl.searchParams.has("week");
  const detected = explicit ? null : weekForDates({ schedule: await loadSchedule() }, dkFileDates(rows));
  const { season, week } = detected ?? (await targetWeek(request));
  const uploadedAt = new Date();
  await prisma.$transaction([
    prisma.dkSalary.deleteMany({ where: { season, week } }),
    prisma.dkSalary.createMany({
      data: rows.map((r) => ({ id: `${season}-${week}-${r.dkId}`, season, week, uploadedAt, ...r })),
      skipDuplicates: true,
    }),
  ]);

  // Rebuild the saved slate now so the next page view shows the new salaries.
  const snapshot = await refreshSlateSnapshot();

  return NextResponse.json({
    season,
    week,
    weekSource: explicit ? "query" : detected ? "file dates" : "current week",
    players: rows.length,
    uploadedAt: uploadedAt.toISOString(),
    snapshot: { week: snapshot.week, source: snapshot.source, players: snapshot.players.length },
  });
}

/** Removes the week's uploaded salaries. Requires `Authorization: Bearer $CRON_SECRET`. */
export async function DELETE(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { season, week } = await targetWeek(request);
  const { count } = await prisma.dkSalary.deleteMany({ where: { season, week } });
  await refreshSlateSnapshot();
  return NextResponse.json({ season, week, deleted: count });
}
