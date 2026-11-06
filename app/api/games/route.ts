import { NextResponse } from "next/server";
import { getSlateData } from "@/lib/player-data";

/** This week's NFL matchups with kickoff, spread and total. */
export async function GET() {
  const { season, week, source, games } = await getSlateData();
  return NextResponse.json({ season, week, source, games });
}
