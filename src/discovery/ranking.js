// Ranking for discovered videos.
//
// Every metric carries a `basis` so the UI never passes off a guess as data:
//   "reported"   - number returned by the platform (views, likes, comments)
//   "calculated" - arithmetic on reported numbers (views per hour, engagement rate)
//   "estimated"  - depends on a small or partial sample (channel baseline from few uploads)
//   "unavailable"- the platform did not return it (e.g. hidden likes)

const HOUR = 3600 * 1000;

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * @param {object} video  normalised video: { id, title, channelId, channelTitle, publishedAt,
 *                         durationSeconds, views, likes, comments }
 * @param {object} baseline { medianViews, sampleSize } for the channel's recent uploads (excluding this video)
 * @param {Date} now
 */
export function computeMetrics(video, baseline, now = new Date()) {
  const ageHours = Math.max(1, (now - new Date(video.publishedAt)) / HOUR);
  const metrics = {
    views: { value: video.views ?? null, basis: video.views == null ? "unavailable" : "reported" },
    likes: { value: video.likes ?? null, basis: video.likes == null ? "unavailable" : "reported" },
    comments: { value: video.comments ?? null, basis: video.comments == null ? "unavailable" : "reported" },
    ageHours: { value: round(ageHours, 1), basis: "calculated" },
    viewsPerHour: { value: null, basis: "unavailable" },
    viewsPerDay: { value: null, basis: "unavailable" },
    engagementRate: { value: null, basis: "unavailable" },
    outlierScore: { value: null, basis: "unavailable", baselineViews: null, sampleSize: 0 },
  };

  if (video.views != null) {
    metrics.viewsPerHour = { value: round(video.views / ageHours, 1), basis: "calculated" };
    metrics.viewsPerDay = { value: Math.round((video.views / ageHours) * 24), basis: "calculated" };
  }
  if (video.views > 0 && (video.likes != null || video.comments != null)) {
    const interactions = (video.likes ?? 0) + (video.comments ?? 0);
    metrics.engagementRate = {
      value: round((interactions / video.views) * 100, 2),
      basis: video.likes == null ? "estimated" : "calculated", // likes hidden -> comments only
    };
  }
  if (baseline?.medianViews > 0 && video.views != null) {
    metrics.outlierScore = {
      value: round(video.views / baseline.medianViews, 2),
      // Fewer than 10 comparable uploads is too thin to call it more than an estimate.
      basis: baseline.sampleSize >= 10 ? "calculated" : "estimated",
      baselineViews: Math.round(baseline.medianViews),
      sampleSize: baseline.sampleSize,
    };
  }
  return metrics;
}

/**
 * Score for "Breaking out now": rewards velocity, outperforming the channel's norm,
 * engagement and recency. Log scales keep one mega-channel from swamping everything.
 */
export function breakoutScore(m) {
  const vph = m.viewsPerHour.value ?? 0;
  const outlier = m.outlierScore.value ?? 1;
  const eng = m.engagementRate.value ?? 0;
  const age = m.ageHours.value ?? 1;
  const velocity = Math.log10(1 + vph); // 0..~6
  const outperform = Math.log2(Math.max(outlier, 0.25)); // 1x -> 0, 8x -> 3
  const engagement = Math.min(eng, 15) / 5; // cap so bot-like spikes don't dominate
  const recency = age <= 48 ? 1 : age <= 24 * 7 ? 0.5 : 0;
  const outlierWeight = m.outlierScore.basis === "estimated" ? 0.6 : 1;
  return round(velocity * 1.0 + outperform * 1.5 * outlierWeight + engagement * 0.5 + recency, 3);
}

export function reasonsFor(m, mode) {
  const r = [];
  const o = m.outlierScore;
  if (o.value != null && o.value >= 1.5) {
    r.push(
      `${o.value}x this channel's typical views (median ${fmt(o.baselineViews)} across ${o.sampleSize} recent uploads${
        o.basis === "estimated" ? ", small sample so treat as an estimate" : ""
      })`,
    );
  } else if (o.value != null && o.value < 1) {
    r.push(`Below this channel's usual level (${o.value}x its median)`);
  }
  if (m.viewsPerHour.value != null) r.push(`${fmt(m.viewsPerHour.value)} views per hour since upload`);
  if (m.ageHours.value <= 48) r.push(`Uploaded ${Math.round(m.ageHours.value)} hours ago`);
  if (m.engagementRate.value != null && m.engagementRate.value >= 4)
    r.push(`Strong engagement: ${m.engagementRate.value}% of viewers liked or commented`);
  if (m.likes.basis === "unavailable") r.push("Likes are hidden on this video");
  if (mode === "views" && m.views.value != null) r.unshift(`${fmt(m.views.value)} total views`);
  return r;
}

export function rankVideos(videos, baselines, { mode = "breakout", now = new Date() } = {}) {
  const ranked = videos.map((v) => {
    const metrics = computeMetrics(v, baselines[v.channelId], now);
    const score = breakoutScore(metrics);
    return { ...v, metrics, breakoutScore: score, reasons: reasonsFor(metrics, mode) };
  });
  ranked.sort((a, b) =>
    mode === "views" ? (b.views ?? -1) - (a.views ?? -1) : b.breakoutScore - a.breakoutScore,
  );
  return ranked.map((v, i) => ({ ...v, rank: i + 1 }));
}

export function isShort(durationSeconds) {
  // YouTube Shorts can be up to 3 minutes. Vertical framing is not exposed by the API,
  // so this is a duration-based classification and is labelled as such in the UI.
  return durationSeconds != null && durationSeconds <= 180;
}

export function parseIsoDuration(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return null;
  const [, d, h, min, s] = m.map((x) => Number(x || 0));
  return d * 86400 + h * 3600 + min * 60 + s;
}

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export function fmt(n) {
  if (n == null) return "n/a";
  if (n >= 1e6) return `${round(n / 1e6, 1)}M`;
  if (n >= 1e3) return `${round(n / 1e3, 1)}K`;
  return String(Math.round(n));
}
