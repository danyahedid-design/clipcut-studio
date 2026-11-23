// Renders an edit plan to a playable MP4 (H.264 + AAC, faststart) and a JPG cover.
import { ffmpeg, probe } from "./ffmpeg.js";

export const ASPECTS = {
  vertical: { w: 1080, h: 1920, label: "9:16 (Shorts, Reels, TikTok)" },
  landscape: { w: 1920, h: 1080, label: "16:9 (YouTube)" },
};

/**
 * @param {object} plan  from planCuts
 * @param {Record<string,{file:string, hasAudio:boolean}>} sources  by sourceId
 * @param {string} outFile
 * @param {{aspect?: 'vertical'|'landscape', scale?: number}} opts  scale < 1 renders smaller (tests)
 */
export async function renderPlan(plan, sources, outFile, { aspect = "vertical", scale = 1 } = {}) {
  const a = ASPECTS[aspect];
  if (!a) throw Object.assign(new Error(`Unknown aspect ${aspect}`), { status: 400 });
  const W = even(a.w * scale);
  const H = even(a.h * scale);
  const args = ["-y"];
  const filters = [];
  const labels = [];
  let input = 0;

  plan.segments.forEach((s, i) => {
    const src = sources[s.sourceId];
    if (!src) throw new Error(`Unknown source ${s.sourceId}`);
    const dur = (s.end - s.start).toFixed(3);
    args.push("-ss", s.start.toFixed(3), "-t", dur, "-i", src.file);
    const vIn = input++;
    let aRef = `${vIn}:a:0`;
    if (!src.hasAudio) {
      args.push("-f", "lavfi", "-t", dur, "-i", "anullsrc=r=48000:cl=stereo");
      aRef = `${input++}:a:0`;
    }
    const fade = Math.min(0.04, (s.end - s.start) / 4).toFixed(3);
    filters.push(
      `[${vIn}:v:0]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS[v${i}]`,
      `[${aRef}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,afade=t=in:d=${fade},areverse,afade=t=in:d=${fade},areverse[a${i}]`,
    );
    labels.push(`[v${i}][a${i}]`);
  });
  filters.push(`${labels.join("")}concat=n=${plan.segments.length}:v=1:a=1[vout][aout]`);

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    outFile,
  );
  await ffmpeg(args);
  const out = await probe(outFile);
  if (out.videoCodec !== "h264" || out.audioCodec !== "aac" || out.duration < 0.5) {
    throw new Error(`Render check failed for ${outFile}: ${JSON.stringify(out)}`);
  }
  return out;
}

export async function renderCover(plan, sources, outFile, { aspect = "vertical", scale = 1 } = {}) {
  const a = ASPECTS[aspect];
  const W = even(a.w * scale);
  const H = even(a.h * scale);
  const hook = plan.segments[0];
  const t = hook.start + (hook.end - hook.start) / 2;
  await ffmpeg([
    "-y", "-ss", t.toFixed(3), "-i", sources[hook.sourceId].file,
    "-frames:v", "1",
    "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`,
    "-q:v", "3", outFile,
  ]);
  return outFile;
}

const even = (n) => Math.round(n / 2) * 2;
