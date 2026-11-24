// Editor end to end over HTTP: cut -> timeline -> edit everything -> preview -> final export.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.js";
import { SampleProvider } from "../src/discovery/sampleData.js";
import { probe, ffmpeg } from "../src/clip/ffmpeg.js";
import { makeTestMedia } from "../scripts/make-test-media.js";

test("edit and export over HTTP", { timeout: 6 * 60e3 }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clipcut-ed-"));
  const [fileA, fileB] = await makeTestMedia(path.join(tmp, "media"));
  const music = path.join(tmp, "media", "music.m4a");
  await ffmpeg(["-y", "-f", "lavfi", "-i", "sine=f=262:d=30", "-c:a", "aac", music]);
  const app = await createApp({ dataDir: path.join(tmp, "data"), provider: new SampleProvider(), renderScale: 0.25 });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, method = "GET", body) => {
    const r = await fetch(base + p, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const upload = async (id, file, fields) => {
    const fd = new FormData();
    fd.append("file", new Blob([await fs.readFile(file)]), path.basename(file));
    for (const [k, v] of Object.entries({ basis: "own", holder: "Owner", confirmed: "true", ...fields })) fd.append(k, v);
    const r = await fetch(`${base}/api/projects/${id}/sources`, { method: "POST", body: fd });
    return { status: r.status, body: await r.json() };
  };
  try {
    const { body: project } = await call("/api/projects", "POST", { name: "edit", reference: { title: "I tried football for 7 days" } });
    const id = project.id;
    await upload(id, fileA, {});
    await upload(id, fileB, { basis: "cc_by", holder: "Someone", evidence: "https://creativecommons.org/licenses/by/4.0/", attribution: "Clip B by Someone, CC BY 4.0" });
    const cuts = await call(`/api/projects/${id}/cuts`, "POST", { targetSeconds: 15 });
    assert.equal(cuts.status, 201);
    // Music cannot be cut as footage.
    const mus = await upload(id, music, { kind: "music" });
    assert.equal(mus.status, 201);
    const musicId = mus.body.sources.at(-1).id;
    assert.equal(mus.body.sources.at(-1).hasVideo, false);

    const fromCut = await call(`/api/projects/${id}/timeline/from-cut`, "POST", { file: cuts.body.cuts[0].file });
    assert.equal(fromCut.status, 201);
    const tl = fromCut.body.timeline;
    assert.ok(tl.meta.title && tl.meta.description.includes("Clip B by Someone"), "title and credits prefilled");

    // Edit: speed, zoom, colour, effect, transitions, B-roll, captions, music.
    tl.clips[0] = { ...tl.clips[0], zoom: 1.5, focusX: 0.2, effect: "vintage", color: { brightness: 0.05, contrast: 1.2, saturation: 1.3 } };
    tl.clips[1] = { ...tl.clips[1], speed: 1.5, transition: { type: "fade", duration: 0.5 } };
    tl.clips[2] = { ...tl.clips[2], transition: { type: "slideleft", duration: 0.3 }, effect: "bw" };
    tl.broll = [{ sourceId: tl.clips[0].sourceId, in: 0, out: 1.5, at: 2 }];
    tl.captions = [{ start: 0.2, end: 2, text: "Day one: this is harder than it looks" }, { start: 3, end: 5, text: "Wait for it" }];
    tl.music = { sourceId: musicId, volume: 0.3, duck: true };
    tl.meta.coverText = "Day one";
    tl.aspect = "landscape";
    const put = await call(`/api/projects/${id}/timeline`, "PUT", tl);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const expected = put.body.duration;

    const bad = await call(`/api/projects/${id}/timeline`, "PUT", { ...tl, clips: [{ sourceId: musicId, in: 0, out: 3 }] });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.details.some((d) => /no video/.test(d)));

    const split = await call(`/api/projects/${id}/timeline/split`, "POST", { at: 1 });
    assert.equal(split.body.timeline.clips.length, tl.clips.length + 1);
    assert.equal(split.body.duration, expected);

    const preview = await call(`/api/projects/${id}/render`, "POST", { preview: true });
    assert.equal(preview.status, 201, JSON.stringify(preview.body));
    const final = await call(`/api/projects/${id}/render`, "POST", {});
    assert.equal(final.status, 201, JSON.stringify(final.body));
    assert.ok(Math.abs(final.body.media.duration - expected) < 0.15, `${final.body.media.duration} vs ${expected}`);
    assert.ok(final.body.media.width > final.body.media.height, "landscape");
    assert.deepEqual(final.body.credits, ["Clip B by Someone, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)"]);

    for (const f of [final.body.file, final.body.cover, final.body.srt]) {
      const r = await fetch(`${base}/media/${id}/${f}`);
      assert.equal(r.status, 200, f);
      if (f.endsWith(".srt")) assert.match(await r.text(), /Wait for it/);
      if (f.endsWith(".mp4")) {
        const out = path.join(tmp, "final.mp4");
        await fs.writeFile(out, Buffer.from(await r.arrayBuffer()));
        const info = await probe(out);
        assert.equal(info.videoCodec, "h264");
        assert.equal(info.audioCodec, "aac");
      }
    }
    const saved = await call(`/api/projects/${id}`);
    assert.equal(saved.body.exports.length, 1, "only final exports are kept");
  } finally {
    server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
