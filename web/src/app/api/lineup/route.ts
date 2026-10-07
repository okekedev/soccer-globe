import { findLeague } from "@/lib/leagues";
import { getLineups } from "@/lib/espn";

/** GET /api/lineup?league=usa.1&event=761830&live=1 → { lineups: { [teamId]: Lineup } } */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const league = findLeague(searchParams.get("league") ?? "");
  const event = searchParams.get("event") ?? "";
  if (!league || !/^\d+$/.test(event)) return Response.json({ lineups: {} });
  // Lineups only come from ESPN for now.
  if (league.provider.type !== "espn") return Response.json({ lineups: {} });
  const lineups = await getLineups(league.id, event, searchParams.get("live") === "1").catch(() => ({}));
  return Response.json({ lineups });
}
