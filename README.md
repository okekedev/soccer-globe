# Soccer Globe

A 3D globe of soccer games. Every stadium with a game coming up shows the home
team's crest; live games pulse with a green glow. Click a crest for the score
or kickoff time (in your own time zone), both teams' records, the starting
lineups once they're announced, and how long the drive is from where you are.

Leagues so far:

| Country | League | Schedule, scores, lineups |
| --- | --- | --- |
| United States | Major League Soccer | ESPN |
| Portugal | Liga Portugal | ESPN |
| Portugal | Liga Portugal 2 | ligaportugal.pt |

Stadium locations come from Wikipedia (CC BY-SA 4.0).

## Run it locally

```sh
cd web
npm install
cp .env.example .env.local   # then paste your Mapbox public token (pk.…)
npm run dev
```

Open http://localhost:3000. A free Mapbox account gives you a public token at
https://account.mapbox.com/access-tokens/ — restrict it to your own domains.

## How the data works

- `web/scripts/scrape-wikipedia.mjs` reads a league's Wikipedia season page for
  each team's stadium and its coordinates, matches the teams to the data
  source's team ids, and writes `web/src/data/leagues/<league>.json`. Run it
  when a team moves stadium or a new season starts:
  `node scripts/scrape-wikipedia.mjs usa.1`
- Schedules, live scores, records and lineups are fetched live by the app's API
  routes (`web/src/app/api/*`), cached on the server, and refreshed every
  minute while games are on.

## Adding a league

1. Add an entry to `LEAGUES` in `web/scripts/scrape-wikipedia.mjs`: the ESPN
   league code (see ESPN's league list), the Wikipedia season page, and the
   name of its stadiums section. Leagues ESPN doesn't carry need their own
   data source (see `web/src/lib/ligaportugal.ts` for an example).
2. Run the scraper for it. If a team name doesn't match its Wikipedia article,
   the script stops and tells you which alias to add.
3. Import the new JSON file in `web/src/lib/leagues.ts`.

## Stack

Next.js, React, Mapbox GL (globe projection, Mapbox Standard style), Tailwind CSS.
