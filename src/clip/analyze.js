// Finds dead air and strong moments in one source file using ffmpeg only
// (no transcription yet). Signals: audio loudness every 0.1s, silence ranges, scene cuts.
import { ffmpeg, probe } from "./ffmpeg.js";

const WINDOW = 0.1; // seconds per loudness sample
const SILENCE_DB = -35;
const MIN_SILENCE = 0.5; // gaps shorter than this are natural pauses, not dead air
const MAX_MOMENT = 6; // seconds
const MIN_MOMENT = 1.2;

export async function analyzeSource(file) {
  const info = await probe(file);
  if (!info.hasVideo) throw Object.assign(new Error("File has no video stream"), { status: 422 });
  const [audio, scenes] = await Promise.all([
    info.hasAudio ? audioSignals(file) : { loudness: [], silences: [] },
    sceneChanges(file),
  ]);
  const silences = info.hasAudio ? closeSilences(audio.silences, info.duration) : [];
  const voiced = invert(silences, info.duration);
  const moments = buildMoments(voiced, audio.loudness, scenes, info.hasAudio);
  const deadAir = silences.reduce((s, x) => s + (x.end - x.start), 0);
  return { info, silences, voiced, scenes, moments, deadAirSeconds: round(deadAir) };
}

async function audioSignals(file) {
  const af = [
    `silencedetect=noise=${SILENCE_DB}dB:d=${MIN_SILENCE}`,
    "aresample=16000",
    "aformat=channel_layouts=mono",
    `asetnsamples=n=${Math.round(16000 * WINDOW)}:p=0`,
    "astats=metadata=1:reset=1",
    "ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
  ].join(",");
  const { stdout, stderr } = await ffmpeg(["-i", file, "-map", "0:a:0", "-af", af, "-f", "null", "-"]);
  const loudness = [];
  let t = null;
  for (const line of stdout.split("\n")) {
    const pt = /pts_time:([\d.]+)/.exec(line);
    if (pt) t = Number(pt[1]);
    const rms = /RMS_level=(-?[\d.]+|-inf)/.exec(line);
    if (rms && t != null) loudness.push({ t, db: rms[1] === "-inf" ? -120 : Number(rms[1]) });
  }
  const silences = [];
  let start = null;
  for (const line of stderr.split("\n")) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    if (e && start != null) {
      silences.push({ start, end: Number(e[1]) });
      start = null;
    }
  }
  if (start != null) silences.push({ start, end: Infinity }); // silent until the end
  return { loudness, silences };
}

async function sceneChanges(file) {
  const vf = "scale=160:-2,select='gt(scene\\,0.3)',metadata=print:file=-";
  const { stdout } = await ffmpeg(["-i", file, "-map", "0:v:0", "-vf", vf, "-an", "-f", "null", "-"]);
  return [...stdout.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
}

function closeSilences(silences, duration) {
  return silences.map((s) => ({ start: round(s.start), end: round(Math.min(s.end, duration)) })).filter((s) => s.end - s.start >= MIN_SILENCE);
}

export function invert(ranges, duration) {
  const out = [];
  let cursor = 0;
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    if (r.start - cursor > 0.05) out.push({ start: round(cursor), end: round(r.start) });
    cursor = Math.max(cursor, r.end);
  }
  if (duration - cursor > 0.05) out.push({ start: round(cursor), end: round(duration) });
  return out;
}

export function buildMoments(voiced, loudness, scenes, hasAudio) {
  const chunks = [];
  for (const v of voiced) {
    const len = v.end - v.start;
    if (len < MIN_MOMENT) continue;
    const parts = Math.ceil(len / MAX_MOMENT);
    const step = len / parts;
    for (let i = 0; i < parts; i++) chunks.push({ start: round(v.start + i * step), end: round(v.start + (i + 1) * step) });
  }
  if (!chunks.length) return [];

  const dbs = loudness.map((l) => l.db).filter((d) => d > -120).sort((a, b) => a - b);
  const lo = dbs[Math.floor(dbs.length * 0.05)] ?? -60;
  const hi = dbs[Math.floor(dbs.length * 0.95)] ?? -10;
  return chunks.map((c) => {
    const inside = loudness.filter((l) => l.t >= c.start && l.t < c.end && l.db > -120);
    const mean = inside.length ? inside.reduce((s, l) => s + l.db, 0) / inside.length : lo;
    const peak = inside.length ? Math.max(...inside.map((l) => l.db)) : lo;
    const energy = hasAudio ? clamp((mean - lo) / Math.max(1, hi - lo)) : 0.5;
    const punch = hasAudio ? clamp((peak - mean) / 12) : 0;
    const cuts = scenes.filter((s) => s > c.start && s < c.end).length;
    const visual = Math.min(cuts, 3) / 3;
    const score = round(energy * 0.6 + visual * 0.25 + punch * 0.15, 3);
    const why = [];
    if (energy > 0.65) why.push("loud, energetic audio");
    if (cuts) why.push(`${cuts} visual change${cuts > 1 ? "s" : ""}`);
    if (punch > 0.5) why.push("sharp peak (laugh, hit or emphasis)");
    if (!why.length) why.push("steady speech or action");
    return { ...c, duration: round(c.end - c.start), score, why };
  });
}

const clamp = (x) => Math.max(0, Math.min(1, x));
const round = (n) => Math.round(n * 100) / 100;
