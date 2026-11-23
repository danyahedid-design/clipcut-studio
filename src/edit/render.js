// Renders an edit timeline (see model.js) to MP4 with one ffmpeg filter graph:
// per-clip speed/zoom/color/effect -> transitions -> B-roll overlays -> burned captions,
// and per-clip audio -> cleanup -> transitions -> music with ducking -> loudness normalisation.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { ffmpeg, probe } from "../clip/ffmpeg.js";
import { clipDuration, transitionLength, timelineDuration } from "./model.js";

const SIZES = { vertical: [1080, 1920], landscape: [1920, 1080] };
const FPS = 30;

const FONT_CANDIDATES = [
  process.env.CAPTION_FONT,
  "/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf",
  "/usr/share/fonts/opentype/inter/Inter-Bold.otf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "C:/Windows/Fonts/arialbd.ttf",
].filter(Boolean);
export const captionFont = () => FONT_CANDIDATES.find((f) => fsSync.existsSync(f)) || null;

const EFFECT_FILTERS = {
  none: null,
  bw: "hue=s=0",
  warm: "colorbalance=rs=0.08:gs=0.02:bs=-0.08:rm=0.05:bm=-0.05",
  cool: "colorbalance=rs=-0.06:bs=0.08:bm=0.05",
  vintage: "curves=preset=vintage",
  vignette: "vignette=angle=PI/4.5",
  sharpen: "unsharp=5:5:0.8",
  punch: "eq=contrast=1.15:saturation=1.25,unsharp=3:3:0.4",
};

const even = (n) => Math.round(n / 2) * 2;
const f3 = (n) => Number(n).toFixed(3);

/** Wrap caption text to roughly `max` characters per line, at most 3 lines. */
export function wrapCaption(text, max) {
  const words = text.split(/\s+/);
  const lines = [""];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if (cur && (cur + " " + w).length > max) lines.push(w);
    else lines[lines.length - 1] = cur ? `${cur} ${w}` : w;
  }
  return lines.slice(0, 3).join("\n");
}

/**
 * @param {object} tl            normalised timeline
 * @param {Record<string,{file:string, hasAudio:boolean}>} sources
 * @param {string} outFile
 * @param {{scale?:number, preview?:boolean, workDir:string}} opts
 */
