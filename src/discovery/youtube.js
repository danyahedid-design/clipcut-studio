// YouTube Data API v3 provider. Official API only, read-only, API key auth.
// Quota cost per search is roughly 100 (search.list) + 2 + 2 per channel baseline (up to 25 channels),
// so about 120 to 150 units with the default caps. The default daily quota is 10,000 units.

import { median, parseIsoDuration } from "./ranking.js";

const API = "https://www.googleapis.com/youtube/v3";
const MAX_BASELINE_CHANNELS = 25; // one channels.list call covers up to 50 ids
const BASELINE_UPLOADS = 25;

const PERIODS = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, "1y": 365 };

export class YouTubeProvider {
  constructor(apiKey, fetchImpl = fetch) {
    if (!apiKey) throw new Error("YOUTUBE_API_KEY is required for the YouTube provider");
    this.key = apiKey;
    this.fetch = fetchImpl;
    this.source = "youtube";
  }

  async get(path, params) {
    const url = new URL(`${API}/${path}`);
    for (const [k, v] of Object.entries({ ...params, key: this.key })) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
    const res = await this.fetch(url);
    const body = await res.json();
    if (!res.ok) {
      const reason = body?.error?.errors?.[0]?.reason || res.status;
      throw new Error(`YouTube API ${path} failed: ${reason} ${body?.error?.message || ""}`.trim());
    }
    return body;
  }

  /** @returns {Promise<{videos: object[], baselines: Record<string, {medianViews:number, sampleSize:number}>}>} */
  async search({ q, mode = "breakout", lang, region, period = "30d", format = "any", now = new Date() }) {
    const params = {
      part: "snippet",
      type: "video",
      maxResults: 25,
      q,
      order: mode === "views" ? "viewCount" : "relevance",
      relevanceLanguage: lang,
      regionCode: region,
    };
    if (PERIODS[period]) {
      params.publishedAfter = new Date(now - PERIODS[period] * 86400e3).toISOString();
    }
    if (format === "short") params.videoDuration = "short"; // < 4 min, refined below
    if (format === "long") params.videoDuration = "medium"; // 4-20 min; "any" covers the rest

    // "@handle" searches a specific channel's uploads.
    if (q?.startsWith("@")) {
      const ch = await this.get("channels", { part: "id", forHandle: q });
      if (ch.items?.[0]) {
        params.channelId = ch.items[0].id;
        delete params.q;
      }
    }

    const search = await this.get("search", params);
    const ids = (search.items || []).map((i) => i.id.videoId).filter(Boolean);
    const videos = await this.videoDetails(ids);
    const baselines = await this.channelBaselines(videos);
    return { videos, baselines };
  }

  async videoDetails(ids) {
    if (!ids.length) return [];
    const res = await this.get("videos", { part: "snippet,statistics,contentDetails", id: ids.join(",") });
    return (res.items || []).map(normaliseVideo);
  }

  async channelBaselines(videos) {
    const channelIds = [...new Set(videos.map((v) => v.channelId))].slice(0, MAX_BASELINE_CHANNELS);
    if (!channelIds.length) return {};
    const ch = await this.get("channels", { part: "contentDetails", id: channelIds.join(",") });
    const baselines = {};
    const resultIds = new Set(videos.map((v) => v.id));
    await Promise.all(
      (ch.items || []).map(async (c) => {
        const uploads = c.contentDetails?.relatedPlaylists?.uploads;
        if (!uploads) return;
        try {
          const pl = await this.get("playlistItems", {
            part: "contentDetails",
            playlistId: uploads,
            maxResults: BASELINE_UPLOADS,
          });
          const ids = (pl.items || []).map((i) => i.contentDetails.videoId).filter((id) => !resultIds.has(id));
          if (!ids.length) return;
          const st = await this.get("videos", { part: "statistics", id: ids.join(",") });
          const views = (st.items || []).map((v) => Number(v.statistics.viewCount)).filter(Number.isFinite);
          baselines[c.id] = { medianViews: median(views), sampleSize: views.length };
        } catch {
          // A missing baseline just means the outlier metric shows as unavailable.
        }
      }),
    );
    return baselines;
  }
}

export function normaliseVideo(item) {
  const s = item.statistics || {};
  const num = (x) => (x === undefined ? null : Number(x));
  return {
    id: item.id,
    url: `https://www.youtube.com/watch?v=${item.id}`,
    title: item.snippet.title,
    channelId: item.snippet.channelId,
    channelTitle: item.snippet.channelTitle,
    channelUrl: `https://www.youtube.com/channel/${item.snippet.channelId}`,
    publishedAt: item.snippet.publishedAt,
    thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || null,
    language: item.snippet.defaultAudioLanguage || item.snippet.defaultLanguage || null,
    durationSeconds: parseIsoDuration(item.contentDetails?.duration),
    views: num(s.viewCount),
    likes: num(s.likeCount), // null when the creator hides likes
    comments: num(s.commentCount),
    source: "youtube",
  };
}
