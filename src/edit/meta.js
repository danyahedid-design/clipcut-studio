// Title, description and cover-text suggestions for each version.
// Template-based and deliberately plain: no invented numbers, no promises, and the
// credits required by Creative Commons sources are always included.
import { detectFormat } from "../original.js";

const clean = (s) => String(s || "").replace(/#\S+/g, "").replace(/[|•]+/g, " ").replace(/\s+/g, " ").trim();

export function suggestMeta({ project, timeline, credits = [], topic }) {
  // The reference video is someone else's: use its format, never its title or name, as the subject.
  const ref = clean(project.reference?.title || "");
  const subject = clean(topic || project.reference?.query || "") || null;
  const fmt = detectFormat(ref);
  const short = timeline.aspect === "vertical";
  const firstCaption = timeline.captions[0]?.text;

  const titles = [
    firstCaption && firstCaption.length <= 70 ? firstCaption : null,
    ...(subject
      ? [
          {
            versus: `${cap(subject)}: which one wins?`,
            challenge: `Trying ${subject} so you don't have to`,
            list: `The ${subject} moment everyone rewatches`,
            explainer: `${cap(subject)} in under a minute`,
            reaction: `This ${subject} moment says it all`,
            reveal: `The part of ${subject} nobody shows`,
          }[fmt.key] || `The best ${subject} moment`,
          `Wait for the end 👀 ${subject}`,
          `${cap(subject)}, the short version`,
        ]
      : ["Wait for the end 👀", "Watch this one all the way through", "The moment that changes everything"]),
  ]
    .filter(Boolean)
    .map((t) => (short && !/#shorts/i.test(t) && t.length < 88 ? `${t} #shorts` : t).slice(0, 100));

  const tags = [...new Set((subject || "").toLowerCase().split(/\s+/).filter((w) => w.length > 2))].slice(0, 3).map((w) => `#${w.replace(/[^a-z0-9]/g, "")}`);
  const description = [
    firstCaption || (subject ? `A short ${subject} edit.` : "A short edit."),
    "",
    "Which moment was your favourite? Tell me in the comments.",
    "",
    ...(credits.length ? ["Credits:", ...credits.map((c) => `• ${c}`), ""] : []),
    [...tags, short ? "#shorts" : null].filter(Boolean).join(" "),
  ].join("\n");

  return {
    generatedBy: "template",
    titles,
    description,
    coverText: (firstCaption || subject || "").split(/\s+/).slice(0, 5).join(" "),
  };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
