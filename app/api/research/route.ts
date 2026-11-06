import { NextResponse } from "next/server";
import { getResearchPlayers } from "@/lib/player-data";

export async function GET() {
  const players = await getResearchPlayers();
  return NextResponse.json({ players });
}
