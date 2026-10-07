"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Map, { Marker, NavigationControl, type MapRef } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import type mapboxgl from "mapbox-gl";
import type { LeagueSummary } from "@/lib/leagues";
import type { Lineup, LineupPlayer, Match, MatchSide, Player } from "@/lib/types";

// Mapbox Standard: 3D buildings, landmarks and day/dusk/night lighting.
// Token goes in .env.local as NEXT_PUBLIC_MAPBOX_TOKEN (public "pk." token;
// restrict it to your domains in the Mapbox dashboard).
const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
const GLOBE_VIEW = { longitude: -50, latitude: 35, zoom: 2.2, pitch: 0, bearing: 0 };

// Each lighting is a Mapbox style plus its "basemap" config.
const LIGHTS = {
  dawn: { label: "Dawn", style: "mapbox://styles/mapbox/standard", config: { lightPreset: "dawn", theme: "default" } },
  day: { label: "Day", style: "mapbox://styles/mapbox/standard", config: { lightPreset: "day", theme: "faded" } },
  dusk: { label: "Dusk", style: "mapbox://styles/mapbox/standard", config: { lightPreset: "dusk", theme: "default" } },
  night: { label: "Night", style: "mapbox://styles/mapbox/standard", config: { lightPreset: "night", theme: "default" } },
  satellite: { label: "Satellite", style: "mapbox://styles/mapbox/standard-satellite", config: { lightPreset: "day" } },
} as const;
type Light = keyof typeof LIGHTS;

// "Your time" (the default) follows the viewer's local clock.
type Look = "auto" | Exclude<Light, "dawn">;
const LOOK_CHOICES: { id: Look; label: string }[] = [
  { id: "auto", label: "Your time" },
  { id: "night", label: "Night" },
  { id: "dusk", label: "Dusk" },
  { id: "day", label: "Day" },
  { id: "satellite", label: "Satellite" },
];
function lightForHour(h: number): Light {
  if (h >= 5 && h < 7) return "dawn";
  if (h >= 7 && h < 17) return "day";
  if (h >= 17 && h < 20) return "dusk";
  return "night";
}

// Space around the globe: pure black with faint stars and a thin atmosphere rim,
// like photos from orbit. "color" is the haze at the horizon, "high-color" the
// glow at the planet's edge; a small horizon-blend keeps that rim tight.
const SPACE = { "space-color": "#000000", "star-intensity": 0.45, "horizon-blend": 0.03, range: [0.8, 8] as [number, number] };
const FOG: Record<Light, mapboxgl.FogSpecification> = {
  dawn: { ...SPACE, color: "#3a3550", "high-color": "#c77d6b" },
  day: { ...SPACE, color: "#c9dcf0", "high-color": "#2563eb", "star-intensity": 0.25 },
  dusk: { ...SPACE, color: "#3b2a4a", "high-color": "#3b5bdb" },
  night: { ...SPACE, color: "#0f1a33", "high-color": "#1d4ed8" },
  satellite: { ...SPACE, color: "#ffffff", "high-color": "#f1f5f9", "star-intensity": 0.25 }, // white glow
};

const DAY_OPTIONS = [0, 1, 3, 7, 14, 30];

type Venue = {
  key: string;
  name: string;
  city: string | null;
  lat: number;
  lng: number;
  game: Match; // the one game this pin shows: live, else next upcoming, else most recent
};

