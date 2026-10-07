import type { League, Team } from "./types";
import mls from "@/data/leagues/usa.1.json";
import ligaPortugal from "@/data/leagues/por.1.json";
import ligaPortugal2 from "@/data/leagues/por.2.json";

// Add new leagues here after scraping them (scripts/scrape-wikipedia.mjs <id>).
export const LEAGUES = [mls, ligaPortugal, ligaPortugal2] as League[];

/** What the client needs for the country → league filter. */
export type LeagueSummary = { id: string; name: string; country: string; tier: number; source: string };
export const LEAGUE_SUMMARIES: LeagueSummary[] = LEAGUES.map(({ id, name, country, tier, source }) => ({ id, name, country, tier, source }));

export function findLeague(id: string) {
  return LEAGUES.find((l) => l.id === id);
}

export function findTeam(league: League, teamId: string): Team | undefined {
  return league.teams.find((t) => t.teamId === teamId);
}

const norm = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Coordinates for an ESPN venue: exact stadium name match, else the home team's stadium. */
export function venueCoords(league: League, venueName: string | undefined, homeEspnId: string) {
  if (venueName) {
    const n = norm(venueName);
    const all = [...league.teams.flatMap((t) => t.stadiums), ...(league.extraVenues ?? [])];
    const s = all.find((s) => s.lat != null && (norm(s.name) === n || (s.wikiTitle != null && norm(s.wikiTitle) === n)));
    if (s) return { lat: s.lat!, lng: s.lng! };
  }
  const s = findTeam(league, homeEspnId)?.stadiums.find((s) => s.lat != null);
  return s ? { lat: s.lat!, lng: s.lng! } : null;
}

/** A team's home stadium (first listed) with coordinates. */
export function homeStadium(league: League, teamId: string) {
  const s = findTeam(league, teamId)?.stadiums.find((s) => s.lat != null);
  return s ? { name: s.name, lat: s.lat!, lng: s.lng! } : null;
}
