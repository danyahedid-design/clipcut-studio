// "Create an original version": for videos the user does NOT have rights to.
// Uses only the reference's format signals (title pattern, length, why it ranked), never its
// footage, audio, script or thumbnail. Output is a template-based draft for the user to rewrite.

const PATTERNS = [
  { key: "versus", test: /\bvs\.?\b|versus|beginner|cheapest|most expensive/i, label: "Comparison (A vs B)" },
  { key: "challenge", test: /challenge|tried|for \d+ days|24 hours|gone wrong/i, label: "Personal challenge / experiment" },
  { key: "list", test: /^\d+|\b\d+ (tips|ways|things|mistakes|reasons)|ranking|top \d+/i, label: "Numbered list / ranking" },
  { key: "explainer", test: /explained|why |how |what |in under|in \d+ (seconds|minutes)/i, label: "Fast explainer" },
  { key: "reaction", test: /react|reacting|watching|review/i, label: "Reaction / review" },
  { key: "reveal", test: /inside|secret|nobody|truth|hidden/i, label: "Insider reveal" },
];

const HOOKS = {
  versus: (t) => [`One of these costs 10 times more. Can you tell which?`, `Beginner or pro: watch the hands, not the face.`, `I tested both so you don't have to waste money on ${t}.`],
  challenge: (t) => [`Day one I almost quit ${t}. Day seven surprised me.`, `I gave myself one rule for ${t}, and broke it by lunch.`, `Here's what a week of ${t} actually looks like.`],
  list: (t) => [`Number three is the one nobody does, and it matters most.`, `Most people get the first ${t} tip wrong.`, `Save this before your next ${t} attempt.`],
  explainer: (t) => [`You've seen ${t} everywhere. Here's why, in under a minute.`, `Everyone says ${t} is simple. It isn't, and here's the part they skip.`, `The real reason ${t} works comes down to one thing.`],
  reaction: (t) => [`I didn't expect this ${t} moment to hit this hard.`, `Pause at the 3-second mark. That's the whole story.`, `My honest take on ${t}, with no sponsor.`],
  reveal: (t) => [`Most people never get to see this side of ${t}.`, `This is the part of ${t} that usually gets cut.`, `I asked an insider one question about ${t}.`],
  generic: (t) => [`Here's the ${t} moment everyone is talking about, done my way.`, `If you care about ${t}, watch the first five seconds.`, `I tried the ${t} format that's working right now.`],
};

export function detectFormat(title = "") {
  return PATTERNS.find((p) => p.test.test(title)) || { key: "generic", label: "Single-idea short" };
}

export function createOriginalBrief(reference, { topic, targetSeconds } = {}) {
  if (!reference?.title) throw Object.assign(new Error("reference.title is required"), { status: 400 });
  const fmt = detectFormat(reference.title);
  const short = (reference.durationSeconds ?? 60) <= 180;
  const length = targetSeconds || (short ? 45 : 480);
  const subject = (topic || reference.query || guessTopic(reference.title)).trim();
  const hooks = (HOOKS[fmt.key] || HOOKS.generic)(subject);

  const beats = short
    ? [
        { at: 0, until: 3, beat: "Hook", note: "Say one of the hook lines on screen and out loud. Show the payoff image first." },
        { at: 3, until: Math.round(length * 0.3), beat: "Setup", note: `State the promise in one sentence. Why this ${subject} angle is different.` },
        { at: Math.round(length * 0.3), until: Math.round(length * 0.85), beat: "Payoff", note: "Deliver the three strongest moments, one idea per cut, a cut every 2 to 3 seconds." },
        { at: Math.round(length * 0.85), until: length, beat: "Loop / CTA", note: "End on a line that sends viewers back to the start, or ask one specific question for comments." },
      ]
    : [
        { at: 0, until: 15, beat: "Cold open", note: "Open on the most surprising moment, then cut to title." },
        { at: 15, until: 45, beat: "Promise", note: `What the viewer will know about ${subject} by the end.` },
        { at: 45, until: Math.round(length * 0.8), beat: "Main sections", note: "Three or four chapters, each with its own mini-hook and a visual change." },
        { at: Math.round(length * 0.8), until: length, beat: "Pay off and next video", note: "Answer the opening question; point to a related video." },
      ];

  const shots = [
    { shot: "Hook close-up", framing: short ? "9:16, face or object fills the frame" : "16:9 medium close-up", source: "Film yourself" },
    { shot: "Context wide shot", framing: "Show where you are or what is at stake", source: "Film yourself" },
    { shot: "Detail inserts (3 to 5)", framing: "Hands, product, screen, reactions", source: "Film yourself or licensed B-roll" },
    { shot: "Result / reveal", framing: "Same angle as the hook so the loop lands", source: "Film yourself" },
    { shot: "On-screen text", framing: "Max six words per card, high contrast", source: "Editor" },
  ];

  return {
    kind: "original-version-brief",
    status: "draft",
    generatedBy: "template", // not an AI model; refine before filming
    reference: {
      title: reference.title,
      url: reference.url || null,
      channelTitle: reference.channelTitle || null,
      whyItWorked: reference.reasons || [],
    },
    format: fmt.label,
    targetSeconds: length,
    orientation: short ? "vertical 9:16" : "landscape 16:9",
    hooks,
    titleIdeas: titleIdeas(fmt.key, subject),
    beats,
    shots,
    rightsGuardrails: [
      "Do not reuse the reference video's footage, audio, music, thumbnail or script.",
      "Film your own footage or use B-roll you have a licence for, and log it in the rights record.",
      "Formats and topics are not owned, but specific creative expression is. Make it yours.",
      "Do not name or imply endorsement by the reference creator.",
    ],
  };
}

function titleIdeas(key, t) {
  const T = t.charAt(0).toUpperCase() + t.slice(1);
  const map = {
    versus: [`Cheap vs expensive ${t}: I tested both`, `${T}: what actually matters`],
    challenge: [`I did ${t} every day for a week`, `My ${t} experiment didn't go to plan`],
    list: [`3 ${t} mistakes I see every day`, `The ${t} tips that actually work`],
    explainer: [`${T}, explained simply`, `Why ${t} works (and when it doesn't)`],
    reaction: [`My honest take on ${t}`, `${T}: the moment that changed my mind`],
    reveal: [`The side of ${t} you don't see`, `What nobody tells you about ${t}`],
  };
  return map[key] || [`${T}, my way`, `Trying the ${t} format everyone's using`];
}

function guessTopic(title) {
  return title.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 3).slice(0, 3).join(" ") || "this topic";
}