export default function MatchGlobe({ leagues }: { leagues: LeagueSummary[] }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedLeagues, setSelectedLeagues] = useState<string[]>(() => leagues.map((l) => l.id));
  const [past, setPast] = useState(0);
  const [next, setNext] = useState(7);
  const [look, setLook] = useState<Look>("auto");
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 5 * 60_000); // re-check the light every 5 min
    return () => clearInterval(id);
  }, []);
  const light: Light = look === "auto" ? lightForHour(clock.getHours()) : look;
  const [rotate, setRotate] = useState(true);
  const [matches, setMatches] = useState<Match[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [venueKey, setVenueKey] = useState<string | null>(null);
  const [map, setMap] = useState<MapRef | null>(null);
  // Geolocation callbacks outlive renders, so they read the map through a ref.
  const mapRef = useRef<MapRef | null>(null);
  useEffect(() => {
    mapRef.current = map;
    // Handy for debugging camera behavior from the browser console (dev only).
    if (process.env.NODE_ENV !== "production") (window as { soccerMap?: unknown }).soccerMap = map?.getMap();
  }, [map]);
  const [me, setMe] = useState<{ lat: number; lng: number } | null>(null);
  const [geo, setGeo] = useState<"off" | "locating" | "on" | "denied">("off");
  const watchId = useRef<number | null>(null);
  const flyOnFix = useRef(false);

  // Location is opt-in: nothing is asked on load. The locate button (or the
  // "add your location" link in a stadium panel) starts it; after that the
  // blue dot follows the viewer and drive times appear.
  function startLocating(fly: boolean) {
    if (!("geolocation" in navigator)) return setGeo("denied");
    flyOnFix.current = fly;
    if (watchId.current !== null) return;
    setGeo("locating");
    watchId.current = navigator.geolocation.watchPosition(
      (p) => {
        const pos = { lat: p.coords.latitude, lng: p.coords.longitude };
        setMe(pos);
        setGeo("on");
        if (flyOnFix.current) {
          flyOnFix.current = false;
          mapRef.current?.flyTo({ center: [pos.lng, pos.lat], zoom: 10, pitch: 0, bearing: 0, duration: 2500, essential: true });
        }
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
          watchId.current = null;
          setMe(null);
          setGeo("denied");
        }
      },
      { enableHighAccuracy: false, maximumAge: 60_000 },
    );
  }

  function locate() {
    if (me) map?.flyTo({ center: [me.lng, me.lat], zoom: 10, pitch: 0, bearing: 0, duration: 2500, essential: true });
    else startLocating(true);
  }

  // Returning visitors who already allowed location get the dot back without a prompt.
  useEffect(() => {
    navigator.permissions
      ?.query({ name: "geolocation" })
      .then((status) => status.state === "granted" && startLocating(false))
      .catch(() => {});
    return () => {
      if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    };
  }, []);

  // Click a pin → fly down to a tilted 3D view of the stadium; close → back out to the globe.
  // Tilt only makes sense up close: the allowed tilt shrinks as you zoom out
  // and is zero at globe level, so zooming out of a tilted 3D stadium view
  // ends on a full, upright globe instead of a sideways view of its top half.
  useEffect(() => {
    if (!map) return;
    const m = map.getMap();
    const maxTiltFor = (zoom: number) => (zoom <= 3 ? 0 : zoom >= 7 ? 85 : ((zoom - 3) / 4) * 85);
    const onZoom = () => m.setMaxPitch(maxTiltFor(m.getZoom()));
    const onZoomEnd = () => {
      // Back at globe level: also turn north up again.
      if (m.getZoom() < 4 && Math.abs(m.getBearing()) > 0.5 && !m.isEasing()) m.easeTo({ bearing: 0, duration: 600 });
    };
    m.on("zoom", onZoom);
    m.on("zoomend", onZoomEnd);
    onZoom();
    return () => {
      m.off("zoom", onZoom);
      m.off("zoomend", onZoomEnd);
    };
  }, [map]);

  // Auto-rotation state. venueOpen is set right here in the click handlers (not
  // only after re-render) so a spin step can't hijack the camera mid-flight.
  const spinRef = useRef({ enabled: true, venueOpen: false, pausedUntil: 0 });

  function openVenue(v: Venue) {
    spinRef.current.venueOpen = true;
    map?.stop(); // cancel a spin step already in flight
    setVenueKey(v.key);
    setMenuOpen(false);
    // Pad the camera by the panel's size so the stadium lands in the middle of
    // the part of the map you can still see (panel is on the right on desktop,
    // a bottom sheet on phones).
    const desktop = window.innerWidth >= 640;
    const padding = desktop ? { top: 0, bottom: 0, left: 0, right: 404 } : { top: 0, bottom: window.innerHeight * 0.6, left: 0, right: 0 };
    const camera = { center: [v.lng, v.lat] as [number, number], zoom: 16, pitch: 60, bearing: -20, padding, essential: true };
    const here = map?.getCenter();
    const nearby = here && map!.getZoom() > 8 && haversineKm({ lat: here.lat, lng: here.lng }, v) < 300;
    if (nearby) map?.easeTo({ ...camera, duration: 1500 }); // no zoom-out arc between neighbors
    else map?.flyTo({ ...camera, duration: 3000 });
  }
  // Closing steps back a few zoom levels and re-centers the stadium on the full
  // screen now that the panel is gone, even if the map was moved meanwhile.
  function closeVenue() {
    if (!venueKey) return;
    const [lat, lng] = venueKey.split(",").map(Number); // venue keys are "lat,lng"
    spinRef.current.venueOpen = false;
    setVenueKey(null);
    map?.easeTo({
      center: [lng, lat],
      zoom: Math.max(map.getZoom() - 3, 3), // step back a little, stadium stays centered
      pitch: 40,
      padding: { top: 0, bottom: 0, left: 0, right: 0 },
      duration: 1200,
    });
  }
  function backToGlobe() {
    spinRef.current.venueOpen = false;
    setVenueKey(null);
    const c = map?.getCenter();
    map?.flyTo({
      center: c ? [c.lng, c.lat] : [GLOBE_VIEW.longitude, GLOBE_VIEW.latitude],
      zoom: GLOBE_VIEW.zoom,
      pitch: 0,
      bearing: 0,
      padding: { top: 0, bottom: 0, left: 0, right: 0 },
      duration: 2500,
      essential: true,
    });
  }

  // Slow auto-rotation while zoomed out. Pauses while the viewer is dragging or
  // a stadium is open, and picks back up when the camera comes to rest.
  useEffect(() => {
    spinRef.current.enabled = rotate;
    spinRef.current.venueOpen = venueKey !== null;
  }, [rotate, venueKey]);
  useEffect(() => {
    if (!map) return;
    const m = map.getMap();
    const SECONDS_PER_TURN = 180;
    const MAX_SPIN_ZOOM = 5; // stop spinning once zoomed in past country level
    const SLOW_SPIN_ZOOM = 3;
    const PAUSE_MS = 60_000; // any click/drag/scroll/tap pauses the spin for a minute
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;

    const spin = () => {
      const st = spinRef.current;
      const zoom = m.getZoom();
      if (!st.enabled || st.venueOpen || Date.now() < st.pausedUntil || zoom > MAX_SPIN_ZOOM) return;
      let degrees = 360 / SECONDS_PER_TURN;
      if (zoom > SLOW_SPIN_ZOOM) degrees *= (MAX_SPIN_ZOOM - zoom) / (MAX_SPIN_ZOOM - SLOW_SPIN_ZOOM);
      const c = m.getCenter();
      c.lng -= degrees;
      m.easeTo({ center: c, duration: 1000, easing: (n) => n });
    };
    const pause = () => {
      spinRef.current.pausedUntil = Date.now() + PAUSE_MS;
      if (m.isEasing()) m.stop(); // halt a spin step already in flight
      clearTimeout(resumeTimer);
      resumeTimer = setTimeout(spin, PAUSE_MS + 50);
    };

    const events = ["mousedown", "touchstart", "wheel", "dragstart"] as const;
    for (const e of events) m.on(e, pause);
    m.on("moveend", spin);
    spin();
    return () => {
      for (const e of events) m.off(e, pause);
      m.off("moveend", spin);
      clearTimeout(resumeTimer);
    };
  }, [map]);

  // Turning rotation back on (or closing a stadium) restarts the spin, but only
  // when zoomed out to globe level; zoomed in, the camera must stay put.
  useEffect(() => {
    if (map && rotate && venueKey === null && !map.isMoving() && map.getZoom() <= 5 && Date.now() >= spinRef.current.pausedUntil) {
      const c = map.getCenter();
      map.easeTo({ center: [c.lng - 2, c.lat], duration: 1000, easing: (n) => n });
    }
  }, [map, rotate, venueKey]);

  // Apply the look's basemap config whenever the style (re)loads or the look changes.
  useEffect(() => {
    if (!map) return;
    const m = map.getMap();
    const apply = () => {
      const config = { ...LIGHTS[light].config, showPointOfInterestLabels: false, showTransitLabels: false };
      for (const [k, v] of Object.entries(config)) {
        try {
          m.setConfigProperty("basemap", k, v);
        } catch {
          // Not every style supports every option (e.g. satellite has no theme).
        }
      }
    };
    if (m.isStyleLoaded()) apply();
    m.on("style.load", apply);
    return () => {
      m.off("style.load", apply);
    };
  }, [map, light]);

  const leagueParam = [...selectedLeagues].sort().join(",");
  const filterKey = `${past}/${next}/${leagueParam}`;
  const loading = loadedFor !== filterKey;

  // Fetch, then poll: every minute while anything is live, every 5 minutes otherwise.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      if (!leagueParam) {
        setMatches([]);
        setLoadedFor(filterKey);
        return;
      }
      try {
        // With "Past: None" we still ask for yesterday (a game that kicked off before
        // midnight UTC can still be live) and drop the finished games below.
        const res = await fetch(`/api/matches?past=${Math.max(past, 1)}&next=${next}&leagues=${leagueParam}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { matches: Match[] };
        if (cancelled) return;
        setMatches(data.matches);
        setLoadedFor(filterKey);
        setError(null);
        const live = data.matches.some((m) => m.status === "in");
        timer = setTimeout(load, live ? 60_000 : 300_000);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        timer = setTimeout(load, 60_000);
      }
    }
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [past, next, leagueParam, filterKey]);

  const venues = useMemo(() => {
    // One pin per stadium showing a single game: live beats next upcoming beats most recent final.
    const rank = (m: Match) =>
      m.status === "in" ? [0, 0] : m.status === "pre" ? [1, Date.parse(m.kickoff)] : [2, -Date.parse(m.kickoff)];
    const better = (a: Match, b: Match) => {
      const [ra, ta] = rank(a), [rb, tb] = rank(b);
      return ra !== rb ? ra < rb : ta < tb;
    };
    const byKey: Record<string, Venue> = {};
    for (const m of matches) {
      if (!m.venue || (past === 0 && m.status === "post")) continue;
      const key = `${m.venue.lat.toFixed(4)},${m.venue.lng.toFixed(4)}`;
      const cur = byKey[key];
      if (!cur || better(m, cur.game)) {
        byKey[key] = { key, name: m.venue.name, city: m.venue.city, lat: m.venue.lat, lng: m.venue.lng, game: m };
      }
    }
    return Object.values(byKey);
  }, [matches, past]);

  const venue = venues.find((v) => v.key === venueKey) ?? null;
  const liveCount = venues.filter((v) => v.game.status === "in").length;

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-black text-floodlight">
      {!MAPBOX_TOKEN && (
        <div className="absolute inset-0 z-10 flex items-center justify-center p-6 text-center text-sm text-steel">
          <p className="max-w-sm">
            Add your Mapbox token to <code className="rounded bg-stand px-1 text-floodlight">.env.local</code> as{" "}
            <code className="rounded bg-stand px-1 text-floodlight">NEXT_PUBLIC_MAPBOX_TOKEN</code>, then restart the dev server.
          </p>
        </div>
      )}
      <Map
        ref={setMap}
        mapboxAccessToken={MAPBOX_TOKEN}
        initialViewState={GLOBE_VIEW}
        minZoom={1.3} // don't let the globe shrink to a dot
        mapStyle={LIGHTS[light].style}
        fog={FOG[light]}
        projection="globe"
        // Zoom on the middle of the screen, not the pointer, so a centered stadium stays centered.
        scrollZoom={{ around: "center" }}
        touchZoomRotate={{ around: "center" }}
        style={{ width: "100%", height: "100%" }}
        onClick={closeVenue}
      >
        <NavigationControl position="bottom-left" />
        {me && (
          <Marker longitude={me.lng} latitude={me.lat} anchor="center">
            <UserDot />
          </Marker>
        )}
        {venues.map((v) => (
          <Marker
            key={v.key}
            longitude={v.lng}
            latitude={v.lat}
            anchor="center"
            onClick={(e) => {
              e.originalEvent.stopPropagation();
              openVenue(v);
            }}
          >
            <Pin venue={v} selected={v.key === venueKey} />
          </Marker>
        ))}
      </Map>

      {/* Map buttons stacked just above Mapbox's zoom/compass group (32px wide, ends 135px from the bottom). */}
      <MapButton className="bottom-[183px]" onClick={backToGlobe} label="Back to globe">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
        </svg>
      </MapButton>
      <MapButton
        className="bottom-[143px]"
        onClick={locate}
        label={me ? "Go to my location" : "Show my location"}
        title={geo === "denied" ? "Location is blocked in your browser settings" : undefined}
      >
        <span
          className={`h-3 w-3 rounded-full border-2 ${
            me ? "border-white bg-blue-500" : geo === "locating" ? "animate-pulse border-blue-400" : "border-steel"
          }`}
        />
      </MapButton>

      {/* Menu: collapsed to a bar by default */}
      <div className="absolute left-3 top-3 z-20 max-h-[calc(100dvh-1.5rem)] w-[min(340px,calc(100vw-1.5rem))] overflow-y-auto rounded-xl bg-night/90 shadow-[0_10px_30px_rgba(0,0,0,0.5)] ring-1 ring-line backdrop-blur-md">
        <button
          onClick={() => setMenuOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
          aria-expanded={menuOpen}
        >
          <span className="font-display text-xl font-bold leading-none tracking-wide">Soccer Globe</span>
          <span className="flex items-center gap-2.5 text-sm text-steel">
            {liveCount > 0 && (
              <span className="flex items-center gap-1.5 font-medium text-pitch">
                <span className="h-1.5 w-1.5 rounded-full bg-pitch" />
                {liveCount} live
              </span>
            )}
            <span className="tabular">{loading ? "Loading" : `${venues.length} games`}</span>
            <Chevron className={menuOpen ? "rotate-180" : ""} />
          </span>
        </button>

        {menuOpen && (
          <div className="border-t border-line pb-1">
            {error && <p className="px-4 pt-3 text-sm text-red-300">Games didn’t load ({error}). Trying again in a minute.</p>}
            <Section title="Leagues" summary={`${selectedLeagues.length} of ${leagues.length} on`}>
              <LeagueFilter leagues={leagues} selected={selectedLeagues} onChange={setSelectedLeagues} />
            </Section>
            <Section title="Dates" summary={datesSummary(past, next)}>
              <DayPicker label="Recent results" value={past} onChange={setPast} />
              <DayPicker label="Coming up" value={next} onChange={setNext} />
            </Section>
            <Section
              title="Map"
              summary={`${look === "auto" ? `Your time (${LIGHTS[light].label.toLowerCase()})` : LIGHTS[light].label}${rotate ? ", rotating" : ""}`}
            >
              <div className="flex flex-wrap gap-1.5">
                {LOOK_CHOICES.map((c) => (
                  <Chip key={c.id} active={look === c.id} onClick={() => setLook(c.id)}>
                    {c.label}
                  </Chip>
                ))}
              </div>
              <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-steel">
                <input type="checkbox" checked={rotate} onChange={(e) => setRotate(e.target.checked)} />
                Rotate the globe
              </label>
            </Section>
            <Section title="Key">
              <Legend />
            </Section>
            <Section title="Sources">
              <p className="text-sm leading-relaxed text-steel">
                Schedules, scores and squads from ESPN and{" "}
                <a className="underline decoration-line underline-offset-2 hover:text-floodlight" href="https://www.ligaportugal.pt" target="_blank" rel="noreferrer">
                  Liga Portugal
                </a>
                . Stadium locations from Wikipedia (CC BY-SA):{" "}
                {leagues.map((l, i) => (
                  <span key={l.id}>
                    {i > 0 && ", "}
                    <a className="underline decoration-line underline-offset-2 hover:text-floodlight" href={l.source} target="_blank" rel="noreferrer">
                      {l.name}
                    </a>
                  </span>
                ))}
                .
              </p>
            </Section>
          </div>
        )}
      </div>

      {/* Detail panel */}
      {venue && (
        <aside className="absolute inset-x-0 bottom-0 z-10 max-h-[60dvh] overflow-y-auto rounded-t-xl bg-night/95 p-5 shadow-[0_-10px_30px_rgba(0,0,0,0.5)] ring-1 ring-line backdrop-blur-md sm:inset-x-auto sm:bottom-10 sm:right-3 sm:top-3 sm:max-h-none sm:w-[400px] sm:rounded-xl">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-display text-2xl font-semibold leading-tight">{venue.name}</h2>
              {venue.city && venue.city !== venue.name && <p className="text-sm text-steel">{venue.city}</p>}
              {me ? (
                <DriveTime from={me} to={venue} />
              ) : geo === "denied" ? (
                <p className="mt-1.5 text-sm text-steel">Location is blocked in your browser settings.</p>
              ) : (
                <button onClick={() => startLocating(false)} className="mt-1.5 text-sm text-amber hover:underline">
                  {geo === "locating" ? "Finding you…" : "Add your location to see the drive time"}
                </button>
              )}
            </div>
            <button
              onClick={closeVenue}
              className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xl leading-none text-steel hover:bg-stand hover:text-floodlight"
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <MatchDetail match={venue.game} />
        </aside>
      )}
    </div>
  );
}

function MapButton({
  className,
  onClick,
  label,
  title,
  children,
}: {
  className: string;
  onClick: () => void;
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={title ?? label}
      className={`absolute left-[10px] z-10 flex h-8 w-8 items-center justify-center rounded bg-night text-floodlight ring-1 ring-line hover:bg-stand ${className}`}
    >
      {children}
    </button>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-3 py-1 text-sm ${
        active ? "bg-amber font-semibold text-night" : "bg-stand text-steel hover:text-floodlight"
      }`}
    >
      {children}
    </button>
  );
}

