// The editable timeline. Plain JSON so the browser editor, the API and the renderer share it.
//
// Times on `clips` (in/out) are SOURCE seconds. Times on `broll` (at), `captions` (start/end)
// and the cover are OUTPUT timeline seconds.
import crypto from "node:crypto";

export const EFFECTS = {
  none: "None",
  bw: "Black and white",
  warm: "Warm",
  cool: "Cool",
  vintage: "Vintage",
  vignette: "Vignette",
  sharpen: "Sharpen",
  punch: "Punchy contrast",
};
export const TRANSITIONS = { cut: "Cut", fade: "Crossfade", fadeblack: "Dip to black", slideleft: "Slide", zoomin: "Zoom in", wipeleft: "Wipe" };
export const CAPTION_POSITIONS = ["top", "middle", "bottom"];
export const ASPECTS = ["vertical", "landscape"];

const newId = () => crypto.randomUUID().slice(0, 8);
const num = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const r3 = (n) => Math.round(n * 1000) / 1000;

export function clipDuration(c) {
  return (c.out - c.in) / (c.speed || 1);
}

/** Effective transition length into clip i (0 for a cut or the first clip). */
export function transitionLength(clips, i) {
  if (i === 0) return 0;
  const t = clips[i].transition;
  if (!t || t.type === "cut") return 0;
  return r3(Math.min(t.duration, clipDuration(clips[i - 1]) / 2, clipDuration(clips[i]) / 2));
}

export function timelineDuration(tl) {
  let total = 0;
  tl.clips.forEach((c, i) => (total += clipDuration(c) - transitionLength(tl.clips, i)));
  return r3(total);
}

/** Output start time of each clip, after transitions overlap. */
export function clipStarts(tl) {
  const starts = [];
  let t = 0;
  tl.clips.forEach((c, i) => {
    t -= transitionLength(tl.clips, i);
    starts.push(r3(t));
    t += clipDuration(c);
  });
  return starts;
}

/**
 * Validate and normalise a timeline against the project's sources. Throws a 422 with every problem.
 */
