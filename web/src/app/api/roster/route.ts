import { findLeague } from "@/lib/leagues";
import { getRoster } from "@/lib/espn";

/** GET /api/roster?league=usa.1&team=18418 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const league = findLeague(searchParams.get("league") ?? "");
  const team = searchParams.get("team") ?? "";
  if (!league || !/^\d+$/.test(team)) return Response.json({ error: "unknown league or team" }, { status: 400 });
  // Rosters only come from ESPN for now; other sources show "No roster available".
  if (league.provider.type !== "espn") return Response.json({ players: [] });
  return Response.json({ players: await getRoster(league.id, team) });
}
