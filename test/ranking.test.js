import test from "node:test";
import assert from "node:assert/strict";
import { computeMetrics, rankVideos, parseIsoDuration, median, isShort } from "../src/discovery/ranking.js";

const now = new Date("2026-11-23T12:00:00Z");
const v = (o) => ({ id: "x", channelId: "c", publishedAt: "2026-11-22T12:00:00Z", views: 24000, likes: 1200, comments: 100, ...o });

test("views per hour, engagement and outlier are calculated and labelled", () => {
  const m = computeMetrics(v(), { medianViews: 6000, sampleSize: 25 }, now);
  assert.equal(m.viewsPerHour.value, 1000);
  assert.equal(m.viewsPerHour.basis, "calculated");
  assert.equal(m.engagementRate.value, 5.42);
  assert.equal(m.outlierScore.value, 4);
  assert.equal(m.outlierScore.basis, "calculated");
  assert.equal(m.views.basis, "reported");
});

test("thin baseline is labelled estimated, hidden likes are unavailable", () => {
  const m = computeMetrics(v({ likes: null }), { medianViews: 6000, sampleSize: 4 }, now);
  assert.equal(m.outlierScore.basis, "estimated");
  assert.equal(m.likes.basis, "unavailable");
  assert.equal(m.engagementRate.basis, "estimated");
});

test("no baseline means outlier is unavailable, not zero", () => {
  const m = computeMetrics(v(), undefined, now);
  assert.equal(m.outlierScore.value, null);
  assert.equal(m.outlierScore.basis, "unavailable");
});

test("breakout mode favours a small channel outperforming itself over a big steady channel", () => {
  const videos = [
    v({ id: "big", channelId: "big", views: 2_000_000, publishedAt: "2026-11-01T12:00:00Z" }),
    v({ id: "small", channelId: "small", views: 90_000 }),
  ];
  const baselines = { big: { medianViews: 2_100_000, sampleSize: 25 }, small: { medianViews: 5000, sampleSize: 25 } };
  assert.equal(rankVideos(videos, baselines, { mode: "breakout", now })[0].id, "small");
  assert.equal(rankVideos(videos, baselines, { mode: "views", now })[0].id, "big");
  assert.ok(rankVideos(videos, baselines, { now })[0].reasons.some((r) => r.includes("18x")));
});

test("helpers", () => {
  assert.equal(parseIsoDuration("PT1H2M3S"), 3723);
  assert.equal(parseIsoDuration("PT45S"), 45);
  assert.equal(parseIsoDuration("P1DT1S"), 86401);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.ok(isShort(180));
  assert.ok(!isShort(181));
});
