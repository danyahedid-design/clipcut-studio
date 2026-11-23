import { YouTubeProvider } from "./youtube.js";
import { SampleProvider } from "./sampleData.js";
import { rankVideos, isShort } from "./ranking.js";

export function createProvider(env = process.env) {
  return env.YOUTUBE_API_KEY ? new YouTubeProvider(env.YOUTUBE_API_KEY) : new SampleProvider();
}

const MODES = new Set(["breakout", "views"]);

export async function discover(provider, opts) {
  const mode = MODES.has(opts.mode) ? opts.mode : "breakout";
  const now = opts.now || new Date();
  const { videos, baselines } = await provider.search({ ...opts, mode, now });
  const filtered = videos.filter((v) => {
    if (opts.format === "short") return isShort(v.durationSeconds);
    if (opts.format === "long") return !isShort(v.durationSeconds);
    return true;
  });
  const results = rankVideos(filtered, baselines, { mode, now }).map((v) => ({
    ...v,
    format: isShort(v.durationSeconds) ? "short" : "long",
    reusable: v.license === "creativeCommon",
    reasons: v.license === "creativeCommon" ? [...v.reasons, "Creative Commons (CC BY): can be reused with credit"] : v.reasons,
  }));
  return {
    query: opts.q,
    mode,
    source: provider.source,
    sampleData: provider.source === "sample",
    notice:
      provider.source === "sample"
        ? "SAMPLE DATA: no YouTube API key is configured, so these channels and numbers are synthetic."
        : "Live YouTube Data API results. Views, likes and comments are reported by YouTube; per-hour, engagement and outlier figures are calculated from them.",
    generatedAt: now.toISOString(),
    results,
  };
}
