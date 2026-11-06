import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

const players = [
  { name: "Jalen Hurts", position: "QB", team: "PHI" },
  { name: "Christian McCaffrey", position: "RB", team: "SF" },
  { name: "Amon-Ra St. Brown", position: "WR", team: "DET" },
  { name: "Sam LaPorta", position: "TE", team: "DET" },
  { name: "Puka Nacua", position: "WR", team: "LAR" },
  { name: "Breece Hall", position: "RB", team: "NYJ" },
  { name: "George Kittle", position: "TE", team: "SF" },
  { name: "C.J. Stroud", position: "QB", team: "HOU" },
];

export async function POST() {
  const created = [] as string[];

  for (const player of players) {
    const record = await prisma.player.upsert({
      where: { id: `${player.team}-${player.position}-${player.name}` },
      update: {},
      create: {
        id: `${player.team}-${player.position}-${player.name}`,
        name: player.name,
        position: player.position,
        team: player.team,
      },
    });

    created.push(record.id);
  }

  return NextResponse.json({ created });
}
