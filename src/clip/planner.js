// Turns analysed sources into three edit plans that share a body but open differently.
// A plan is a plain list of segments, so the editor in step 2 can load and change it.

const TEASER = 2.5; // seconds

/**
 * @param {{sourceId:string, label?:string, moments:object[]}[]} sources in the order the user added them
 * @param {{targetSeconds?:number}} opts
 */
export function planCuts(sources, { targetSeconds = 30 } = {}) {
  const pool = sources.flatMap((s, si) => s.moments.map((m) => ({ ...m, sourceId: s.sourceId, sourceIndex: si })));
  if (!pool.length) throw Object.assign(new Error("No usable moments found (is every file silent or very short?)"), { status: 422 });

  // Guarantee every source contributes its best moment, so merged footage is really merged.
  const picked = [];
  for (const s of sources) {
    const best = pool.filter((m) => m.sourceId === s.sourceId).sort((a, b) => b.score - a.score)[0];
    if (best) picked.push(best);
  }
  const rest = pool.filter((m) => !picked.includes(m)).sort((a, b) => b.score - a.score);
  let total = sum(picked);
  for (const m of rest) {
    if (total >= targetSeconds) break;
    picked.push(m);
    total += m.duration;
  }
  // Story order: by source, then by time within the source.
  const body = picked.sort((a, b) => a.sourceIndex - b.sourceIndex || a.start - b.start);
  trimToTarget(body, targetSeconds);

  const byScore = [...body].sort((a, b) => b.score - a.score);
  const top = byScore[0];
  const altOpener =
    byScore.find((m) => m.sourceId !== top.sourceId) || byScore[1] || top;

  const seg = (m, role) => ({ sourceId: m.sourceId, start: m.start, end: m.end, role, score: m.score, why: m.why });

  const strongestFirst = [seg(top, "hook"), ...body.filter((m) => m !== top).map((m) => seg(m, "body"))];
  const teaserEnd = Math.min(top.end, top.start + TEASER);
  const coldOpen = [{ ...seg(top, "hook"), end: round(teaserEnd) }, ...body.map((m) => seg(m, "body"))];
  // Keep the teaser version within the target by shortening the tail.
  let excess = coldOpen.reduce((s, x) => s + (x.end - x.start), 0) - Math.max(targetSeconds, TEASER + 1.2);
  for (let i = coldOpen.length - 1; i > 0 && excess > 0.01; i--) {
    const len = coldOpen[i].end - coldOpen[i].start;
    if (len - excess >= 1.2) {
      coldOpen[i].end = round(coldOpen[i].end - excess);
      excess = 0;
    } else {
      excess -= len;
      coldOpen.splice(i, 1);
    }
  }
  const altFirst = [seg(altOpener, "hook"), ...body.filter((m) => m !== altOpener).map((m) => seg(m, "body"))];

  return [
    {
      id: "A",
      name: "Strongest moment first",
      opening: `Opens on the highest-scoring moment (${top.why.join(", ")}), then plays the rest in order.`,
      segments: strongestFirst,
    },
    {
      id: "B",
      name: "Cold-open teaser",
      opening: `Flashes ${round(teaserEnd - top.start)}s of the payoff up front, then tells the story from the start.`,
      segments: coldOpen,
    },
    {
      id: "C",
      name: altOpener.sourceId !== top.sourceId ? "Open on the other source" : "Second-best moment first",
      opening:
        altOpener.sourceId !== top.sourceId
          ? "Starts with the best moment from a different source file, to test a different first impression."
          : "Starts with the runner-up moment, to test a different first impression.",
      segments: altFirst,
    },
  ].map((p) => ({ ...p, durationSeconds: round(p.segments.reduce((s, x) => s + (x.end - x.start), 0)) }));
}

function trimToTarget(body, target) {
  let over = sum(body) - target;
  if (over <= 0) return;
  // Shave the lowest-scoring segments first, never below 1.2s.
  for (const m of [...body].sort((a, b) => a.score - b.score)) {
    if (over <= 0) break;
    const cut = Math.min(over, m.duration - 1.2);
    if (cut > 0) {
      m.end = round(m.end - cut);
      m.duration = round(m.end - m.start);
      over -= cut;
    }
  }
}

const sum = (ms) => ms.reduce((s, m) => s + m.duration, 0);
const round = (n) => Math.round(n * 100) / 100;
