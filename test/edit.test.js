import test from "node:test";
import assert from "node:assert/strict";
import { normaliseTimeline, splitAt, timelineDuration, clipStarts, transitionLength } from "../src/edit/model.js";
import { toSrt, parseSrt, wrapCaption } from "../src/edit/render.js";
import { suggestMeta } from "../src/edit/meta.js";

const project = {
  name: "p",
  reference: { title: "Cheapest vs most expensive villa" },
  sources: [
    { id: "a", label: "a.mp4", duration: 20, hasAudio: true, hasVideo: true },
    { id: "b", label: "b.mp4", duration: 10, hasAudio: false, hasVideo: true },
    { id: "m", label: "song.mp3", duration: 60, hasAudio: true, hasVideo: false, kind: "music" },
    { id: "x", label: "no-rights.mp4", duration: 10, hasAudio: true, hasVideo: true },
  ],
  rights: [{ sourceId: "a" }, { sourceId: "b" }, { sourceId: "m" }],
};

test("durations account for speed and transition overlap", () => {
  const tl = normaliseTimeline(
    { clips: [{ sourceId: "a", in: 0, out: 4 }, { sourceId: "b", in: 0, out: 4, speed: 2, transition: { type: "fade", duration: 0.5 } }, { sourceId: "a", in: 10, out: 13, transition: { type: "cut" } }] },
    project,
  );
  assert.equal(transitionLength(tl.clips, 1), 0.5);
  assert.equal(timelineDuration(tl), 4 + 2 - 0.5 + 3);
  assert.deepEqual(clipStarts(tl), [0, 3.5, 5.5]);
});

test("transition can't exceed half of either neighbouring clip", () => {
  const tl = normaliseTimeline({ clips: [{ sourceId: "a", in: 0, out: 1 }, { sourceId: "a", in: 5, out: 9, transition: { type: "fade", duration: 2 } }] }, project);
  assert.equal(transitionLength(tl.clips, 1), 0.5);
});

test("validation rejects unknown sources, missing rights, music as video, bad lengths", () => {
  assert.throws(
    () => normaliseTimeline({ clips: [{ sourceId: "x", in: 0, out: 2 }, { sourceId: "m", in: 0, out: 2 }, { sourceId: "a", in: 3, out: 3.1 }, { sourceId: "zzz" }] }, project),
    (e) => e.status === 422 && e.details.length === 4,
  );
  assert.throws(() => normaliseTimeline({ clips: [] }, project), /problems/);
});

test("values are clamped and junk is dropped", () => {
  const tl = normaliseTimeline({ aspect: "square", clips: [{ sourceId: "a", in: -5, out: 999, speed: 9, zoom: 0, effect: "glitter" }], captions: [{ text: "  ", start: 0, end: 1 }] }, project);
  const c = tl.clips[0];
  assert.equal(tl.aspect, "vertical");
  assert.deepEqual([c.in, c.out, c.speed, c.zoom, c.effect], [0, 20, 2, 1, "none"]);
  assert.equal(tl.captions.length, 0);
});

test("split at an output time keeps total length", () => {
  const tl = normaliseTimeline({ clips: [{ sourceId: "a", in: 2, out: 8, speed: 2 }] }, project);
  const s = splitAt(tl, 1.5);
  assert.equal(s.clips.length, 2);
  assert.equal(s.clips[0].out, 5); // 1.5s of output at 2x = 3s of source
  assert.equal(s.clips[1].in, 5);
  assert.equal(timelineDuration(s), timelineDuration(tl));
  assert.equal(splitAt(tl, 0.05).clips.length, 1, "too close to the edge");
});

test("SRT round trip and caption wrapping", () => {
  const caps = [{ start: 0.5, end: 2, text: "Hello there" }, { start: 61.25, end: 63, text: "Second line" }];
  const srt = toSrt(caps);
  assert.match(srt, /00:01:01,250 --> 00:01:03,000/);
  assert.deepEqual(parseSrt(srt), caps);
  assert.equal(wrapCaption("one two three four five six", 9), "one two\nthree\nfour five");
});

test("meta suggestions keep CC credits and avoid invented claims", () => {
  const tl = normaliseTimeline({ clips: [{ sourceId: "a", in: 0, out: 5 }], captions: [{ start: 0, end: 2, text: "Which villa would you pick?" }] }, project);
  const m = suggestMeta({ project, timeline: tl, credits: ["© 2008 Blender Foundation, CC BY 3.0"] });
  assert.equal(m.titles[0], "Which villa would you pick? #shorts");
  assert.match(m.description, /Credits:\n• © 2008 Blender Foundation/);
  assert.ok(m.titles.every((t) => t.length <= 100 && !/\d+%|\$\d/.test(t)));
});