export async function renderTimeline(tl, sources, outFile, { scale = 1, preview = false, workDir }) {
  const [bw, bh] = SIZES[tl.aspect];
  const W = even(bw * scale);
  const H = even(bh * scale);
  const args = ["-y"];
  const fg = [];
  let n = 0; // input counter

  // ---- main clips ----
  const vLabels = [];
  const aLabels = [];
  tl.clips.forEach((c, i) => {
    const src = sources[c.sourceId];
    const srcLen = c.out - c.in;
    const outLen = clipDuration(c);
    args.push("-ss", f3(c.in), "-t", f3(srcLen), "-i", src.file);
    const vi = n++;
    let aIn = `${vi}:a:0`;
    if (!src.hasAudio || c.muted) {
      args.push("-f", "lavfi", "-t", f3(srcLen), "-i", "anullsrc=r=48000:cl=stereo");
      aIn = `${n++}:a:0`;
    }
    const zoom = c.zoom > 1.001
      ? `crop=iw/${c.zoom}:ih/${c.zoom}:(iw-iw/${c.zoom})*${c.focusX}:(ih-ih/${c.zoom})*${c.focusY},`
      : "";
    const eq = `eq=brightness=${c.color.brightness}:contrast=${c.color.contrast}:saturation=${c.color.saturation}`;
    const fx = EFFECT_FILTERS[c.effect] ? `,${EFFECT_FILTERS[c.effect]}` : "";
    fg.push(
      `[${vi}:v:0]setpts=(PTS-STARTPTS)/${c.speed},${zoom}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,${eq}${fx},fps=${FPS},format=yuv420p,tpad=stop_mode=clone:stop_duration=1,trim=duration=${f3(outLen)},setpts=PTS-STARTPTS,settb=AVTB[cv${i}]`,
    );
    const tempo = c.speed !== 1 ? `,atempo=${c.speed}` : "";
    const clean = tl.audio.cleanup && src.hasAudio && !c.muted ? ",highpass=f=80,afftdn=nf=-25" : "";
    const vol = c.volume !== 1 ? `,volume=${c.volume}` : "";
    fg.push(
      `[${aIn}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS${tempo}${clean}${vol},apad,atrim=duration=${f3(outLen)},afade=t=in:d=0.02,areverse,afade=t=in:d=0.02,areverse[ca${i}]`,
    );
    vLabels.push(`cv${i}`);
    aLabels.push(`ca${i}`);
  });

  // ---- join with transitions ----
  let v = vLabels[0];
  let a = aLabels[0];
  let length = clipDuration(tl.clips[0]);
  for (let i = 1; i < tl.clips.length; i++) {
    const t = transitionLength(tl.clips, i);
    const d = clipDuration(tl.clips[i]);
    if (t > 0) {
      fg.push(`[${v}][${vLabels[i]}]xfade=transition=${tl.clips[i].transition.type}:duration=${f3(t)}:offset=${f3(length - t)}[jv${i}]`);
      fg.push(`[${a}][${aLabels[i]}]acrossfade=d=${f3(t)}:c1=tri:c2=tri[ja${i}]`);
    } else {
      fg.push(`[${v}][${vLabels[i]}]concat=n=2:v=1:a=0[jv${i}]`);
      fg.push(`[${a}][${aLabels[i]}]concat=n=2:v=0:a=1[ja${i}]`);
    }
    v = `jv${i}`;
    a = `ja${i}`;
    length += d - t;
  }

  // ---- B-roll overlays (picture only; the main audio keeps playing) ----
  tl.broll.forEach((b, k) => {
    const len = Math.min(b.out - b.in, Math.max(0, length - b.at));
    if (len < 0.1) return;
    args.push("-ss", f3(b.in), "-t", f3(len), "-i", sources[b.sourceId].file);
    const bi = n++;
    fg.push(`[${bi}:v:0]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS},format=yuv420p,setpts=PTS-STARTPTS+${f3(b.at)}/TB[br${k}]`);
    fg.push(`[${v}][br${k}]overlay=eof_action=pass:enable='between(t,${f3(b.at)},${f3(b.at + len)})'[bv${k}]`);
    v = `bv${k}`;
  });

  // ---- captions ----
  const srt = toSrt(tl.captions);
  if (tl.captions.length) {
    const font = captionFont();
    if (!font) throw new Error("No caption font found. Set CAPTION_FONT to a .ttf/.otf file.");
    const size = Math.round(H * (tl.aspect === "vertical" ? 0.04 : 0.05) * tl.captionStyle.size);
    const maxChars = Math.max(12, Math.floor((W * 0.86) / (size * 0.56)));
    const y = { top: "h*0.12", middle: "(h-text_h)/2", bottom: tl.aspect === "vertical" ? "h*0.70" : "h*0.80" }[tl.captionStyle.position];
    const color = tl.captionStyle.color.replace("#", "0x");
    await fs.mkdir(workDir, { recursive: true });
    for (const [k, c] of tl.captions.entries()) {
      const tf = path.join(workDir, `caption-${k}.txt`);
      await fs.writeFile(tf, wrapCaption(c.text, maxChars));
      const box = tl.captionStyle.box ? `:box=1:boxcolor=black@0.55:boxborderw=${Math.round(size * 0.35)}` : `:borderw=${Math.max(2, Math.round(size * 0.08))}:bordercolor=black`;
      fg.push(
        `[${v}]drawtext=fontfile='${esc(font)}':textfile='${esc(tf)}':fontsize=${size}:fontcolor=${color}:line_spacing=${Math.round(size * 0.2)}:x=(w-text_w)/2:y=${y}${box}:enable='between(t,${f3(c.start)},${f3(c.end)})'[tv${k}]`,
      );
      v = `tv${k}`;
    }
  }

  // ---- music and loudness ----
  if (tl.music) {
    const m = sources[tl.music.sourceId];
    args.push("-stream_loop", "-1", "-ss", f3(tl.music.in), "-i", m.file);
    const mi = n++;
    fg.push(`[${mi}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${f3(length)},volume=${tl.music.volume},afade=t=out:st=${f3(Math.max(0, length - 1.5))}:d=1.5[mus]`);
    if (tl.music.duck) {
      fg.push(`[${a}]asplit=2[voice][key]`);
      fg.push(`[mus][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[ducked]`);
      fg.push(`[voice][ducked]amix=inputs=2:duration=first:normalize=0[mixed]`);
    } else {
      fg.push(`[${a}][mus]amix=inputs=2:duration=first:normalize=0[mixed]`);
    }
    a = "mixed";
  }
  if (tl.audio.normalize) {
    fg.push(`[${a}]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[an]`);
    a = "an";
  }

  args.push(
    "-filter_complex", fg.join(";"),
    "-map", `[${v}]`, "-map", `[${a}]`,
    "-t", f3(length),
    "-c:v", "libx264", "-preset", preview ? "ultrafast" : "medium", "-crf", preview ? "28" : "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", preview ? "96k" : "192k",
    "-movflags", "+faststart",
    outFile,
  );
  await ffmpeg(args, { timeoutMs: 30 * 60e3 });
  const info = await probe(outFile);
  if (info.videoCodec !== "h264" || info.audioCodec !== "aac") throw new Error(`Render check failed: ${JSON.stringify(info)}`);
  return { ...info, expectedDuration: timelineDuration(tl), srt };
}

