import { NextResponse } from "next/server";
import { getSlateData } from "@/lib/player-data";

/** Current DraftKings player pool from the best available source. */
export async function GET() {
  const { season, week, source, salaryCap, players, notices } = await getSlateData();
  return NextResponse.json({ season, week, source, salaryCap, notices, players });
}
