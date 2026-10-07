import { LEAGUES } from "@/lib/leagues";
import { getMatches } from "@/lib/espn";
import { getLigaPortugalMatches } from "@/lib/ligaportugal";

const MAX_DAYS = 30;

const clampDays = (v: string | null, fallback: number) =>
  Math.min(MAX_DAYS, Math.max(0, Number.isFinite(Number(v)) && v !== null ? Number(v) : fallback));

/**
 * GET /api/matches?past=7&next=7&leagues=usa.1,por.1
 * → matches from `past` days ago through `next` days ahead (all leagues if `leagues` is omitted).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const past = clampDays(searchParams.get("past"), 7);
  const next = clampDays(searchParams.get("next"), 7);
  const wanted = searchParams.get("leagues")?.split(",").filter(Boolean);
  const leagues = wanted ? LEAGUES.filter((l) => wanted.includes(l.id)) : LEAGUES;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const from = new Date(today.getTime() - past * 86400_000);
  // +1 day so evening kickoffs in the Americas (already "tomorrow" in UTC) are included.
  const to = new Date(today.getTime() + (next + 1) * 86400_000);

  const matches = (await Promise.all(leagues.map((l) => (l.provider.type === "ligaportugal" ? getLigaPortugalMatches(l, from, to) : getMatches(l, from, to))))).flat();
  return Response.json({ matches, updatedAt: new Date().toISOString() });
}
