// Shape of src/data/leagues/<id>.json, written by scripts/scrape-wikipedia.mjs.
export type League = {
  id: string; // ESPN league code, e.g. "usa.1"
  name: string;
  country: string;
  tier: number; // 1 = top division, 2 = second, …
  // Where schedules/scores come from. ESPN by default; leagues ESPN doesn't
  // carry use the league's own site.
  provider: { type: "espn" } | { type: "ligaportugal"; competition: string; calendarName: string; season: string };
  source: string;
  license: string;
  scrapedAt: string;
  teams: Team[];
  extraVenues: { name: string; wikiTitle: string; lat: number | null; lng: number | null }[];
};

export type Team = {
  wikiTitle: string;
  teamId?: string;
  name: string;
  abbr?: string;
  color?: string | null;
  logo?: string | null;
  stadiums: Stadium[];
};

export type Stadium = {
  name: string;
  wikiTitle: string | null; // null when the season page doesn't link the stadium
  capacity: number | null;
  lat: number | null;
  lng: number | null;
};

// Rosters come live from ESPN (see getRoster).
export type Player = {
  no: string | null;
  name: string;
  pos: string | null; // G / D / M / F
  nat: string | null;
};

// What /api/matches returns.
export type MatchStatus = "pre" | "in" | "post";

export type MatchSide = {
  teamId: string;
  name: string;
  abbr: string;
  logo: string | null;
  color: string | null;
  score: number | null;
  record: string | null; // W-D-L
  form: string | null; // e.g. "DWDLD", most recent last
};

export type Match = {
  id: string;
  league: string;
  kickoff: string; // ISO UTC
  status: MatchStatus;
  detail: string; // "FT", "45'", "Sat, October 10th at 1:00 PM EDT"
  home: MatchSide;
  away: MatchSide;
  venue: { name: string; city: string | null; lat: number; lng: number } | null;
};

// Lineups (ESPN game summary). Published about an hour before kickoff.
export type LineupPlayer = {
  no: string | null;
  name: string;
  pos: string | null; // detailed position, e.g. "CD-L"; "SUB" on the bench
  on: string | null; // minute they came on, e.g. "55'"
  off: string | null; // minute they were subbed off
};

export type Lineup = {
  formation: string | null;
  starters: LineupPlayer[];
  bench: LineupPlayer[];
};
