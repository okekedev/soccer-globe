import GlobeLoader from "@/components/GlobeLoader";
import { LEAGUE_SUMMARIES } from "@/lib/leagues";

export default function Home() {
  return <GlobeLoader leagues={LEAGUE_SUMMARIES} />;
}
