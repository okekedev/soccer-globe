#!/usr/bin/env node
/**
 * Scrapes a league's teams and stadiums (with coordinates and capacity) from
 * Wikipedia, links each team to its ESPN id, and writes
 * src/data/leagues/<espnLeague>.json.
 *
 * Schedules, scores and rosters come live from ESPN at runtime; Wikipedia only
 * supplies what ESPN lacks (stadium coordinates). Re-run when a team moves
 * stadium or a new season page goes up:
 *   node scripts/scrape-wikipedia.mjs            # MLS (default)
 *   node scripts/scrape-wikipedia.mjs usa.1
 *   node scripts/scrape-wikipedia.mjs por.1
 *
 * To add another league, add an entry to LEAGUES below. The output format is
 * the same for every league, so the app picks it up without code changes.
 *
 * Data from Wikipedia is CC BY-SA 4.0 — the app shows an attribution link.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "soccer-globe/0.1 (open-source fan project)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LEAGUES = {
  "usa.1": {
    name: "Major League Soccer",
    country: "United States",
    tier: 1, // 1 = top division
    seasonPage: "2026_Major_League_Soccer_season",
    stadiumSection: "Stadiums and locations",
    // Data-source team name → Wikipedia article title, for names the fuzzy match misses.
    espnAliases: {
      LAFC: "Los Angeles FC",
      "Red Bull New York": "New York Red Bulls",
    },
    // ESPN venue names that aren't a team's home stadium on the season page
    // (alternate venues, other spellings) → Wikipedia article for coordinates.
    extraVenues: {
      "Levi's Stadium": "Levi's Stadium",
      "SeatGeek Stadium": "SeatGeek Stadium",
      "Stade Saputo": "Saputo Stadium",
    },
  },
  "por.1": {
    name: "Liga Portugal",
    country: "Portugal",
    tier: 1,
    seasonPage: "2026–27_Primeira_Liga",
    stadiumSection: "Location and stadiums",
    espnAliases: {},
    extraVenues: {},
  },
  // Not on ESPN: schedule, live scores and crests come from the league's own
  // site (ligaportugal.pt), which identifies teams by its own ids.
  "por.2": {
    name: "Liga Portugal 2",
    country: "Portugal",
    tier: 2,
    // calendarName is how the league's calendar feed labels this competition.
    provider: { type: "ligaportugal", competition: "ligaportugalmeusuper", calendarName: "Liga Portugal Meu Super", season: "20262027" },
    seasonPage: "2026–27_Liga_Portugal_2",
    stadiumSection: "Location and stadiums",
    espnAliases: {
      "L. Lourosa FC": "Lusitânia F.C.",
    },
    extraVenues: {},
  },
};

// ---------------------------------------------------------------- Wikipedia

async function wiki(params) {
  const url = new URL("https://en.wikipedia.org/w/api.php");
  for (const [k, v] of Object.entries({ format: "json", formatversion: "2", ...params })) {
    url.searchParams.set(k, v);
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.ok) return res.json();
    if (res.status !== 429 || attempt >= 5) throw new Error(`Wikipedia ${res.status} for ${url}`);
    const wait = Number(res.headers.get("retry-after")) || 2 ** attempt * 5;
    console.warn(`  … rate limited, waiting ${wait}s`);
    await sleep(wait * 1000);
  }
}

async function wikitext(page, section) {
  const params = { action: "parse", page, prop: "wikitext", redirects: "1" };
  if (section !== undefined) params.section = String(section);
  const d = await wiki(params);
  if (d.error) throw new Error(`Wikipedia: ${page}: ${d.error.info}`);
  return d.parse.wikitext;
}

async function sectionIndex(page, heading) {
  const d = await wiki({ action: "parse", page, prop: "sections", redirects: "1" });
  const s = d.parse.sections.find((x) => x.line.toLowerCase() === heading.toLowerCase());
  if (!s) throw new Error(`No "${heading}" section on ${page}`);
  return s.index;
}

/** Coordinates for up to 50 titles per request, following redirects. */
async function coordinates(titles) {
  const out = {};
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const d = await wiki({ action: "query", prop: "coordinates", titles: batch.join("|"), redirects: "1", colimit: "max" });
    // Map redirect/normalized targets back to the requested title.
    const back = {};
    for (const r of [...(d.query.normalized ?? []), ...(d.query.redirects ?? [])]) back[r.to] = back[r.from] ?? r.from;
    for (const p of d.query.pages) {
      const c = p.coordinates?.[0];
      if (c) out[back[p.title] ?? p.title] = { lat: c.lat, lng: c.lon };
    }
  }
  return out;
}

// ------------------------------------------------------------ Wikitext utils

