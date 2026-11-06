import { NextResponse, type NextRequest } from "next/server";
import { parseDkSalariesCsv } from "@/lib/dk-salaries";
import { getStoredDkSalaries } from "@/lib/player-data";
import prisma from "@/lib/prisma";
import { getSeasonWeek } from "@/lib/sportsdataio";

function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET ?? process.env.SYNC_SECRET;
  return !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
}

async function targetWeek(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const season = Number(params.get("season"));
  const week = Number(params.get("week"));
  if (season > 0 && week > 0) return { season, week };
  return getSeasonWeek();
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

  const { season, week } = await targetWeek(request);
  const uploadedAt = new Date();
  await prisma.$transaction([
    prisma.dkSalary.deleteMany({ where: { season, week } }),
    prisma.dkSalary.createMany({
      data: rows.map((r) => ({ id: `${season}-${week}-${r.dkId}`, season, week, uploadedAt, ...r })),
      skipDuplicates: true,
    }),
  ]);

  return NextResponse.json({ season, week, players: rows.length, uploadedAt: uploadedAt.toISOString() });
}

/** Removes the week's uploaded salaries. Requires `Authorization: Bearer $CRON_SECRET`. */
export async function DELETE(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { season, week } = await targetWeek(request);
  const { count } = await prisma.dkSalary.deleteMany({ where: { season, week } });
  return NextResponse.json({ season, week, deleted: count });
}
