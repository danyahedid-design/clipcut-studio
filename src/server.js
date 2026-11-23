import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Store } from "./store.js";
import { createProvider, discover } from "./discovery/index.js";
import { RIGHTS_BASES, validateRights, buildRightsRecord, sha256File, assertSourcesCleared, creditsFor } from "./rights.js";
import { createOriginalBrief } from "./original.js";
import { makeCuts } from "./clip/index.js";
import { probe } from "./clip/ffmpeg.js";
import { ASPECTS } from "./clip/render.js";
import { normaliseTimeline, timelineFromCut, splitAt, timelineDuration, clipStarts, EFFECTS, TRANSITIONS } from "./edit/model.js";
import { renderTimeline, renderCover, parseSrt, captionFont } from "./edit/render.js";
import { suggestMeta } from "./edit/meta.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function createApp({ dataDir = process.env.DATA_DIR || path.join(ROOT, "data"), provider = createProvider(), renderScale = 1 } = {}) {
  const store = await new Store(dataDir).init();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(ROOT, "public")));

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => cb(null, path.join(store.projectDir(req.params.id), "sources")),
      filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().slice(0, 8)}`),
    }),
    limits: { fileSize: 4 * 1024 ** 3 },
    fileFilter: (_req, file, cb) =>
      cb(null, /^(video|audio)\//.test(file.mimetype) || /\.(mp4|mov|m4v|webm|mkv|mp3|m4a|wav|aac|ogg)$/i.test(file.originalname)),
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  app.get("/api/status", (_req, res) =>
    res.json({
      searchSource: provider.source,
      youtubeKeyConfigured: provider.source === "youtube",
      rightsBases: RIGHTS_BASES,
      aspects: ASPECTS,
      features: FEATURES,
    }),
  );

  app.get(
    "/api/search",
    wrap(async (req, res) => {
      const { q, mode, lang, region, period, format, license } = req.query;
      if (!q?.trim()) return res.status(400).json({ error: "Enter a topic, creator or channel" });
      res.json(await discover(provider, { q: q.trim().slice(0, 200), mode, lang, region, period, format, license }));
    }),
  );

  app.post(
    "/api/original",
    wrap(async (req, res) => res.json(createOriginalBrief(req.body.reference, req.body.options))),
  );

  app.post(
    "/api/projects",
    wrap(async (req, res) => res.status(201).json(await store.createProject(req.body || {}))),
  );

  app.get("/api/projects/:id", wrap(async (req, res) => res.json(await store.get(req.params.id))));

  app.post(
    "/api/projects/:id/sources",
    wrap(async (req, res, next) => {
      await store.get(req.params.id); // 404 before accepting bytes
      upload.single("file")(req, res, (err) => (err ? next(err) : next()));
    }),
    wrap(async (req, res) => {
      if (!req.file) return res.status(400).json({ error: "Attach a video (mp4, mov, webm, mkv) or, for music, an audio file (mp3, m4a, wav)" });
      const kind = req.body.kind === "music" ? "music" : "video";
      const errors = validateRights(req.body);
      if (errors.length) {
        await fs.rm(req.file.path, { force: true });
        return res.status(422).json({ error: "Rights record incomplete", details: errors });
      }
      let info;
      try {
        info = await probe(req.file.path);
        if (kind === "video" && !info.hasVideo) throw new Error("no video stream");
        if (kind === "music" && !info.hasAudio) throw new Error("no audio stream");
      } catch (e) {
        await fs.rm(req.file.path, { force: true });
        return res.status(422).json({ error: `Not a readable video: ${e.message}` });
      }
      const project = await store.get(req.params.id);
      const sourceId = path.parse(req.file.filename).name;
      const sha256 = await sha256File(req.file.path);
      project.sources.push({
        id: sourceId,
        label: req.file.originalname,
        storedAs: req.file.filename,
        bytes: req.file.size,
        duration: info.duration,
        width: info.width,
        height: info.height,
        hasAudio: info.hasAudio,
        hasVideo: info.hasVideo,
        kind,
      });
      project.rights.push(buildRightsRecord({ sourceId, fileName: req.file.originalname, sha256, kind, input: req.body }));
      await store.save(project);
      res.status(201).json(project);
    }),
  );

  app.post(
    "/api/projects/:id/cuts",
    wrap(async (req, res) => {
      req.setTimeout(30 * 60e3);
      const project = await store.get(req.params.id);
      const ids = req.body.sourceIds?.length ? req.body.sourceIds : project.sources.filter((s) => s.kind !== "music").map((s) => s.id);
      if (!ids.length) return res.status(400).json({ error: "Add at least one source video first" });
      assertSourcesCleared(project, ids);
      const dir = store.projectDir(project.id);
      const sources = ids.map((id) => {
        const s = project.sources.find((x) => x.id === id);
        if (!s) throw Object.assign(new Error(`Unknown source ${id}`), { status: 400 });
        return { id, label: s.label, file: path.join(dir, "sources", s.storedAs) };
      });
      const target = Math.min(180, Math.max(5, Number(req.body.targetSeconds) || 30));
      const result = await makeCuts(sources, path.join(dir, "renders"), {
        targetSeconds: target,
        aspect: req.body.aspect || "vertical",
        scale: renderScale,
      });
      const credits = creditsFor(project, ids);
      for (const c of result.cuts) c.credits = credits;
      project.cuts.push(...result.cuts);
      project.lastAnalysis = result.analysis;
      await store.save(project);
      res.status(201).json({ cuts: result.cuts, analysis: result.analysis });
    }),
  );

  // ---------- Editor ----------
  const sourceMap = (project) =>
    Object.fromEntries(project.sources.map((s) => [s.id, { file: path.join(store.projectDir(project.id), "sources", s.storedAs), hasAudio: s.hasAudio }]));
  const editorView = (project, timeline) => ({
    timeline,
    duration: timelineDuration(timeline),
    starts: clipStarts(timeline),
    credits: creditsFor(project, usedSources(timeline)),
  });
  const usedSources = (tl) => [...new Set([...tl.clips.map((c) => c.sourceId), ...tl.broll.map((b) => b.sourceId), ...(tl.music ? [tl.music.sourceId] : [])])];

  app.get("/api/editor/options", (_req, res) => res.json({ effects: EFFECTS, transitions: TRANSITIONS, captionFont: !!captionFont() }));

  app.get(
    "/api/projects/:id/timeline",
    wrap(async (req, res) => {
      const project = await store.get(req.params.id);
      if (!project.timeline) return res.status(404).json({ error: "No timeline yet. Open one of the cuts in the editor first." });
      res.json(editorView(project, project.timeline));
    }),
  );

  app.post(
    "/api/projects/:id/timeline/from-cut",
    wrap(async (req, res) => {
      const project = await store.get(req.params.id);
      const cut = project.cuts.find((c) => c.file === req.body.file) || project.cuts.at(-1);
      if (!cut) return res.status(400).json({ error: "Make cuts first" });
      project.timeline = timelineFromCut(cut, project);
      const meta = suggestMeta({ project, timeline: project.timeline, credits: creditsFor(project, usedSources(project.timeline)) });
      project.timeline.meta = { ...project.timeline.meta, title: meta.titles[0], description: meta.description, coverText: meta.coverText };
      await store.save(project);
      res.status(201).json(editorView(project, project.timeline));
    }),
  );

  app.put(
    "/api/projects/:id/timeline",
    wrap(async (req, res) => {
      const project = await store.get(req.params.id);
      project.timeline = normaliseTimeline(req.body, project);
      await store.save(project);
      res.json(editorView(project, project.timeline));
    }),
  );

  app.post(
    "/api/projects/:id/timeline/split",
    wrap(async (req, res) => {
      const project = await store.get(req.params.id);
      if (!project.timeline) return res.status(400).json({ error: "No timeline" });
      project.timeline = normaliseTimeline(splitAt(project.timeline, Number(req.body.at) || 0), project);
      await store.save(project);
      res.json(editorView(project, project.timeline));
    }),
  );

  app.post(
    "/api/projects/:id/captions/srt",
    express.text({ type: "*/*", limit: "1mb" }),
    wrap(async (req, res) => {
      const captions = parseSrt(req.body);
      if (!captions.length) return res.status(400).json({ error: "No captions found in that SRT text" });
      res.json({ captions });
    }),
  );

  app.post(
    "/api/projects/:id/meta/suggest",
    wrap(async (req, res) => {
      const project = await store.get(req.params.id);
      const tl = project.timeline ? normaliseTimeline(req.body.timeline || project.timeline, project) : null;
      if (!tl) return res.status(400).json({ error: "No timeline" });
      res.json(suggestMeta({ project, timeline: tl, credits: creditsFor(project, usedSources(tl)), topic: req.body.topic }));
    }),
  );

  app.post(
    "/api/projects/:id/render",
    wrap(async (req, res) => {
      req.setTimeout(30 * 60e3);
      const project = await store.get(req.params.id);
      if (!project.timeline) return res.status(400).json({ error: "No timeline" });
      const tl = project.timeline;
      const preview = req.body.preview === true;
      const dir = store.projectDir(project.id);
      const stamp = Date.now();
      const base = `edit-${preview ? "preview" : "final"}-${tl.aspect}-${stamp}`;
      const out = path.join(dir, "renders", `${base}.mp4`);
      const scale = (preview ? 0.4 : 1) * renderScale;
      const info = await renderTimeline(tl, sourceMap(project), out, { scale, preview, workDir: path.join(dir, "work", base) });
      const credits = creditsFor(project, usedSources(tl));
      const result = {
        file: `${base}.mp4`,
        preview,
        aspect: tl.aspect,
        media: { duration: Math.round(info.duration * 100) / 100, width: info.width, height: info.height, videoCodec: info.videoCodec, audioCodec: info.audioCodec },
        createdAt: new Date().toISOString(),
      };
      if (!preview) {
        await renderCover(out, tl, path.join(dir, "renders", `${base}.jpg`), { scale: renderScale });
        if (tl.captions.length) await fs.writeFile(path.join(dir, "renders", `${base}.srt`), info.srt);
        Object.assign(result, {
          cover: `${base}.jpg`,
          srt: tl.captions.length ? `${base}.srt` : null,
          title: tl.meta.title,
          description: tl.meta.description,
          credits,
          timeline: tl, // the exact edit that produced this file
        });
        project.exports = [...(project.exports || []), result];
        await store.save(project);
      }
      await fs.rm(path.join(dir, "work", base), { recursive: true, force: true });
      res.status(201).json(result);
    }),
  );

  // Source files for scrubbing in the editor (range requests supported by sendFile).
  app.get(
    "/api/projects/:id/sources/:sourceId/file",
    wrap(async (req, res) => {
      const project = await store.get(req.params.id);
      const s = project.sources.find((x) => x.id === req.params.sourceId);
      if (!s) return res.sendStatus(404);
      res.sendFile(path.join(store.projectDir(project.id), "sources", s.storedAs));
    }),
  );

  app.get(
    "/media/:id/:file",
    wrap(async (req, res) => {
      const file = path.basename(req.params.file);
      if (!/^(cut-[A-C]|edit-(preview|final))-\w+-\d+\.(mp4|jpg|srt)$/.test(file)) return res.sendStatus(404);
      res.sendFile(path.join(store.projectDir(req.params.id), "renders", file), (err) => err && !res.headersSent && res.sendStatus(404));
    }),
  );

  app.use((err, _req, res, _next) => {
    const status = err.status || (err.code === "LIMIT_FILE_SIZE" ? 413 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
  });

  return app;
}

// What this release can and cannot do, shown in the app so nobody mistakes a placeholder for a feature.
export const FEATURES = [
  { area: "Find", feature: "Niche / creator / @channel search", status: "works", note: "Live with a YouTube API key; labelled sample data without one" },
  { area: "Find", feature: "Breaking out now vs Most viewed", status: "works" },
  { area: "Find", feature: "Outlier vs channel baseline, views/hour, engagement", status: "works", note: "Each number labelled reported, calculated or estimated" },
  { area: "Find", feature: "Creative Commons filter (reusable with credit)", status: "works", note: "Uses YouTube's own licence field" },
  { area: "Make", feature: "Rights record per source file, with credit lines for CC footage", status: "works", note: "Clipping is blocked without one" },
  { area: "Make", feature: "Create an original version (hook, beats, shot list)", status: "works", note: "Template draft, not AI-written yet" },
  { area: "Make", feature: "Dead-air removal, strong moments, 3 openings, MP4 + cover", status: "works" },
  { area: "Make", feature: "Merge footage from several files", status: "works" },
  { area: "Edit", feature: "Timeline: trim, split, reorder, delete, speed 0.5x to 2x", status: "works" },
  { area: "Edit", feature: "Zoom and reframe, color correction, 7 effects, 5 transitions", status: "works" },
  { area: "Edit", feature: "B-roll overlays, music with automatic ducking, audio cleanup, loudness to -14 LUFS", status: "works" },
  { area: "Edit", feature: "Editable captions burned in, SRT import and export", status: "works", note: "Typed or imported; automatic speech-to-text needs a transcription service" },
  { area: "Edit", feature: "Title, description and cover with text for each version", status: "works", note: "Template suggestions, fully editable; CC credits added automatically" },
  { area: "Publish", feature: "YouTube upload and scheduling", status: "planned", note: "Step 3, needs Google OAuth" },
  { area: "Learn", feature: "Analytics and 8M views goal", status: "planned", note: "Step 3" },
  { area: "Find", feature: "Clipping campaigns (creators who pay or allow clippers)", status: "planned", note: "Needs an authorized campaign source" },
  { area: "Billing", feature: "Owner access, paid plans, cost tracking", status: "planned", note: "Step 4" },
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const app = await createApp();
  app.listen(port, () => console.log(`ClipCut Studio on http://localhost:${port}`));
}