/** Split a template body on top-level pipes (ignores pipes inside [[ ]] / {{ }}). */
function splitParams(body) {
  const parts = [];
  let depth = 0, cur = "";
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === "[[" || two === "{{") { depth++; cur += two; i++; continue; }
    if (two === "]]" || two === "}}") { depth--; cur += two; i++; continue; }
    if (body[i] === "|" && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += body[i];
  }
  parts.push(cur);
  return parts;
}

/** Find every {{name ...}} template (case-insensitive), with balanced braces. */
function templates(text, name) {
  const found = [];
  const re = new RegExp(`\\{\\{\\s*${name}\\s*\\|`, "gi");
  let m;
  while ((m = re.exec(text))) {
    let depth = 0, i = m.index;
    for (; i < text.length; i++) {
      if (text.startsWith("{{", i)) { depth++; i++; }
      else if (text.startsWith("}}", i)) { depth--; i++; if (depth === 0) break; }
    }
    const body = text.slice(m.index + 2, i - 1);
    const [, ...rest] = splitParams(body);
    const params = {};
    for (const p of rest) {
      const eq = p.indexOf("=");
      if (eq > 0) params[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim();
    }
    found.push(params);
  }
  return found;
}

/** [[Target|Label]] → Label, strip refs/templates/markup. */
function plain(s = "") {
  return s
    .replace(/<ref[^>]*\/>/g, "")
    .replace(/<ref[\s\S]*?<\/ref>/g, "")
    .replace(/\{\{\s*nowrap\s*\|((?:[^{}]|\{\{[^{}]*\}\})*)\}\}/gi, "$1")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/'''?/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

/** All [[link targets]] in a string, in order. */
function linkTargets(s) {
  return [...s.matchAll(/\[\[([^|\]]+)(?:\|[^\]]*)?\]\]/g)].map((m) => m[1].trim());
}

const STOP = new Set(["fc", "sc", "cf", "sl", "cd", "ac", "gd", "cs", "ud", "sad", "fk", "de", "da", "do", "dos", "das", "the", "club", "clube", "futebol"]);
const tokens = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/).filter((w) => w && !STOP.has(w));

/** Overlap of name tokens relative to the shorter name: 1 = one name contains the other. */
function similarity(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

// ------------------------------------------------------------------ Scrape

/** Strip a leading cell attribute like `align="center"|`. */
const cellValue = (c) => c.replace(/^\s*[a-z-]+\s*=\s*"[^"]*"\s*\|(?!\|)/i, "").trim();

async function stadiumTable(seasonPage, sectionName) {
  const idx = await sectionIndex(seasonPage, sectionName);
  const text = await wikitext(seasonPage, idx);
  const table = text.slice(text.indexOf("{|"), text.indexOf("\n|}") + 3);
  const [head, ...rows] = table.split(/\n\|-/);
  // Columns come from the header row so tables with extra columns
  // (Location, last season, …) still parse.
  const headers = (rows.length && !head.includes("!") ? rows.shift() : head)
    .split("\n").filter((l) => l.startsWith("!")).flatMap((l) => l.slice(1).split("!!")).map((h) => plain(cellValue(h)).toLowerCase());
  const col = (...names) => headers.findIndex((h) => names.some((n) => h.startsWith(n)));
  const iTeam = col("team", "club"), iStadium = col("stadium", "venue", "ground"), iCap = col("capacity");
  if (iTeam < 0 || iStadium < 0) throw new Error(`Couldn't find Team/Stadium columns in: ${headers.join(" | ")}`);

  const teams = [];
  for (const row of rows) {
    const cells = row.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("|}") && !l.startsWith("|+"))
      .flatMap((l) => l.slice(1).split("||")).map(cellValue);
    if (cells.length <= Math.max(iTeam, iStadium)) continue;
    const teamCell = cells[iTeam];
    // Drop footnotes so their links aren't mistaken for the stadium.
    const stadiumCell = cells[iStadium].replace(/\{\{\s*(efn|cref2|refn|note)[^{}]*(\{\{[^{}]*\}\}[^{}]*)*\}\}/gi, "");
    const capCell = iCap >= 0 ? cells[iCap] ?? "" : "";
    const team = linkTargets(teamCell)[0];
    if (!team) continue;
    const label = plain(teamCell.replace(/<sup>.*?<\/sup>/g, ""));
    const parts = stadiumCell.split(/<hr\s*\/?>/);
    const caps = capCell.split(/<hr\s*\/?>/).map((c) => Number(plain(c).replace(/[^0-9]/g, "")) || null);
    teams.push({
      wikiTitle: team,
      label,
      name: label || team,
      stadiums: parts.map((part, i) => {
        const link = linkTargets(part)[0] ?? null; // unlinked stadiums fall back to team coordinates
        return { name: plain(part).replace(/,\s*at\s.*$/, "") || link, wikiTitle: link, capacity: caps[i] ?? null };
      }),
    });
  }
  // Team-level fallback coordinates from the season page's location map.
  const fallback = {};
  for (const p of templates(text, "Location map~")) {
    const t = linkTargets(p.label ?? "")[0];
    if (t && p.lat && p.long) fallback[t] = { lat: Number(p.lat), lng: Number(p.long) };
  }
  return { teams, fallback };
}

/** Pair each ESPN team with its Wikipedia team: aliases first, then best name similarity. */
function linkTeams(teams, espn, aliases) {
  const taken = new Set();
  for (const e of espn) {
    const alias = aliases[e.name];
    let best = null, bestScore = 0, tie = false;
    for (const t of teams) {
      if (taken.has(t)) continue;
      const score = alias ? (t.wikiTitle === alias ? 2 : 0) : Math.max(similarity(e.name, t.wikiTitle), similarity(e.name, t.label));
      if (score > bestScore) { best = t; bestScore = score; tie = false; }
      else if (score === bestScore && score > 0) tie = true;
    }
    if (!best || bestScore < 0.5 || tie) {
      const left = teams.filter((t) => !taken.has(t)).map((t) => t.wikiTitle).join(", ");
      throw new Error(`Team "${e.name}" has no clear Wikipedia match — add it to espnAliases. Unmatched Wikipedia teams: ${left}`);
    }
    taken.add(best);
    Object.assign(best, { teamId: e.id, name: e.name, abbr: e.abbr, color: e.color, logo: e.logo });
  }
}

/** Teams as the league's official site lists them (id, name, crest). */
async function ligaPortugalTeams({ competition, season }) {
  const res = await fetch(`https://www.ligaportugal.pt/api/v1/competition/teams?season=${season}&competition=${competition}`);
  if (!res.ok) throw new Error(`ligaportugal.pt ${res.status} for ${competition}`);
  return (await res.json()).map((t) => ({
    id: String(t.id), name: t.name, abbr: t.abbreviation,
    color: t.teamColour || null, logo: t.logo || null,
  }));
}

async function espnTeams(league) {
  const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/teams`);
  const d = await res.json();
  return d.sports[0].leagues[0].teams.map(({ team: t }) => ({
    id: t.id, name: t.displayName, abbr: t.abbreviation,
    color: t.color ? `#${t.color}` : null, logo: t.logos?.[0]?.href ?? null,
  }));
}

async function main() {
  const leagueId = process.argv[2] ?? "usa.1";
  const cfg = LEAGUES[leagueId];
  if (!cfg) throw new Error(`Unknown league ${leagueId}. Known: ${Object.keys(LEAGUES).join(", ")}`);

  console.log(`→ ${cfg.name}: stadium table from ${cfg.seasonPage}`);
  const { teams, fallback } = await stadiumTable(cfg.seasonPage, cfg.stadiumSection);
  console.log(`  ${teams.length} teams`);

  const extra = Object.entries(cfg.extraVenues ?? {});
  const coords = await coordinates([
    ...teams.flatMap((t) => t.stadiums.map((s) => s.wikiTitle).filter(Boolean)),
    ...extra.map(([, title]) => title),
  ]);
  const extraVenues = extra.map(([name, wikiTitle]) => {
    if (!coords[wikiTitle]) console.warn(`  ! no coordinates for extra venue ${wikiTitle}`);
    return { name, wikiTitle, ...(coords[wikiTitle] ?? { lat: null, lng: null }) };
  });
  for (const t of teams) {
    for (const s of t.stadiums) {
      const c = (s.wikiTitle && coords[s.wikiTitle]) ?? fallback[t.wikiTitle];
      if (!c) console.warn(`  ! no coordinates for ${s.name}`);
      Object.assign(s, c ?? { lat: null, lng: null });
    }
  }

  const provider = cfg.provider ?? { type: "espn" };
  const sourceTeams = provider.type === "ligaportugal" ? await ligaPortugalTeams(provider) : await espnTeams(leagueId);
  linkTeams(teams, sourceTeams, cfg.espnAliases);
  const unmatched = teams.filter((t) => !t.teamId).map((t) => t.wikiTitle);
  if (unmatched.length) console.warn(`  ! Wikipedia teams with no data-source match: ${unmatched.join(", ")}`);

  for (const t of teams) {
    console.log(`  ${t.name.padEnd(26)} ← ${t.wikiTitle.padEnd(30)} ${t.stadiums.map((s) => s.name).join(" / ")}`);
    delete t.label;
  }

  const out = {
    id: leagueId,
    name: cfg.name,
    country: cfg.country,
    tier: cfg.tier,
    provider: cfg.provider ?? { type: "espn" },
    source: `https://en.wikipedia.org/wiki/${cfg.seasonPage}`,
    license: "CC BY-SA 4.0 (Wikipedia)",
    scrapedAt: new Date().toISOString(),
    teams,
    extraVenues,
  };
  const file = join(ROOT, "src", "data", "leagues", `${leagueId}.json`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`✓ wrote ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
