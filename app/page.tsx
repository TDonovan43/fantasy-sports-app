import { connection } from "next/server";
import Dashboard from "@/app/components/dashboard";
import { getSlateData } from "@/lib/player-data";

export default async function Home() {
  // Slate data is live; never prerender it at build time.
  await connection();
  const slate = await getSlateData();
  return <Dashboard slate={slate} />;
}