export function normaliseTimeline(input, project) {
  const errors = [];
  const sources = Object.fromEntries(project.sources.map((s) => [s.id, s]));
  const cleared = new Set(project.rights.map((r) => r.sourceId));
  const needSource = (id, where, { video = true } = {}) => {
    const s = sources[id];
    if (!s) return errors.push(`${where}: unknown source ${id}`), null;
    if (!cleared.has(id)) errors.push(`${where}: source ${s.label} has no rights record`);
    if (video && !s.hasVideo && s.hasVideo !== undefined) errors.push(`${where}: ${s.label} has no video`);
    return s;
  };

  const tl = {
    version: 1,
    aspect: ASPECTS.includes(input?.aspect) ? input.aspect : "vertical",
    clips: [],
    broll: [],
    captions: [],
    captionStyle: {
      position: CAPTION_POSITIONS.includes(input?.captionStyle?.position) ? input.captionStyle.position : "bottom",
      size: num(input?.captionStyle?.size, 0.6, 2, 1),
      color: /^#[0-9a-f]{6}$/i.test(input?.captionStyle?.color || "") ? input.captionStyle.color : "#ffffff",
      box: input?.captionStyle?.box !== false,
    },
    music: null,
    audio: { cleanup: input?.audio?.cleanup !== false, normalize: input?.audio?.normalize !== false },
    meta: {
      title: String(input?.meta?.title || "").slice(0, 100),
      description: String(input?.meta?.description || "").slice(0, 5000),
      coverTime: num(input?.meta?.coverTime, 0, 3600, 0),
      coverText: String(input?.meta?.coverText || "").slice(0, 60),
    },
  };

  (input?.clips || []).forEach((c, i) => {
    const s = needSource(c.sourceId, `clip ${i + 1}`);
    if (!s) return;
    const inn = num(c.in, 0, s.duration, 0);
    const out = num(c.out, 0, s.duration, s.duration);
    if (out - inn < 0.2) errors.push(`clip ${i + 1}: must be at least 0.2s long`);
    tl.clips.push({
      id: c.id || newId(),
      sourceId: c.sourceId,
      in: r3(inn),
      out: r3(out),
      speed: num(c.speed, 0.5, 2, 1),
      zoom: num(c.zoom, 1, 3, 1),
      focusX: num(c.focusX, 0, 1, 0.5),
      focusY: num(c.focusY, 0, 1, 0.5),
      color: {
        brightness: num(c.color?.brightness, -0.3, 0.3, 0),
        contrast: num(c.color?.contrast, 0.5, 2, 1),
        saturation: num(c.color?.saturation, 0, 3, 1),
      },
      effect: EFFECTS[c.effect] ? c.effect : "none",
      transition: {
        type: TRANSITIONS[c.transition?.type] ? c.transition.type : "cut",
        duration: num(c.transition?.duration, 0.1, 2, 0.4),
      },
      muted: !!c.muted,
      volume: num(c.volume, 0, 2, 1),
    });
  });
  if (!tl.clips.length) errors.push("the timeline needs at least one clip");

  const total = errors.length ? 0 : timelineDuration(tl);

  (input?.broll || []).forEach((b, i) => {
    const s = needSource(b.sourceId, `B-roll ${i + 1}`);
    if (!s) return;
    const inn = num(b.in, 0, s.duration, 0);
    const out = num(b.out, 0, s.duration, Math.min(s.duration, inn + 3));
    if (out - inn < 0.2) errors.push(`B-roll ${i + 1}: must be at least 0.2s long`);
    tl.broll.push({ id: b.id || newId(), sourceId: b.sourceId, in: r3(inn), out: r3(out), at: r3(num(b.at, 0, total || 3600, 0)) });
  });

  (input?.captions || []).forEach((c, i) => {
    const text = String(c.text || "").trim().slice(0, 200);
    const start = num(c.start, 0, 3600, 0);
    const end = num(c.end, 0, 3600, start + 2);
    if (!text) return; // empty captions are simply dropped
    if (end - start < 0.2) errors.push(`caption ${i + 1}: must last at least 0.2s`);
    tl.captions.push({ id: c.id || newId(), start: r3(start), end: r3(end), text });
  });
  tl.captions.sort((a, b) => a.start - b.start);

  if (input?.music?.sourceId) {
    const s = needSource(input.music.sourceId, "music", { video: false });
    if (s && !s.hasAudio) errors.push(`music: ${s.label} has no audio`);
    if (s) {
      tl.music = {
        sourceId: input.music.sourceId,
        in: r3(num(input.music.in, 0, s.duration, 0)),
        volume: num(input.music.volume, 0, 1.5, 0.25),
        duck: input.music.duck !== false,
      };
    }
  }

  if (errors.length) throw Object.assign(new Error("Timeline has problems"), { status: 422, details: errors });
  return tl;
}

/** Start an editable timeline from one of the generated cuts. */
export function timelineFromCut(cut, project) {
  return normaliseTimeline(
    {
      aspect: cut.aspect,
      clips: cut.segments.map((s) => ({ sourceId: s.sourceId, in: s.start, out: s.end })),
      meta: { coverTime: 0 },
    },
    project,
  );
}

/** Split a clip at an OUTPUT time. Returns a new timeline. */
export function splitAt(tl, outputTime) {
  const starts = clipStarts(tl);
  const i = starts.findLastIndex((s) => s <= outputTime);
  if (i < 0) return tl;
  const c = tl.clips[i];
  const srcT = r3(c.in + (outputTime - starts[i]) * c.speed);
  if (srcT - c.in < 0.2 || c.out - srcT < 0.2) return tl; // too close to an edge
  const left = { ...c, out: srcT };
  const right = { ...structuredClone(c), id: newId(), in: srcT, transition: { type: "cut", duration: c.transition.duration } };
  const clips = [...tl.clips.slice(0, i), left, right, ...tl.clips.slice(i + 1)];
  return { ...tl, clips };
}
