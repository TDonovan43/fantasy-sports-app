import { NextResponse } from "next/server";
import { getPlayerData } from "@/lib/player-data";

export async function GET() {
  const players = await getPlayerData();
  return NextResponse.json({ players });
}
