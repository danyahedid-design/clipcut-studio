// Generates two short synthetic videos that we create ourselves (so we own them outright).
// They contain loud passages, quiet passages, real silences (dead air) and hard visual cuts,
// which is exactly what the clip engine needs to prove it works.
//   node scripts/make-test-media.js <outDir>
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ffmpeg } from "../src/clip/ffmpeg.js";

export async function makeTestMedia(outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const a = path.join(outDir, "source-A-landscape.mp4");
  const b = path.join(outDir, "source-B-portrait.mp4");

  // A: 24s, 1280x720. Four visual scenes; audio alternates loud bursts, quiet tone and 2s silences.
  await ffmpeg([
    "-y",
    "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=6",
    "-f", "lavfi", "-i", "smptebars=s=1280x720:r=30:d=6",
    "-f", "lavfi", "-i", "mandelbrot=s=1280x720:r=30",
    "-f", "lavfi", "-i", "rgbtestsrc=s=1280x720:r=30:d=6",
    "-f", "lavfi", "-i",
    "aevalsrc='if(lt(mod(t,8),2),0,if(lt(mod(t,8),5),0.8*sin(2*PI*330*t)*abs(sin(3*t)),0.12*sin(2*PI*220*t)))':s=48000:d=24",
    "-filter_complex", "[2:v]trim=duration=6,setpts=PTS-STARTPTS[m];[0:v][1:v][m][3:v]concat=n=4:v=1:a=0,format=yuv420p[v]",
    "-map", "[v]", "-map", "4:a", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest", a,
  ]);

  // B: 18s, 720x1280 (phone footage). Speech-like bursts with a 3s dead-air gap in the middle.
  await ffmpeg([
    "-y",
    "-f", "lavfi", "-i", "testsrc=s=720x1280:r=30:d=9",
    "-f", "lavfi", "-i", "cellauto=s=720x1280:r=30",
    "-f", "lavfi", "-i",
    "aevalsrc='if(between(t,7,10),0,(0.25+0.6*abs(sin(1.7*t)))*sin(2*PI*(180+60*sin(5*t))*t))':s=48000:d=18",
    "-filter_complex", "[1:v]trim=duration=9,setpts=PTS-STARTPTS[c];[0:v][c]concat=n=2:v=1:a=0,format=yuv420p[v]",
    "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest", b,
  ]);
  return [a, b];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = await makeTestMedia(process.argv[2] || "data/test-media");
  console.log(files.join("\n"));
}
