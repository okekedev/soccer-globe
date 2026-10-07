"use client";

import dynamic from "next/dynamic";
import type { LeagueSummary } from "@/lib/leagues";

// MapLibre needs the browser (WebGL, window), so skip server rendering.
const MatchGlobe = dynamic(() => import("./MatchGlobe"), {
  ssr: false,
  loading: () => <div className="h-dvh w-full bg-black" />,
});

export default function GlobeLoader({ leagues }: { leagues: LeagueSummary[] }) {
  return <MatchGlobe leagues={leagues} />;
}
