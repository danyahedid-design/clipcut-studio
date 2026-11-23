# ClipCut Studio

Find what's breaking out in any niche, then make it your own: clip footage you have the rights to, or get an original-version brief for footage you don't. Later releases add publishing and learning from real results.

This is **step 1, the working prototype** of a four-step plan:

1. **Prototype of the loop** (this release): search, rank, choose a video, rights record, three cuts as MP4, original-version brief
2. Editor and exports: timeline, captions, music, effects, title, description, cover
3. Publish and learn: YouTube connection, uploads, analytics, 8M views goal
4. Billing: owner access, paid plans, cost tracking

## Run it

Requires Node 20+ and `ffmpeg`/`ffprobe` on the PATH.

```bash
npm install
cp .env.example .env     # optional: add YOUTUBE_API_KEY for live search
npm start                # http://localhost:3000
npm test                 # unit tests + full HTTP workflow test
npm run demo -- data/demo [videoA.mp4 videoB.mp4]   # writes data/demo/report.md and three MP4s
```

Without `YOUTUBE_API_KEY` the search runs on **synthetic sample data**, and the app says so in a banner and on every result. Nothing synthetic is presented as real.

## What works

| Area | Feature | Status |
|---|---|---|
| Find | Search by niche, creator or `@handle`; filter by language, region, period and Shorts/long form | Works. Live with an API key |
| Find | "Breaking out now" vs "Most viewed" | Works |
| Find | Views per hour/day, engagement, **outlier score vs the channel's own median** of recent uploads, and a "why it ranked" list | Works. Every number is labelled *reported*, *calculated* or *estimated* |
| Make | Rights record per source file (basis, holder, evidence, SHA-256 of the file, timestamp) | Works. Clipping is refused without one |
| Make | Analysis: dead-air removal (silence detection), loudness, scene changes, scored moments | Works |
| Make | Three cuts with different openings (strongest first, cold-open teaser, other-source opener), merged from several files | Works |
| Make | Vertical 1080×1920 and landscape 1920×1080 MP4 (H.264/AAC, faststart) plus a JPG cover | Works |
| Make | "Create an original version": format, three hooks, title ideas, beats, shot list, rights guardrails | Works, as a **template draft** (no AI model yet) |
| Edit / Publish / Learn / Billing | | Planned for steps 2 to 4 |

## How ranking works

`src/discovery/ranking.js`

- **Views per hour**: views ÷ hours since upload.
- **Outlier score**: this video's views ÷ the median views of the channel's last 25 uploads (excluding the result itself). Fewer than 10 uploads → labelled *estimated*.
- **Breakout score**: log(views per hour) + 1.5 × log2(outlier) + capped engagement + recency bonus. Log scales stop one giant channel from crowding out a small channel that is outperforming itself.
- **Shorts** are classified by duration (≤ 3 min). The API doesn't expose aspect ratio, so the UI says "Short (by length)".

YouTube quota: about 120 to 150 units per search with the default caps (10,000 units a day by default).

## Layout

```
src/server.js               Express API + static UI
src/discovery/              YouTube Data API provider, sample provider, ranking
src/rights.js               Rights record validation
src/original.js             Original-version brief
src/clip/                   ffmpeg analysis, cut planner, renderer
public/                     Single-page UI
scripts/demo.js             CLI proof of the workflow
scripts/make-test-media.js  Generates two synthetic test videos we own outright
test/                       node:test suites
```

Data (projects, uploads, renders) is stored as files under `DATA_DIR` (default `./data`, git-ignored). A database comes with accounts in step 4.
