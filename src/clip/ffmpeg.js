import { spawn } from "node:child_process";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

export function run(cmd, args, { timeoutMs = 10 * 60e3 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.split("\n").slice(-6).join("\n")}`));
    });
  });
}

export const ffmpeg = (args, opts) => run(FFMPEG, ["-hide_banner", "-nostdin", ...args], opts);

export async function probe(file) {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const info = JSON.parse(stdout);
  const v = info.streams.find((s) => s.codec_type === "video");
  const a = info.streams.find((s) => s.codec_type === "audio");
  return {
    duration: Number(info.format?.duration) || Number(v?.duration) || 0,
    hasVideo: !!v,
    hasAudio: !!a,
    width: v?.width ?? null,
    height: v?.height ?? null,
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
    formatName: info.format?.format_name ?? null,
  };
}
