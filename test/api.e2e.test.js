// End to end through the HTTP API: search, original brief, upload two rights-cleared files,
// make three cuts, download one MP4 and confirm it's playable H.264/AAC.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.js";
import { SampleProvider } from "../src/discovery/sampleData.js";
import { probe } from "../src/clip/ffmpeg.js";
import { makeTestMedia } from "../scripts/make-test-media.js";

test("full workflow over HTTP", { timeout: 5 * 60e3 }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clipcut-"));
  const [fileA, fileB] = await makeTestMedia(path.join(tmp, "media"));
  const app = await createApp({ dataDir: path.join(tmp, "data"), provider: new SampleProvider(), renderScale: 0.25 });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = async (p, o) => {
    const r = await fetch(base + p, o);
    return { status: r.status, body: await r.json() };
  };
  try {
    const s = await json("/api/search?q=football&mode=breakout");
    assert.equal(s.status, 200);
    assert.ok(s.body.results.length > 5);
    const ref = s.body.results[0];

    const o = await json("/api/original", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reference: ref }) });
    assert.equal(o.status, 200);
    assert.equal(o.body.hooks.length, 3);

    const p = await json("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "e2e", reference: ref }) });
    const id = p.body.id;

    const upload = async (file, extra = {}) => {
      const fd = new FormData();
      fd.append("file", new Blob([await fs.readFile(file)], { type: "video/mp4" }), path.basename(file));
      for (const [k, v] of Object.entries({ basis: "own", holder: "Test Owner", confirmed: "true", ...extra })) fd.append(k, v);
      return json(`/api/projects/${id}/sources`, { method: "POST", body: fd });
    };

    const refused = await upload(fileA, { confirmed: "" });
    assert.equal(refused.status, 422, "no rights confirmation, no upload");

    assert.equal((await upload(fileA)).status, 201);
    const up = await upload(fileB);
    assert.equal(up.status, 201);
    assert.equal(up.body.rights.length, 2);
    assert.match(up.body.rights[0].sha256, /^[a-f0-9]{64}$/);

    const c = await json(`/api/projects/${id}/cuts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetSeconds: 20, aspect: "vertical" }) });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.cuts.length, 3);
    assert.deepEqual(c.body.analysis.map((a) => a.deadAirSeconds), [6, 3]);
    const openings = new Set(c.body.cuts.map((x) => `${x.segments[0].sourceId}:${x.segments[0].start}-${x.segments[0].end}`));
    assert.equal(openings.size, 3, "three different openings");
    for (const cut of c.body.cuts) {
      assert.equal(new Set(cut.segments.map((s) => s.sourceId)).size, 2, "each cut merges both files");
    }

    const res = await fetch(`${base}/media/${id}/${c.body.cuts[0].file}`);
    assert.equal(res.status, 200);
    const out = path.join(tmp, "downloaded.mp4");
    await fs.writeFile(out, Buffer.from(await res.arrayBuffer()));
    const info = await probe(out);
    assert.equal(info.videoCodec, "h264");
    assert.equal(info.audioCodec, "aac");
    assert.ok(info.height > info.width, "vertical export");
    assert.ok(Math.abs(info.duration - c.body.cuts[0].durationSeconds) < 0.5);

    const land = await json(`/api/projects/${id}/cuts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetSeconds: 15, aspect: "landscape" }) });
    assert.equal(land.status, 201);
    assert.ok(land.body.cuts[0].media.width > land.body.cuts[0].media.height, "landscape export");

    assert.equal((await fetch(`${base}/media/${id}/..%2Fproject.json`)).status, 404);
  } finally {
    server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
