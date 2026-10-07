import { cacheLife } from "next/cache";
import type { League, Lineup, LineupPlayer, Match, MatchSide, MatchStatus, Player } from "./types";
import { venueCoords } from "./leagues";

// ESPN's public scoreboard feed. Unofficial and undocumented: no key needed,
// but it can change without notice. Date ranges aren't supported for soccer,
// so we fetch one day at a time and cache each day separately.
const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";

/** yyyymmdd in UTC. */
export function espnDate(d: Date) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

async function fetchDay(leagueId: string, day: string, recent: boolean) {
  "use cache";
  // Days around today can have live games: refresh every minute.
  // Older days are settled, so an hourly refresh is plenty.
  if (recent) cacheLife({ stale: 30, revalidate: 60, expire: 3600 });
  else cacheLife("hours");
  const res = await fetch(`${BASE}/${leagueId}/scoreboard?dates=${day}`);
  if (!res.ok) throw new Error(`ESPN ${res.status} for ${leagueId} ${day}`);
  return (await res.json()) as EspnScoreboard;
}

export async function getMatches(league: League, from: Date, to: Date): Promise<Match[]> {
  const days: string[] = [];
  for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) days.push(espnDate(d));

  const now = Date.now();
  const boards = await Promise.all(
    days.map((day) => {
      const t = Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8));
      const recent = t > now - 2 * 86400_000;
      return fetchDay(league.id, day, recent).catch((e) => {
        console.error(e);
        return { events: [] } as EspnScoreboard;
      });
    }),
  );

  const seen = new Set<string>();
  const matches: Match[] = [];
  for (const ev of boards.flatMap((b) => b.events ?? [])) {
    if (seen.has(ev.id)) continue; // late kickoffs can show up on two UTC days
    seen.add(ev.id);
    const c = ev.competitions[0];
    const home = c.competitors.find((x) => x.homeAway === "home")!;
    const away = c.competitors.find((x) => x.homeAway === "away")!;
    const coords = venueCoords(league, c.venue?.fullName, home.team.id);
    matches.push({
      id: ev.id,
      league: league.id,
      kickoff: ev.date,
      status: ev.status.type.state,
      detail: ev.status.type.state === "in" ? ev.status.displayClock : ev.status.type.shortDetail,
      home: side(home, ev.status.type.state),
      away: side(away, ev.status.type.state),
      venue: coords ? { name: c.venue?.fullName ?? "", city: c.venue?.address?.city ?? null, ...coords } : null,
    });
  }
  return matches.sort((a, b) => a.kickoff.localeCompare(b.kickoff));
}

function side(c: EspnCompetitor, state: MatchStatus): MatchSide {
  return {
    teamId: c.team.id,
    name: c.team.displayName,
    abbr: c.team.abbreviation,
    logo: c.team.logo ?? null,
    color: c.team.color ? `#${c.team.color}` : null,
    // ESPN reports "0" before kickoff; only show a score once the game starts.
    score: state !== "pre" && c.score != null && c.score !== "" ? Number(c.score) : null,
    record: c.records?.find((r) => r.type === "total")?.summary ?? null,
    form: c.form ?? null,
  };
}

// Only the fields we read.
type EspnScoreboard = { events?: EspnEvent[] };
type EspnEvent = {
  id: string;
  date: string;
  status: { displayClock: string; type: { state: MatchStatus; shortDetail: string } };
  competitions: {
    venue?: { fullName: string; address?: { city?: string } };
    competitors: EspnCompetitor[];
  }[];
};
type EspnCompetitor = {
  homeAway: "home" | "away";
  score?: string;
  form?: string;
  records?: { type: string; summary: string }[];
  team: { id: string; displayName: string; abbreviation: string; logo?: string; color?: string };
};

export async function getRoster(leagueId: string, teamId: string): Promise<Player[]> {
  "use cache";
  cacheLife("hours");
  const res = await fetch(`${BASE}/${leagueId}/teams/${teamId}/roster`);
  if (!res.ok) throw new Error(`ESPN ${res.status} for roster ${leagueId}/${teamId}`);
  const d = (await res.json()) as { athletes?: EspnAthlete[] };
  const order = { G: 0, D: 1, M: 2, F: 3 } as Record<string, number>;
  return (d.athletes ?? [])
    .map((a) => ({
      no: a.jersey ?? null,
      name: a.displayName,
      pos: a.position?.abbreviation ?? null,
      nat: a.citizenship ?? null,
    }))
    .sort((a, b) => (order[a.pos ?? ""] ?? 9) - (order[b.pos ?? ""] ?? 9) || Number(a.no ?? 999) - Number(b.no ?? 999));
}

type EspnAthlete = {
  displayName: string;
  jersey?: string;
  citizenship?: string;
  position?: { abbreviation: string };
};

/**
 * Starting XI, formation and bench per team (keyed by team id), with
 * substitution minutes. Empty until lineups are announced. Live games refresh
 * every minute so subs show up as they happen.
 */
export async function getLineups(leagueId: string, eventId: string, live: boolean): Promise<Record<string, Lineup>> {
  "use cache";
  if (live) cacheLife({ stale: 30, revalidate: 60, expire: 3600 });
  else cacheLife("minutes");
  const res = await fetch(`${BASE}/${leagueId}/summary?event=${eventId}`);
  if (!res.ok) throw new Error(`ESPN ${res.status} for summary ${leagueId}/${eventId}`);
  const d = (await res.json()) as EspnSummary;

  // "X replaces Y" events: participants are [coming on, going off].
  const on: Record<string, string> = {}, off: Record<string, string> = {};
  for (const e of d.keyEvents ?? []) {
    if (e.type?.type !== "substitution") continue;
    const [inP, outP] = e.participants ?? [];
    const minute = e.clock?.displayValue ?? "";
    if (inP) on[inP.athlete.id] = minute;
    if (outP) off[outP.athlete.id] = minute;
  }

  const out: Record<string, Lineup> = {};
  for (const r of d.rosters ?? []) {
    const players = r.roster ?? [];
    if (!players.some((p) => p.starter)) continue; // not announced yet
    const toPlayer = (p: EspnRosterEntry): LineupPlayer => ({
      no: p.jersey ?? null,
      name: p.athlete.displayName,
      pos: p.position?.abbreviation ?? null,
      on: on[p.athlete.id] ?? null,
      off: off[p.athlete.id] ?? null,
    });
    out[r.team.id] = {
      formation: r.formation ?? null,
      starters: players.filter((p) => p.starter).sort((a, b) => (a.formationPlace ?? 99) - (b.formationPlace ?? 99)).map(toPlayer),
      // Subs who came on first (in order of their minute), then the unused bench.
      bench: players
        .filter((p) => !p.starter)
        .map(toPlayer)
        .sort((a, b) => (a.on ? parseInt(a.on) : 999) - (b.on ? parseInt(b.on) : 999)),
    };
  }
  return out;
}

type EspnSummary = {
  rosters?: { team: { id: string }; formation?: string; roster?: EspnRosterEntry[] }[];
  keyEvents?: {
    type?: { type?: string };
    clock?: { displayValue?: string };
    participants?: { athlete: { id: string } }[];
  }[];
};
type EspnRosterEntry = {
  starter: boolean;
  jersey?: string;
  formationPlace?: number;
  athlete: { id: string; displayName: string };
  position?: { abbreviation: string };
};
