// Offline provider used when no YOUTUBE_API_KEY is configured.
// Everything here is SYNTHETIC: fictional channels, fictional numbers, no real video IDs.
// Results are deterministic per query so tests and demos are repeatable.

const TITLE_TEMPLATES = [
  "I tried {q} for 7 days and this happened",
  "The {q} mistake nobody talks about",
  "{q}: beginner vs pro",
  "Ranking every {q} trend of the year",
  "We gave a stranger $1,000 for {q}",
  "{q} in 60 seconds",
  "Why everyone is suddenly talking about {q}",
  "The cheapest vs most expensive {q}",
  "Honest {q} review after one month",
  "{q} challenge gone wrong",
  "3 {q} tips I wish I knew earlier",
  "Inside the world's most extreme {q}",
  "Reacting to the best {q} moments",
  "{q} explained in under 5 minutes",
];

const PERIOD_DAYS = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, "1y": 365 };

function rng(seedText) {
  let h = 2166136261;
  for (const c of seedText) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SampleProvider {
  constructor() {
    this.source = "sample";
  }

  async search({ q, period = "30d", format = "any", license = "any", lang, region, now = new Date() }) {
    const query = (q || "").trim() || "trending";
    const r = rng(`${query.toLowerCase()}|${lang || ""}|${region || ""}`);
    const channels = ["A", "B", "C", "D", "E"].map((letter, i) => ({
      id: `sample-ch-${slug(query)}-${letter}`,
      title: `Sample ${cap(query)} Channel ${letter}`,
      medianViews: Math.round(10 ** (3.5 + r() * 2.5)), // ~3K to ~1M
      sampleSize: i === 4 ? 6 : 25, // one thin channel to show the "estimated" label
    }));

    const maxDays = PERIOD_DAYS[period] ?? 365;
    const videos = TITLE_TEMPLATES.map((tpl, i) => {
      const ch = channels[Math.floor(r() * channels.length)];
      const ageHours = Math.max(2, r() ** 2 * maxDays * 24);
      const multiple = r() < 0.25 ? 3 + r() * 12 : 0.3 + r() * 1.7; // a few real outliers
      const views = Math.round(ch.medianViews * multiple * Math.min(1, 0.3 + ageHours / 72));
      const shortForm = r() < 0.5;
      const hideLikes = i === 7;
      return {
        id: `sample-${slug(query)}-${i + 1}`,
        url: null, // no real link: this is synthetic
        title: tpl.replace("{q}", query),
        channelId: ch.id,
        channelTitle: ch.title,
        channelUrl: null,
        publishedAt: new Date(now - ageHours * 3600e3).toISOString(),
        thumbnail: null,
        language: lang || "en",
        durationSeconds: shortForm ? Math.round(15 + r() * 150) : Math.round(240 + r() * 1500),
        views,
        likes: hideLikes ? null : Math.round(views * (0.01 + r() * 0.06)),
        comments: Math.round(views * (0.0005 + r() * 0.004)),
        license: i % 4 === 2 ? "creativeCommon" : "youtube",
        source: "sample",
      };
    }).filter((v) => {
      if (license === "creativeCommon" && v.license !== "creativeCommon") return false;
      if (format === "short") return v.durationSeconds <= 180;
      if (format === "long") return v.durationSeconds > 180;
      return true;
    });

    const baselines = Object.fromEntries(
      channels.map((c) => [c.id, { medianViews: c.medianViews, sampleSize: c.sampleSize }]),
    );
    return { videos, baselines };
  }
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
