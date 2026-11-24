// "Create an original version": for videos the user does NOT have rights to.
// Uses only the reference's format signals (title pattern, length, why it ranked), never its
// footage, audio, script or thumbnail. Output is a template-based draft for the user to rewrite.

// Order matters: the first matching pattern wins.
const PATTERNS = [
  { key: "challenge", test: /challenge|tried|win \$|\$\d|last to|survive|for \d+ (hours|days)|\b\d+ (hours|days) (in|at|on)|gone wrong/i, label: "Challenge / stakes" },
  { key: "versus", test: /\bvs\.?\b|versus|beginner|cheapest|most expensive/i, label: "Comparison (A vs B)" },
  { key: "heartfelt", test: /surpris|reunit|thank|old teacher|stranger|gave (my|a|him|her)|helping/i, label: "Heartfelt surprise" },
  { key: "reveal", test: /inside|secret|nobody|truth|hidden|erased|isolat|alone|disappear|feared|abandoned|least visited|miles from|forbidden/i, label: "Explore / insider reveal" },
  { key: "list", test: /^\d+ |\b\d+ (tips|ways|things|mistakes|reasons|places)|ranking|top \d+/i, label: "Numbered list / ranking" },
  { key: "explainer", test: /explained|^why |^how |^what |in under|in \d+ (seconds|minutes)/i, label: "Fast explainer" },
  { key: "reaction", test: /react|reacting|watching|review/i, label: "Reaction / review" },
];

// Hooks are structures with [placeholders] for the creator to fill with their own story.
// They never reuse the reference's words, and never promise numbers we can't back up.
const HOOKS = {
  challenge: [
    "One rule, [time limit], and no way out. Here's how it went.",
    "Everyone told me [challenge] was impossible, so I tried it.",
    "Hour one was easy. Hour [n] was not.",
  ],
  versus: [
    "One of these costs [x] times more. Can you tell which?",
    "[Option A] or [option B]? I tested both so you don't have to.",
    "Same [thing], two budgets. The result surprised me.",
  ],
  heartfelt: [
    "I hadn't seen [person] in [years]. They had no idea I was coming.",
    "This started as a small thank-you and turned into something bigger.",
    "[Person] changed my life. Today I finally told them.",
  ],
  reveal: [
    "Most people will never see [place]. I went to find out why.",
    "[Place] is [surprising fact]. Here's what it's really like.",
    "I spent [time] in [place] so you can see it from the inside.",
  ],
  list: [
    "Number [n] is the one nobody does, and it matters most.",
    "[N] [things] I wish I'd known before [starting].",
    "Save this before your next [activity].",
  ],
  explainer: [
    "You've seen [topic] everywhere. Here's why, in under a minute.",
    "Everyone says [topic] is simple. Here's the part they skip.",
    "[Topic] comes down to one thing.",
  ],
  reaction: [
    "I didn't expect this [topic] moment to hit this hard.",
    "Pause at the 3-second mark. That's the whole story.",
    "My honest take on [topic], with no sponsor.",
  ],
  generic: [
    "Watch what happens when [setup].",
    "I wasn't supposed to film this part of [topic].",
    "Give me [n] seconds and you'll see why [topic] is everywhere.",
  ],
};

export function detectFormat(title = "") {
  return PATTERNS.find((p) => p.test.test(title)) || { key: "generic", label: "Single-idea short" };
}

export function createOriginalBrief(reference, { topic, targetSeconds } = {}) {
  if (!reference?.title) throw Object.assign(new Error("reference.title is required"), { status: 400 });
  const fmt = detectFormat(reference.title);
  const short = (reference.durationSeconds ?? 60) <= 180;
  const length = targetSeconds || (short ? 45 : 480);
  const subject = (topic && !topic.startsWith("@") ? topic : reference.query && !reference.query.startsWith("@") ? reference.query : "[your topic]").trim();
  const hooks = (HOOKS[fmt.key] || HOOKS.generic).map((h) => h.replace(/\[topic\]/g, subject).replace(/^\[Topic\]/, cap(subject)));

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
  // Placeholders keep the titles honest: the creator fills in their own facts.
  const map = {
    challenge: ["I tried [challenge] for [time]", "Last one to [action] wins [prize]"],
    heartfelt: ["I surprised [person] after [years]", "Thanking the person who changed my life"],
    versus: ["[Cheap] vs [expensive] [thing]: I tested both", "[Thing]: what actually matters"],
    list: [`[N] ${t} mistakes I see every day`, `The ${t} tips that actually work`],
    explainer: [`${cap(t)}, explained simply`, `Why ${t} works (and when it doesn't)`],
    reaction: [`My honest take on ${t}`, `The ${t} moment that changed my mind`],
    reveal: ["[Time] inside [place]", "The [place] most people never see"],
  };
  return map[key] || [`${cap(t)}, my way`, `Trying the ${t} format everyone's using`];
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