/** A collapsible menu section; collapsed by default, current setting shown on the right. */
function Section({ title, summary, children }: { title: string; summary?: string; children: React.ReactNode }) {
  return (
    <details className="group border-b border-line/60 px-4 last:border-b-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-3 [&::-webkit-details-marker]:hidden">
        <span className="font-display text-lg font-semibold leading-none">{title}</span>
        <span className="flex items-center gap-2 text-right text-sm text-steel">
          {summary}
          <Chevron className="group-open:rotate-180" />
        </span>
      </summary>
      <div className="pb-4">{children}</div>
    </details>
  );
}

function Chevron({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" className={`h-3 w-3 shrink-0 transition-transform ${className}`} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M2.5 4.5 6 8l3.5-3.5" />
    </svg>
  );
}

const ORDINAL = ["", "1st", "2nd", "3rd", "4th", "5th"];
const tierLabel = (tier: number) => `${ORDINAL[tier] ?? `${tier}th`} division`;

function datesSummary(past: number, next: number) {
  const days = (n: number) => (n === 1 ? "1 day" : `${n} days`);
  const ahead = next === 0 ? "Live only" : `Live and next ${days(next)}`;
  return past === 0 ? ahead : `${ahead}, last ${days(past)}`;
}

/** Countries (each collapsible, with a checkbox for all its leagues) and their leagues by division. */
function LeagueFilter({
  leagues,
  selected,
  onChange,
}: {
  leagues: LeagueSummary[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState<string[]>([]);
  const countries = [...new Set(leagues.map((l) => l.country))].sort();
  const toggle = (ids: string[], on: boolean) =>
    onChange(on ? [...new Set([...selected, ...ids])] : selected.filter((id) => !ids.includes(id)));

  return (
    <ul className="space-y-2">
      {countries.map((country) => {
        const inCountry = leagues.filter((l) => l.country === country).sort((a, b) => a.tier - b.tier);
        const ids = inCountry.map((l) => l.id);
        const on = ids.filter((id) => selected.includes(id)).length;
        const isOpen = open.includes(country);
        return (
          <li key={country}>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                aria-label={`All leagues in ${country}`}
                checked={on === ids.length}
                ref={(el) => {
                  if (el) el.indeterminate = on > 0 && on < ids.length;
                }}
                onChange={(e) => toggle(ids, e.target.checked)}
              />
              <button
                onClick={() => setOpen(isOpen ? open.filter((c) => c !== country) : [...open, country])}
                className="flex flex-1 items-center justify-between text-left font-medium"
                aria-expanded={isOpen}
              >
                {country}
                <span className="flex items-center gap-2 text-sm font-normal text-steel">
                  {on} of {ids.length}
                  <Chevron className={isOpen ? "rotate-180" : ""} />
                </span>
              </button>
            </div>
            {isOpen && (
              <ul className="ml-6 mt-2 space-y-1.5">
                {inCountry.map((l) => (
                  <li key={l.id}>
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <input type="checkbox" checked={selected.includes(l.id)} onChange={(e) => toggle([l.id], e.target.checked)} />
                      <span className="flex-1">{l.name}</span>
                      <span className="text-steel">{tierLabel(l.tier)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function DayPicker({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="mt-4 first:mt-0">
      <div className="mb-1.5 text-sm text-steel">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {DAY_OPTIONS.map((d) => (
          <Chip key={d} active={value === d} onClick={() => onChange(d)}>
            {d === 0 ? "None" : d === 1 ? "1 day" : `${d} days`}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <ul className="space-y-1.5 text-sm text-steel">
      <li className="flex items-center gap-2.5">
        <span className="relative inline-flex h-2.5 w-2.5">
          <span className="absolute inset-0 animate-ping rounded-full bg-pitch/60" />
          <span className="relative h-2.5 w-2.5 rounded-full bg-pitch" />
        </span>
        Live: the crest pulses with a green glow
      </li>
      <li className="flex items-center gap-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-floodlight" />
        Coming up: the home team’s crest
      </li>
      <li className="flex items-center gap-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-steel/50" />
        Final: the crest fades to gray
      </li>
    </ul>
  );
}

/** The familiar "you are here" blue dot with a soft pulsing halo. */
function UserDot() {
  return (
    <div className="relative flex h-4 w-4 items-center justify-center" title="You are here">
      <span className="absolute h-10 w-10 animate-ping rounded-full bg-blue-500/25" />
      <span className="relative h-4 w-4 rounded-full border-[3px] border-white bg-blue-500 shadow-[0_1px_4px_rgba(0,0,0,0.5)]" />
    </div>
  );
}

/** The home team's crest: pulses with a green glow while live, faded once it's final. */
function Pin({ venue, selected }: { venue: Venue; selected: boolean }) {
  const { status } = venue.game;
  const live = status === "in" ? venue.game : null;
  const team = venue.game.home;
  return (
    // Centered on the stadium; the live score floats above without shifting the crest.
    <div className="relative cursor-pointer" title={`${team.name} at ${venue.name}`}>
      {live && (
        <div className="tabular absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded bg-night px-2 py-0.5 font-display text-sm font-semibold text-floodlight ring-1 ring-pitch">
          {live.home.abbr} {live.home.score}–{live.away.score} {live.away.abbr}
        </div>
      )}
      <div className={`relative transition-transform ${selected ? "scale-125" : "hover:scale-110"}`}>
        {status === "in" && <span className="absolute inset-0 animate-ping rounded-full bg-green-400/50" />}
        <div className={`relative flex h-10 w-10 items-center justify-center ${status === "in" ? "animate-crest-pulse" : ""} ${status === "post" ? "opacity-60 grayscale" : ""}`}>
          {team.logo ? (
            // eslint-disable-next-line @next/next/no-img-element -- small remote crests, no optimization needed
            <img src={team.logo} alt={team.name} className={`h-10 w-10 object-contain ${
                status === "in"
                  ? "drop-shadow-[0_0_10px_rgba(61,220,132,0.95)]" // pitch-green glow while live
                  : "drop-shadow-[0_3px_4px_rgba(0,0,0,0.6)]"
              }`} draggable={false} />
          ) : (
            <span className="rounded bg-night px-1 font-display text-xs font-bold text-floodlight ring-1 ring-line">{team.abbr}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- Drive time

type LatLng = { lat: number; lng: number };

// Miles for the US/UK/Liberia/Myanmar, kilometres everywhere else.
const prefersMiles = () => /-(US|GB|LR|MM)$/i.test(navigator.language);

function haversineKm(a: LatLng, b: LatLng) {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const fmtDistance = (km: number) => {
  const miles = prefersMiles();
  return `${Math.round(miles ? km / 1.609344 : km).toLocaleString()} ${miles ? "mi" : "km"}`;
};

const fmtDuration = (sec: number) => {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} hr ${m} min` : `${m} min`;
};

type Drive = { sec: number; km: number } | "none";
// Rounded origin + destination → result, so small GPS jitter doesn't refetch.
const driveCache: Record<string, Promise<Drive>> = {};

function fetchDrive(from: LatLng, to: LatLng): Promise<Drive> {
  const f = `${from.lng.toFixed(2)},${from.lat.toFixed(2)}`;
  const t = `${to.lng.toFixed(5)},${to.lat.toFixed(5)}`;
  return (driveCache[`${f};${t}`] ??= fetch(
    `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${f};${t}?overview=false&access_token=${MAPBOX_TOKEN}`,
  )
    .then((r) => r.json())
    .then((d): Drive => (d.code === "Ok" && d.routes?.[0] ? { sec: d.routes[0].duration, km: d.routes[0].distance / 1000 } : "none")));
}

/** Estimated drive time from the viewer to the stadium (live traffic), no route drawn. */
function DriveTime({ from, to }: { from: LatLng; to: LatLng }) {
  const key = `${from.lat.toFixed(2)},${from.lng.toFixed(2)}→${to.lat},${to.lng}`;
  const [result, setResult] = useState<{ key: string; drive: Drive } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchDrive(from, to)
      .catch((): Drive => "none")
      .then((drive) => !cancelled && setResult({ key, drive }));
    return () => {
      cancelled = true;
    };
  }, [key, from, to]);

  const drive = result?.key === key ? result.drive : null;
  return (
    <p className="mt-1.5 text-sm text-floodlight/85">
      {drive === null
        ? "Working out the drive time…"
        : drive === "none"
          ? `No driving route from you, ${fmtDistance(haversineKm(from, to))} away`
          : `${fmtDuration(drive.sec)} drive from you (${fmtDistance(drive.km)})`}
    </p>
  );
}

// Kickoff in the viewer's own time zone, with the zone named so it's unambiguous.
const fmtKickoffTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const fmtKickoffDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
const fmtZone = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date(iso)).find((p) => p.type === "timeZoneName")?.value ?? "";

function MatchDetail({ match: m }: { match: Match }) {
  return (
    <div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-2 rounded-lg bg-stand px-3 py-4">
        <TeamBadge side={m.home} />
        <div className="min-w-[7.5rem] pt-1 text-center">
          {m.status === "pre" ? (
            <>
              <div className="tabular font-display text-3xl font-semibold leading-none">{fmtKickoffTime(m.kickoff)}</div>
              <div className="mt-1.5 text-sm text-steel">{fmtKickoffDay(m.kickoff)}</div>
              <div className="text-xs text-steel">Your time ({fmtZone(m.kickoff)})</div>
            </>
          ) : (
            <>
              <div className="tabular font-display text-5xl font-bold leading-none">
                {m.home.score}
                <span className="mx-1.5 text-steel">–</span>
                {m.away.score}
              </div>
              {m.status === "in" ? (
                <div className="mt-2 flex items-center justify-center gap-1.5 text-sm font-semibold text-pitch">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-pitch" />
                  Live {m.detail !== "Live" && m.detail}
                </div>
              ) : (
                <div className="mt-2 text-sm text-steel">{m.detail === "FT" ? "Full time" : m.detail}</div>
              )}
            </>
          )}
        </div>
        <TeamBadge side={m.away} />
      </div>
      <TeamSheets key={m.id} match={m} />
    </div>
  );
}

/**
 * Starting XI and bench for each team once lineups are out (about an hour
 * before kickoff); the full squad until then. Live games re-check every minute
 * so substitutions appear as they happen.
 */
function TeamSheets({ match: m }: { match: Match }) {
  const [lineups, setLineups] = useState<Record<string, Lineup> | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      fetch(`/api/lineup?league=${m.league}&event=${m.id}&live=${m.status === "in" ? 1 : 0}`)
        .then((r) => r.json())
        .then((d) => !cancelled && setLineups(d.lineups ?? {}))
        .catch(() => !cancelled && setLineups({}))
        .finally(() => {
          if (!cancelled && m.status === "in") timer = setTimeout(load, 60_000);
        });
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [m.league, m.id, m.status]);

  const home = lineups?.[m.home.teamId];
  const away = lineups?.[m.away.teamId];
  return (
    <>
      {lineups && !home && !away && m.status === "pre" && (
        <p className="mt-4 text-sm text-steel">Lineups come out about an hour before kickoff. Until then, here are the full squads.</p>
      )}
      <div className="mt-5 grid grid-cols-2 gap-4">
        {lineups === null ? (
          <p className="col-span-2 text-sm text-steel">Loading lineups…</p>
        ) : (
          <>
            {home ? <LineupList side={m.home} lineup={home} /> : <Roster key={m.home.teamId} league={m.league} side={m.home} />}
            {away ? <LineupList side={m.away} lineup={away} /> : <Roster key={m.away.teamId} league={m.league} side={m.away} />}
          </>
        )}
      </div>
    </>
  );
}

function LineupList({ side, lineup }: { side: MatchSide; lineup: Lineup }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-2 flex items-baseline justify-between gap-2 border-b border-line pb-1">
        <span className="font-display text-base font-semibold">{side.abbr} starting XI</span>
        {lineup.formation && <span className="tabular text-sm text-steel">{lineup.formation}</span>}
      </h3>
      <ul className="space-y-1 text-[13px]">
        {lineup.starters.map((p, i) => (
          <LineupRow key={i} p={p} />
        ))}
      </ul>
      {lineup.bench.length > 0 && (
        <>
          <h4 className="mb-1.5 mt-4 font-display text-sm font-semibold text-steel">Bench</h4>
          <ul className="space-y-1 text-[13px]">
            {lineup.bench.map((p, i) => (
              <LineupRow key={i} p={p} bench />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** One player: number, name, and an arrow with the minute if subbed on or off. */
function LineupRow({ p, bench = false }: { p: LineupPlayer; bench?: boolean }) {
  return (
    <li className={`flex items-baseline gap-2 ${bench && !p.on ? "text-steel" : ""}`}>
      <span className="tabular w-5 shrink-0 text-right text-steel">{p.no}</span>
      <span className="min-w-0 flex-1 truncate" title={p.pos && p.pos !== "SUB" ? `${p.name} (${p.pos})` : p.name}>
        {p.name}
      </span>
      {p.off && (
        <span className="tabular shrink-0 text-xs text-steel" title={`Subbed off ${p.off}`}>
          <span aria-hidden>↓</span> {p.off}
        </span>
      )}
      {p.on && (
        <span className="tabular shrink-0 text-xs text-floodlight" title={`Came on ${p.on}`}>
          <span aria-hidden>↑</span> {p.on}
        </span>
      )}
    </li>
  );
}

function TeamBadge({ side }: { side: MatchSide }) {
  return (
    <div className="flex flex-col items-center text-center">
      {/* eslint-disable-next-line @next/next/no-img-element -- small remote logos, no optimization needed */}
      {side.logo && <img src={side.logo} alt="" className="h-12 w-12 object-contain drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]" />}
      <div className="mt-2 font-display text-base font-semibold uppercase leading-tight tracking-wide">{side.name}</div>
      {side.record && (
        <div className="tabular mt-0.5 text-xs text-steel" title="Wins, draws, losses">
          {side.record} W-D-L
        </div>
      )}
      {side.form && <Form form={side.form} />}
    </div>
  );
}

/** Last five results, oldest first: wins solid, draws muted, losses outlined. */
function Form({ form }: { form: string }) {
  const style = {
    W: "bg-floodlight text-night",
    D: "bg-steel/40 text-floodlight",
    L: "text-steel ring-1 ring-inset ring-steel/60",
  } as Record<string, string>;
  return (
    <div className="mt-1.5 flex gap-0.5" title="Last five results, oldest first">
      {form.split("").map((r, i) => (
        <span key={i} className={`flex h-4 w-4 items-center justify-center rounded-sm font-display text-[10px] font-bold ${style[r] ?? "text-steel"}`}>
          {r}
        </span>
      ))}
    </div>
  );
}

function Roster({ league, side }: { league: string; side: MatchSide }) {
  const [players, setPlayers] = useState<Player[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/roster?league=${league}&team=${side.teamId}`)
      .then((r) => r.json())
      .then((d) => !cancelled && setPlayers(d.players ?? []))
      .catch(() => !cancelled && setPlayers([]));
    return () => { cancelled = true; };
  }, [league, side.teamId]);

  return (
    <div className="min-w-0">
      <h3 className="mb-2 border-b border-line pb-1 font-display text-base font-semibold">{side.abbr} squad</h3>
      {players === null ? (
        <p className="text-sm text-steel">Loading squad…</p>
      ) : players.length === 0 ? (
        <p className="text-sm text-steel">Squad list isn’t available for this league yet.</p>
      ) : (
        <ul className="space-y-1 text-[13px]">
          {players.map((p, i) => (
            <li key={i} className="flex gap-2" title={p.nat ?? undefined}>
              <span className="tabular w-5 shrink-0 text-right text-steel">{p.no}</span>
              <span className="w-3 shrink-0 text-steel">{p.pos}</span>
              <span className="truncate">{p.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