/**
 * Cover: a clean frame from the SOURCE under the cover time (so burned captions don't
 * collide with the cover headline), framed like the clip, with optional headline text.
 */
export async function renderCover(sources, tl, outFile, { scale = 1 } = {}) {
  const [bw, bh] = SIZES[tl.aspect];
  const W = even(bw * scale);
  const H = even(bh * scale);
  const starts = clipStartsLocal(tl);
  const t = Math.max(0, tl.meta.coverTime || 0);
  let i = starts.findLastIndex((s) => s <= t);
  if (i < 0) i = 0;
  const c = tl.clips[i];
  const srcT = Math.min(c.out - 0.05, c.in + (t - starts[i]) * c.speed);
  const zoom = c.zoom > 1.001 ? `crop=iw/${c.zoom}:ih/${c.zoom}:(iw-iw/${c.zoom})*${c.focusX}:(ih-ih/${c.zoom})*${c.focusY},` : "";
  const fx = EFFECT_FILTERS[c.effect] ? `,${EFFECT_FILTERS[c.effect]}` : "";
  const filters = [
    `${zoom}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,eq=brightness=${c.color.brightness}:contrast=${c.color.contrast}:saturation=${c.color.saturation}${fx}`,
  ];
  if (tl.meta.coverText) {
    const font = captionFont();
    const size = Math.round(H * (tl.aspect === "vertical" ? 0.06 : 0.09));
    const tf = `${outFile}.txt`;
    await fs.writeFile(tf, wrapCaption(tl.meta.coverText.toUpperCase(), tl.aspect === "vertical" ? 14 : 22));
    filters.push(
      `drawtext=fontfile='${esc(font)}':textfile='${esc(tf)}':fontsize=${size}:fontcolor=white:borderw=${Math.round(size * 0.09)}:bordercolor=black:line_spacing=${Math.round(size * 0.15)}:x=(w-text_w)/2:y=h*0.14`,
    );
  }
  await ffmpeg(["-y", "-ss", f3(srcT), "-i", sources[c.sourceId].file, "-frames:v", "1", "-vf", filters.join(","), "-q:v", "2", outFile]);
  await fs.rm(`${outFile}.txt`, { force: true });
  return outFile;
}

function clipStartsLocal(tl) {
  let t = 0;
  return tl.clips.map((c, i) => {
    t -= transitionLength(tl.clips, i);
    const s = t;
    t += clipDuration(c);
    return s;
  });
}

export function toSrt(captions) {
  const ts = (s) => {
    const ms = Math.round(s * 1000);
    const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
    const sec = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
    return `${h}:${m}:${sec},${String(ms % 1000).padStart(3, "0")}`;
  };
  return captions.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join("\n");
}

export function parseSrt(text) {
  const t = (s) => {
    const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s);
    return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000 : null;
  };
  return String(text)
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.trim().split("\n");
      const timing = lines.findIndex((l) => l.includes("-->"));
      if (timing < 0) return null;
      const [a, b] = lines[timing].split("-->");
      return { start: t(a), end: t(b), text: lines.slice(timing + 1).join(" ").trim() };
    })
    .filter((c) => c && c.start != null && c.end != null && c.text);
}

// Escape a path for use inside a single-quoted filtergraph option.
const esc = (p) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
