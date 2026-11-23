import test from "node:test";
import assert from "node:assert/strict";
import { discover } from "../src/discovery/index.js";
import { SampleProvider } from "../src/discovery/sampleData.js";
import { YouTubeProvider } from "../src/discovery/youtube.js";

const now = new Date("2026-11-23T12:00:00Z");

test("sample provider is clearly labelled and deterministic", async () => {
  const p = new SampleProvider();
  const a = await discover(p, { q: "football", now });
  const b = await discover(p, { q: "football", now });
  assert.equal(a.sampleData, true);
  assert.match(a.notice, /SAMPLE DATA/);
  assert.deepEqual(a.results.map((r) => r.id), b.results.map((r) => r.id));
  assert.ok(a.results.every((r) => r.url === null && r.source === "sample"));
});

test("format filter and mode switch work", async () => {
  const p = new SampleProvider();
  const shorts = await discover(p, { q: "cooking", format: "short", now });
  assert.ok(shorts.results.length > 0 && shorts.results.every((r) => r.durationSeconds <= 180));
  const views = await discover(p, { q: "cooking", mode: "views", now });
  const vs = views.results.map((r) => r.views);
  assert.deepEqual(vs, [...vs].sort((x, y) => y - x));
});

test("Creative Commons filter only returns reusable videos", async () => {
  const r = await discover(new SampleProvider(), { q: "travel", license: "creativeCommon", now });
  assert.ok(r.results.length > 0);
  assert.ok(r.results.every((v) => v.reusable && v.reasons.some((x) => /Creative Commons/.test(x))));
});

test("YouTube provider calls the official endpoints and builds baselines", async () => {
  const calls = [];
  const fake = async (url) => {
    calls.push(url.pathname.split("/").pop() + "?" + url.searchParams.toString());
    const ep = url.pathname.split("/").pop();
    const json = {
      search: { items: [{ id: { videoId: "v1" } }] },
      videos: url.searchParams.get("part").includes("snippet")
        ? { items: [{ id: "v1", snippet: { title: "T", channelId: "UC1", channelTitle: "Chan", publishedAt: "2026-11-23T00:00:00Z", thumbnails: {} }, statistics: { viewCount: "50000", commentCount: "10" }, contentDetails: { duration: "PT59S" } }] }
        : { items: [{ statistics: { viewCount: "1000" } }, { statistics: { viewCount: "3000" } }] },
      channels: { items: [{ id: "UC1", contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] },
      playlistItems: { items: [{ contentDetails: { videoId: "a" } }, { contentDetails: { videoId: "v1" } }, { contentDetails: { videoId: "b" } }] },
    }[ep];
    return { ok: true, json: async () => json };
  };
  const r = await discover(new YouTubeProvider("KEY", fake), { q: "travel", period: "7d", lang: "en", region: "GB", license: "creativeCommon", now });
  assert.equal(r.sampleData, false);
  const top = r.results[0];
  assert.equal(top.url, "https://www.youtube.com/watch?v=v1");
  assert.equal(top.metrics.likes.basis, "unavailable"); // likeCount missing = hidden
  assert.equal(top.metrics.outlierScore.value, 25); // 50000 / median(1000,3000)
  assert.equal(top.metrics.outlierScore.basis, "estimated"); // only 2 uploads
  const search = calls.find((c) => c.startsWith("search?"));
  assert.match(search, /regionCode=GB/);
  assert.match(search, /relevanceLanguage=en/);
  assert.match(search, /publishedAfter=/);
  assert.match(search, /videoLicense=creativeCommon/);
  assert.ok(!calls.find((c) => c.startsWith("videos?part=statistics")).includes("v1"), "baseline excludes the result itself");
});
