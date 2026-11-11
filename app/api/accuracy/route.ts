import { NextResponse } from "next/server";
import { getAccuracyReport } from "@/lib/accuracy";

export const maxDuration = 60;

/** Projection accuracy by week (recorded or replayed projections vs actual DraftKings points). */
export async function GET() {
  try {
    return NextResponse.json(await getAccuracyReport());
  } catch (error) {
    console.error("Accuracy report failed", error);
    return NextResponse.json({ error: "Couldn't build the accuracy report." }, { status: 500 });
  }
}
