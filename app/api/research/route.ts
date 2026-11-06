import { NextResponse, type NextRequest } from "next/server";
import { getSlateData, parseStarterOverrides } from "@/lib/player-data";

/**
 * Full slate: players plus this week's matchups.
 * `?starters=[{"name":"Joe Milton","team":"PHI","position":"QB"}]` recalculates with players marked as starting.
 */
export async function GET(request: NextRequest) {
  const starters = parseStarterOverrides(request.nextUrl.searchParams.get("starters"));
  return NextResponse.json(await getSlateData({ starters }));
}
