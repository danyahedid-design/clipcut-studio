import path from "node:path";
import { analyzeSource } from "./analyze.js";
import { planCuts } from "./planner.js";
import { renderPlan, renderCover, ASPECTS } from "./render.js";

/**
 * Analyse every source, plan three cuts, render each as MP4 + cover.
 * @param {{id:string, file:string, label?:string}[]} sources  already rights-cleared
 * @param {string} outDir
 */
export async function makeCuts(sources, outDir, { targetSeconds = 30, aspect = "vertical", scale = 1, onProgress } = {}) {
  if (!ASPECTS[aspect]) throw Object.assign(new Error(`aspect must be one of ${Object.keys(ASPECTS)}`), { status: 400 });
  const analyses = [];
  for (const s of sources) {
    onProgress?.(`Analysing ${s.label || s.id}`);
    analyses.push({ sourceId: s.id, label: s.label, ...(await analyzeSource(s.file)) });
  }
  const plans = planCuts(analyses.map((a) => ({ sourceId: a.sourceId, moments: a.moments })), { targetSeconds });
  const byId = Object.fromEntries(
    sources.map((s, i) => [s.id, { file: s.file, hasAudio: analyses[i].info.hasAudio }]),
  );
  const stamp = Date.now();
  const cuts = [];
  for (const plan of plans) {
    onProgress?.(`Rendering cut ${plan.id}`);
    const base = `cut-${plan.id}-${aspect}-${stamp}`;
    const mp4 = path.join(outDir, `${base}.mp4`);
    const jpg = path.join(outDir, `${base}.jpg`);
    const media = await renderPlan(plan, byId, mp4, { aspect, scale });
    await renderCover(plan, byId, jpg, { aspect, scale });
    cuts.push({
      ...plan,
      aspect,
      file: path.basename(mp4),
      cover: path.basename(jpg),
      media: { duration: round(media.duration), width: media.width, height: media.height, videoCodec: media.videoCodec, audioCodec: media.audioCodec },
      createdAt: new Date().toISOString(),
    });
  }
  return {
    cuts,
    analysis: analyses.map((a) => ({
      sourceId: a.sourceId,
      duration: round(a.info.duration),
      hasAudio: a.info.hasAudio,
      deadAirSeconds: a.deadAirSeconds,
      sceneChanges: a.scenes.length,
      moments: a.moments.length,
    })),
  };
}

const round = (n) => Math.round(n * 100) / 100;
