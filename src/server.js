import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Store } from "./store.js";
import { createProvider, discover } from "./discovery/index.js";
import { RIGHTS_BASES, validateRights, buildRightsRecord, sha256File, assertSourcesCleared } from "./rights.js";
import { createOriginalBrief } from "./original.js";
import { makeCuts } from "./clip/index.js";
import { probe } from "./clip/ffmpeg.js";
import { ASPECTS } from "./clip/render.js";

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
    fileFilter: (_req, file, cb) => cb(null, /^video\//.test(file.mimetype) || /\.(mp4|mov|m4v|webm|mkv)$/i.test(file.originalname)),
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
      const { q, mode, lang, region, period, format } = req.query;
      if (!q?.trim()) return res.status(400).json({ error: "Enter a topic, creator or channel" });
      res.json(await discover(provider, { q: q.trim().slice(0, 200), mode, lang, region, period, format }));
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
      if (!req.file) return res.status(400).json({ error: "Attach a video file (mp4, mov, webm, mkv)" });
      const errors = validateRights(req.body);
      if (errors.length) {
        await fs.rm(req.file.path, { force: true });
        return res.status(422).json({ error: "Rights record incomplete", details: errors });
      }
      let info;
      try {
        info = await probe(req.file.path);
        if (!info.hasVideo) throw new Error("no video stream");
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
      });
      project.rights.push(buildRightsRecord({ sourceId, fileName: req.file.originalname, sha256, input: req.body }));
      await store.save(project);
      res.status(201).json(project);
    }),
  );

  app.post(
    "/api/projects/:id/cuts",
    wrap(async (req, res) => {
      req.setTimeout(30 * 60e3);
      const project = await store.get(req.params.id);
      const ids = req.body.sourceIds?.length ? req.body.sourceIds : project.sources.map((s) => s.id);
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
      project.cuts.push(...result.cuts);
      project.lastAnalysis = result.analysis;
      await store.save(project);
      res.status(201).json({ cuts: result.cuts, analysis: result.analysis });
    }),
  );

  app.get(
    "/media/:id/:file",
    wrap(async (req, res) => {
      const file = path.basename(req.params.file);
      if (!/^cut-[A-C]-\w+-\d+\.(mp4|jpg)$/.test(file)) return res.sendStatus(404);
      res.sendFile(path.join(store.projectDir(req.params.id), "renders", file), (err) => err && !res.headersSent && res.sendStatus(404));
    }),
  );

  app.use((err, _req, res, _next) => {
    const status = err.status || (err.code === "LIMIT_FILE_SIZE" ? 413 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message });
  });

  return app;
}

// What this release can and cannot do, shown in the app so nobody mistakes a placeholder for a feature.
export const FEATURES = [
  { area: "Find", feature: "Niche / creator / @channel search", status: "works", note: "Live with a YouTube API key; labelled sample data without one" },
  { area: "Find", feature: "Breaking out now vs Most viewed", status: "works" },
  { area: "Find", feature: "Outlier vs channel baseline, views/hour, engagement", status: "works", note: "Each number labelled reported, calculated or estimated" },
  { area: "Make", feature: "Rights record per source file", status: "works", note: "Clipping is blocked without one" },
  { area: "Make", feature: "Create an original version (hook, beats, shot list)", status: "works", note: "Template draft, not AI-written yet" },
  { area: "Make", feature: "Dead-air removal, strong moments, 3 openings, MP4 + cover", status: "works" },
  { area: "Make", feature: "Merge footage from several files", status: "works" },
  { area: "Edit", feature: "Timeline editor, captions, music, effects", status: "planned", note: "Step 2" },
  { area: "Publish", feature: "YouTube upload and scheduling", status: "planned", note: "Step 3, needs Google OAuth" },
  { area: "Learn", feature: "Analytics and 8M views goal", status: "planned", note: "Step 3" },
  { area: "Billing", feature: "Owner access, paid plans, cost tracking", status: "planned", note: "Step 4" },
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const app = await createApp();
  app.listen(port, () => console.log(`ClipCut Studio on http://localhost:${port}`));
}
