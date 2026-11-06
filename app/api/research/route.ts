import { NextResponse } from "next/server";
import { getSlateData } from "@/lib/player-data";

/** Full slate: players plus this week's matchups. */
export async function GET() {
  return NextResponse.json(await getSlateData());
}
