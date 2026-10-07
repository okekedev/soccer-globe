import { cacheLife } from "next/cache";
import type { League, Match, MatchSide, MatchStatus } from "./types";
import { homeStadium } from "./leagues";

// The league's own site (ligaportugal.pt) for competitions ESPN doesn't carry.
// Its calendar API returns one month of fixtures for every Liga Portugal
// competition (~17 MB with full club profiles), so each month is fetched once,
// cut down to the fields we use, and cached.
const BASE = "https://www.ligaportugal.pt/api/v1";

type Provider = Extract<League["provider"], { type: "ligaportugal" }>;

async function fetchMonth(season: string, month: number): Promise<LpFixture[]> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 3600 });
  const res = await fetch(`${BASE}/calendar/matches/month/${month}?season=${season}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`ligaportugal.pt ${res.status} for month ${month}`);
  const days = (await res.json()) as { fixtures: LpFixtureFull[] }[];
  return days.flatMap((d) => d.fixtures).map(slim);
}

export async function getLigaPortugalMatches(league: League, from: Date, to: Date): Promise<Match[]> {
  const provider = league.provider as Provider;
  const months = new Set<number>();
  for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) months.add(d.getUTCMonth() + 1);

  const fixtures = (
    await Promise.all(
      [...months].map((m) =>
        fetchMonth(provider.season, m).catch((e) => {
          console.error(e);
          return [] as LpFixture[];
        }),
      ),
    )
  ).flat();

  const now = Date.now();
  return fixtures
    .filter((f) => f.competitionName === provider.calendarName && !f.canceled && !f.postponed)
    .filter((f) => {
      const t = Date.parse(f.kickoff);
      return t >= from.getTime() && t < to.getTime() + 86400_000;
    })
    .map((f): Match => {
      const status = statusOf(f, now);
      const stadium = homeStadium(league, f.home.id);
      return {
        id: `${league.id}-${f.code}`,
        league: league.id,
        kickoff: f.kickoff,
        status,
        detail: status === "in" ? (f.halftime ? "HT" : f.time || "Live") : status === "post" ? "FT" : "",
        home: side(f.home, status, status === "in" ? f.liveHome : f.homeGoals),
        away: side(f.away, status, status === "in" ? f.liveAway : f.awayGoals),
        venue: stadium ? { ...stadium, city: null } : null,
      };
    })
    .sort((a, b) => a.kickoff.localeCompare(b.kickoff));
}

// State 5 = finished, 0/1 = scheduled. Live codes only appear during games, so
// anything that has kicked off and isn't finished counts as live (for at most
// 3 hours, in case the feed never marks it finished).
function statusOf(f: LpFixture, now: number): MatchStatus {
  const t = Date.parse(f.kickoff);
  if (f.state >= 5 || f.official) return "post";
  if (now < t) return "pre";
  return now - t > 3 * 3600_000 ? "post" : "in";
}

function side(t: LpFixture["home"], status: MatchStatus, goals: number | null): MatchSide {
  return {
    teamId: t.id,
    name: t.name,
    abbr: t.abbr,
    logo: t.logo,
    color: t.color,
    score: status === "pre" ? null : goals,
    record: null, // not in the league's feed
    form: null, // "?????" until later in the season
  };
}

// ------------------------------------------------------------------ Shapes

type LpTeamFull = { id: number; name: string; abbreviation: string; logo: string; teamColour: string };
type LpFixtureFull = {
  competitionName: string;
  fixtureCode: string;
  matchDate: string;
  fixtureStateTypeId: number;
  hasOfficialResult: boolean;
  canceledFixture: boolean;
  postponedFixture: boolean;
  halftime: boolean;
  time: string;
  homeTeamGoals: number;
  awayTeamGoals: number;
  liveHomeTeamGoals: number;
  liveAwayTeamGoals: number;
  homeTeam: LpTeamFull;
  awayTeam: LpTeamFull;
};
type LpFixture = ReturnType<typeof slim>;

function slim(f: LpFixtureFull) {
  const team = (t: LpTeamFull) => ({ id: String(t.id), name: t.name, abbr: t.abbreviation, logo: t.logo || null, color: t.teamColour || null });
  return {
    competitionName: f.competitionName,
    code: f.fixtureCode,
    kickoff: f.matchDate,
    state: f.fixtureStateTypeId,
    official: f.hasOfficialResult,
    canceled: f.canceledFixture,
    postponed: f.postponedFixture,
    halftime: f.halftime,
    time: f.time,
    homeGoals: f.homeTeamGoals,
    awayGoals: f.awayTeamGoals,
    liveHome: f.liveHomeTeamGoals,
    liveAway: f.liveAwayTeamGoals,
    home: team(f.homeTeam),
    away: team(f.awayTeam),
  };
}
