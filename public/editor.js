const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const r2 = (n) => Math.round(n * 100) / 100;

const params = new URLSearchParams(location.search);
const PID = params.get("project");
const S = { project: null, tl: null, credits: [], options: null, status: null, sel: null, playhead: 0, viewer: "source", suggestions: [] };

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : {};
  if (!res.ok) throw new Error([body.error, ...(body.details || [])].filter(Boolean).join(" · ") || res.statusText);
  return body;
}
const jsonOpts = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
function showError(msg) {
  const e = $("#error");
  e.hidden = !msg;
  e.textContent = msg || "";
}

// ---------- timing (mirrors src/edit/model.js) ----------
const clipDur = (c) => (c.out - c.in) / (c.speed || 1);
function txLen(clips, i) {
  if (i === 0) return 0;
  const t = clips[i].transition;
  if (!t || t.type === "cut") return 0;
  return Math.min(t.duration, clipDur(clips[i - 1]) / 2, clipDur(clips[i]) / 2);
}
function starts(tl) {
  let t = 0;
  return tl.clips.map((c, i) => {
    t -= txLen(tl.clips, i);
    const s = t;
    t += clipDur(c);
    return s;
  });
}
const total = (tl) => tl.clips.reduce((sum, c, i) => sum + clipDur(c) - txLen(tl.clips, i), 0);
const source = (id) => S.project.sources.find((s) => s.id === id);
const short = (label) => (label.length > 22 ? label.slice(0, 20) + "…" : label);

// ---------- load ----------
async function load() {
  if (!PID) return showError("Open the editor from a cut on the main page.");
  [S.project, S.options, S.status] = await Promise.all([api(`/api/projects/${PID}`), api("/api/editor/options"), api("/api/status")]);
  let view;
  if (params.get("cut")) {
    // Opened from a cut: start a fresh timeline from it, then drop the parameter so a reload keeps edits.
    view = await api(`/api/projects/${PID}/timeline/from-cut`, jsonOpts("POST", { file: params.get("cut") }));
    history.replaceState(null, "", `?project=${PID}`);
  } else {
    view = await api(`/api/projects/${PID}/timeline`);
  }
  applyView(view);
  S.sel = { kind: "clip", id: S.tl.clips[0]?.id };
  await refreshSuggestions();
  renderAll();
  selectClipInViewer();
}

function applyView(view) {
  S.tl = view.timeline;
  S.credits = view.credits || [];
}

// ---------- saving ----------
let saveTimer = null;
function mutate(fn, { immediate = false } = {}) {
  const tl = structuredClone(S.tl);
  fn(tl);
  S.tl = tl;
  renderAll();
  clearTimeout(saveTimer);
  $("#save-state").textContent = "Saving…";
  saveTimer = setTimeout(save, immediate ? 0 : 450);
}
async function save() {
  try {
    const view = await api(`/api/projects/${PID}/timeline`, jsonOpts("PUT", S.tl));
    applyView(view);
    showError("");
    $("#save-state").textContent = "Saved";
    renderTimeline();
  } catch (e) {
    showError(e.message);
    $("#save-state").textContent = "Not saved";
  }
}
async function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await save();
  }
}

// ---------- rendering the page ----------
function renderAll() {
  renderTimeline();
  renderInspector();
  renderCaptionsTab();
  renderAudioTab();
  renderPublishTab();
  renderExports();
  $("#aspect").value = S.tl.aspect;
  const opts = S.project.sources.filter((s) => s.kind !== "music").map((s) => `<option value="${s.id}">${esc(short(s.label))}</option>`).join("");
  if ($("#add-source").innerHTML !== opts) $("#add-source").innerHTML = opts;
}

function pps() {
  const w = $("#lane-video").clientWidth || 600;
  return w / Math.max(total(S.tl), 5);
}

function renderTimeline() {
  const tl = S.tl;
  const st = starts(tl);
  const k = pps();
  const T = total(tl);
  $("#total-time").textContent = `${T.toFixed(1)}s`;
  const step = T > 60 ? 10 : T > 20 ? 5 : 1;
  let ruler = "";
  for (let t = 0; t <= T + 0.001; t += step) ruler += `<span style="left:${t * k}px">${t}s</span>`;
  $("#ruler").innerHTML = ruler;
  const block = (kind, id, left, width, label, extra = "") =>
    `<div class="block ${kind} ${S.sel?.kind === kind && S.sel?.id === id ? "selected" : ""} ${extra}" data-kind="${kind}" data-id="${id}" style="left:${left}px;width:${Math.max(width, 6)}px" title="${esc(label)}">${esc(label)}</div>`;
  $("#lane-video").innerHTML = tl.clips
    .map((c, i) => {
      const label = `${short(source(c.sourceId)?.label || "?")}${c.speed !== 1 ? ` · ${c.speed}x` : ""}${c.effect !== "none" ? ` · ${c.effect}` : ""}`;
      const html = block("clip", c.id, st[i] * k, clipDur(c) * k, label, i % 2 ? "alt" : "");
      return txLen(tl.clips, i) > 0 ? html.replace('">', `"><span class="tx" title="${esc(c.transition.type)}"></span>`) : html;
    })
    .join("");
  $("#lane-broll").innerHTML = tl.broll.map((b) => block("broll", b.id, b.at * k, (b.out - b.in) * k, short(source(b.sourceId)?.label || "?"))).join("");
  $("#lane-captions").innerHTML = tl.captions.map((c) => block("caption", c.id, c.start * k, (c.end - c.start) * k, c.text)).join("");
  $("#lane-music").innerHTML = tl.music ? block("music", "music", 0, T * k, `${short(source(tl.music.sourceId)?.label || "music")} · ${Math.round(tl.music.volume * 100)}%${tl.music.duck ? " · ducking" : ""}`) : "";
  setPlayhead(S.playhead);
}

function setPlayhead(t) {
  S.playhead = Math.max(0, Math.min(t, total(S.tl)));
  $("#playhead").style.left = `${76 + S.playhead * pps()}px`;
  $("#playhead-time").textContent = `${S.playhead.toFixed(1)}s`;
}

$("#timeline").addEventListener("click", (e) => {
  const b = e.target.closest(".block");
  const lane = e.target.closest(".lane, .ruler");
  if (lane) {
    const rect = lane.getBoundingClientRect();
    setPlayhead((e.clientX - rect.left) / pps());
    if (S.viewer === "render") $("#player").currentTime = S.playhead;
  }
  if (b) {
    S.sel = { kind: b.dataset.kind, id: b.dataset.id };
    showTab(b.dataset.kind === "caption" ? "item" : b.dataset.kind === "music" ? "audio" : "item");
    renderTimeline();
    renderInspector();
    if (b.dataset.kind === "clip" || b.dataset.kind === "broll") selectClipInViewer();
  }
});
window.addEventListener("resize", () => renderTimeline());

// ---------- viewer ----------
function selectedItem() {
  const { kind, id } = S.sel || {};
  if (kind === "clip") return S.tl.clips.find((c) => c.id === id);
  if (kind === "broll") return S.tl.broll.find((c) => c.id === id);
  if (kind === "caption") return S.tl.captions.find((c) => c.id === id);
  return null;
}
function selectClipInViewer() {
  const item = selectedItem();
  if (!item?.sourceId) return;
  S.viewer = "source";
  const p = $("#player");
  const url = `/api/projects/${PID}/sources/${item.sourceId}/file`;
  if (!p.src.endsWith(url)) p.src = url;
  p.addEventListener("loadedmetadata", () => (p.currentTime = item.in), { once: true });
  if (p.readyState >= 1) p.currentTime = item.in;
  $("#viewer-label").textContent = `Source: ${source(item.sourceId)?.label}`;
  $("#trim-tools").hidden = false;
  $("#trim-info").textContent = `Using ${item.in.toFixed(2)}s to ${item.out.toFixed(2)}s of the source`;
}
$("#set-in").addEventListener("click", () => setTrim("in"));
$("#set-out").addEventListener("click", () => setTrim("out"));
function setTrim(edge) {
  const t = r2($("#player").currentTime);
  const { kind, id } = S.sel || {};
  mutate((tl) => {
    const list = kind === "broll" ? tl.broll : tl.clips;
    const c = list.find((x) => x.id === id);
    if (!c) return;
    if (edge === "in" && t < c.out - 0.2) c.in = t;
    if (edge === "out" && t > c.in + 0.2) c.out = t;
  });
  $("#trim-info").textContent = `Using ${selectedItem().in.toFixed(2)}s to ${selectedItem().out.toFixed(2)}s of the source`;
}
$("#player").addEventListener("timeupdate", () => {
  if (S.viewer === "render") setPlayhead($("#player").currentTime);
});

// ---------- inspector ----------
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-body").forEach((b) => (b.hidden = b.id !== `tab-${name}`));
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));

const slider = (label, path, min, max, step, value, fmt = (v) => v) =>
  `<label class="field"><span>${label}</span><input type="range" data-path="${path}" min="${min}" max="${max}" step="${step}" value="${value}" /><output>${fmt(value)}</output></label>`;
const numberField = (label, path, value, step = 0.1) =>
  `<label class="field wide"><span>${label}</span><input type="number" data-path="${path}" step="${step}" value="${value}" /></label>`;
const selectField = (label, path, options, value) =>
  `<label class="field wide"><span>${label}</span><select data-path="${path}">${Object.entries(options)
    .map(([k, v]) => `<option value="${esc(k)}" ${k === value ? "selected" : ""}>${esc(v)}</option>`)
    .join("")}</select></label>`;

function renderInspector() {
  const box = $("#tab-item");
  const item = selectedItem();
  const kind = S.sel?.kind;
  if (!item) {
    box.innerHTML = `<p class="hint">Click a block on the timeline to edit it.</p>`;
    return;
  }
  if (kind === "clip") {
    const i = S.tl.clips.indexOf(item);
    box.innerHTML = `
      <h4>Clip ${i + 1} of ${S.tl.clips.length}</h4>
      <p class="source-pill">${esc(source(item.sourceId)?.label)} · ${item.in.toFixed(2)}s to ${item.out.toFixed(2)}s · plays ${clipDur(item).toFixed(2)}s</p>
      ${numberField("Start (source s)", "in", item.in)}
      ${numberField("End (source s)", "out", item.out)}
      ${slider("Speed", "speed", 0.5, 2, 0.05, item.speed, (v) => `${v}x`)}
      ${slider("Zoom", "zoom", 1, 3, 0.05, item.zoom, (v) => `${v}x`)}
      ${slider("Frame left/right", "focusX", 0, 1, 0.01, item.focusX)}
      ${slider("Frame up/down", "focusY", 0, 1, 0.01, item.focusY)}
      <h4>Color</h4>
      ${slider("Brightness", "color.brightness", -0.3, 0.3, 0.01, item.color.brightness)}
      ${slider("Contrast", "color.contrast", 0.5, 2, 0.01, item.color.contrast)}
      ${slider("Saturation", "color.saturation", 0, 3, 0.01, item.color.saturation)}
      ${selectField("Effect", "effect", S.options.effects, item.effect)}
      ${i > 0 ? selectField("Transition in", "transition.type", S.options.transitions, item.transition.type) + slider("Transition length", "transition.duration", 0.1, 2, 0.05, item.transition.duration, (v) => `${v}s`) : ""}
      <h4>Sound</h4>
      ${slider("Volume", "volume", 0, 2, 0.05, item.volume, (v) => `${Math.round(v * 100)}%`)}
      <label class="check"><input type="checkbox" data-path="muted" ${item.muted ? "checked" : ""}/> Mute this clip</label>
      <div class="row-tools">
        <button class="ghost small" data-act="left" ${i === 0 ? "disabled" : ""}>◀ Move</button>
        <button class="ghost small" data-act="right" ${i === S.tl.clips.length - 1 ? "disabled" : ""}>Move ▶</button>
        <button class="ghost small" data-act="dup">Duplicate</button>
        <button class="ghost small" data-act="reset">Reset look</button>
        <button class="danger small" data-act="del" ${S.tl.clips.length === 1 ? "disabled" : ""}>Delete</button>
      </div>`;
  } else if (kind === "broll") {
    const opts = Object.fromEntries(S.project.sources.filter((s) => s.kind !== "music").map((s) => [s.id, s.label]));
    box.innerHTML = `
      <h4>B-roll</h4>
      <p class="hint">Covers the main picture while the main audio keeps playing.</p>
      ${selectField("Source", "sourceId", opts, item.sourceId)}
      ${numberField("Start (source s)", "in", item.in)}
      ${numberField("End (source s)", "out", item.out)}
      ${numberField("Appears at (s)", "at", item.at)}
      <div class="row-tools"><button class="danger small" data-act="del">Delete</button></div>`;
  } else if (kind === "caption") {
    box.innerHTML = `
      <h4>Caption</h4>
      <label class="field wide"><span>Text</span><input data-path="text" value="${esc(item.text)}" maxlength="200" /></label>
      ${numberField("Start (s)", "start", item.start)}
      ${numberField("End (s)", "end", item.end)}
      <div class="row-tools"><button class="danger small" data-act="del">Delete</button></div>`;
  }
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
}
function readInput(el) {
  if (el.type === "checkbox") return el.checked;
  if (el.type === "range" || el.type === "number") return Number(el.value);
  return el.value;
}
function listFor(tl, kind) {
  return kind === "clip" ? tl.clips : kind === "broll" ? tl.broll : tl.captions;
}
$("#tab-item").addEventListener("input", (e) => {
  const el = e.target.closest("[data-path]");
  if (!el) return;
  const out = el.parentElement.querySelector("output");
  if (out) out.textContent = el.dataset.path.includes("duration") ? `${el.value}s` : el.dataset.path === "volume" ? `${Math.round(el.value * 100)}%` : ["speed", "zoom"].includes(el.dataset.path) ? `${el.value}x` : el.value;
  const { kind, id } = S.sel;
  const quiet = el.type === "range" || el.tagName === "INPUT";
  mutateQuiet(quiet, (tl) => {
    const item = listFor(tl, kind).find((x) => x.id === id);
    if (item) setPath(item, el.dataset.path, readInput(el));
  });
});
// While typing or dragging, don't rebuild the inspector (it would steal focus).
function mutateQuiet(quiet, fn) {
  const tl = structuredClone(S.tl);
  fn(tl);
  S.tl = tl;
  renderTimeline();
  if (!quiet) renderInspector();
  clearTimeout(saveTimer);
  $("#save-state").textContent = "Saving…";
  saveTimer = setTimeout(save, 450);
}
$("#tab-item").addEventListener("change", (e) => {
  if (e.target.tagName === "SELECT" || e.target.type === "checkbox") renderInspector();
});
$("#tab-item").addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) return;
  const { kind, id } = S.sel;
  mutate((tl) => {
    const list = listFor(tl, kind);
    const i = list.findIndex((x) => x.id === id);
    if (act === "del") {
      list.splice(i, 1);
      S.sel = kind === "clip" ? { kind, id: list[Math.max(0, i - 1)]?.id } : null;
    }
    if (act === "left" && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    if (act === "right" && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
    if (act === "dup") {
      const copy = structuredClone(list[i]);
      copy.id = Math.random().toString(36).slice(2, 10);
      list.splice(i + 1, 0, copy);
      S.sel = { kind, id: copy.id };
    }
    if (act === "reset") Object.assign(list[i], { zoom: 1, focusX: 0.5, focusY: 0.5, effect: "none", color: { brightness: 0, contrast: 1, saturation: 1 } });
  });
});

// ---------- toolbar ----------
$("#aspect").addEventListener("change", (e) => mutate((tl) => (tl.aspect = e.target.value)));
$("#split-btn").addEventListener("click", async () => {
  await flush();
  try {
    applyView(await api(`/api/projects/${PID}/timeline/split`, jsonOpts("POST", { at: S.playhead })));
    renderAll();
  } catch (e) {
    showError(e.message);
  }
});
$("#caption-btn").addEventListener("click", () => {
  const id = Math.random().toString(36).slice(2, 10);
  mutate((tl) => tl.captions.push({ id, start: r2(S.playhead), end: r2(Math.min(S.playhead + 2.5, total(tl))), text: "New caption" }), { immediate: true });
  S.sel = { kind: "caption", id };
  showTab("item");
  renderAll();
  $("#tab-item input[data-path=text]")?.select();
});
$("#broll-btn").addEventListener("click", () => {
  const src = $("#add-source").value;
  const id = Math.random().toString(36).slice(2, 10);
  mutate((tl) => tl.broll.push({ id, sourceId: src, in: 0, out: Math.min(3, source(src).duration), at: r2(S.playhead) }), { immediate: true });
  S.sel = { kind: "broll", id };
  showTab("item");
  renderAll();
  selectClipInViewer();
});
$("#add-clip-btn").addEventListener("click", () => {
  const src = $("#add-source").value;
  const id = Math.random().toString(36).slice(2, 10);
  mutate((tl) => tl.clips.push({ id, sourceId: src, in: 0, out: Math.min(5, source(src).duration), speed: 1, zoom: 1, focusX: 0.5, focusY: 0.5, color: { brightness: 0, contrast: 1, saturation: 1 }, effect: "none", transition: { type: "cut", duration: 0.4 }, volume: 1, muted: false }), { immediate: true });
  S.sel = { kind: "clip", id };
  renderAll();
  selectClipInViewer();
});

// ---------- captions tab ----------
function renderCaptionsTab() {
  const st = S.tl.captionStyle;
  $("#tab-captions").innerHTML = `
    <p class="hint">Type captions or paste an SRT file. They are burned into the video and also exported as an .srt file. Automatic speech-to-text needs a transcription service and is not connected yet.</p>
    <div id="caption-list">${S.tl.captions
      .map((c) => `<div class="caption-row" data-id="${c.id}"><input type="number" step="0.1" data-k="start" value="${c.start}" title="Start (s)"/><input type="number" step="0.1" data-k="end" value="${c.end}" title="End (s)"/><input data-k="text" value="${esc(c.text)}"/><button class="danger small" data-del="${c.id}">✕</button></div>`)
      .join("") || `<p class="hint">No captions yet. Use "+ Caption at playhead".</p>`}</div>
    <h4>Style</h4>
    ${selectField("Position", "position", { top: "Top", middle: "Middle", bottom: "Bottom" }, st.position)}
    ${slider("Size", "size", 0.6, 2, 0.05, st.size, (v) => `${v}x`)}
    <label class="field wide"><span>Color</span><input type="color" data-path="color" value="${st.color}"/></label>
    <label class="check"><input type="checkbox" data-path="box" ${st.box ? "checked" : ""}/> Dark box behind text</label>
    <h4>Import SRT</h4>
    <textarea id="srt-text" placeholder="1&#10;00:00:00,500 --> 00:00:02,000&#10;Your caption"></textarea>
    <div class="row-tools"><button class="ghost small" id="srt-import">Replace captions with this SRT</button><button class="ghost small" id="srt-download" ${S.tl.captions.length ? "" : "disabled"}>Download .srt</button></div>`;
}
$("#tab-captions").addEventListener("change", (e) => {
  const row = e.target.closest(".caption-row");
  if (row) {
    return mutate((tl) => {
      const c = tl.captions.find((x) => x.id === row.dataset.id);
      c[e.target.dataset.k] = e.target.dataset.k === "text" ? e.target.value : Number(e.target.value);
    });
  }
  const el = e.target.closest("[data-path]");
  if (el) mutate((tl) => (tl.captionStyle[el.dataset.path] = readInput(el)));
});
$("#tab-captions").addEventListener("click", async (e) => {
  if (e.target.dataset.del) mutate((tl) => (tl.captions = tl.captions.filter((c) => c.id !== e.target.dataset.del)));
  if (e.target.id === "srt-import") {
    try {
      const { captions } = await api(`/api/projects/${PID}/captions/srt`, { method: "POST", headers: { "content-type": "text/plain" }, body: $("#srt-text").value });
      mutate((tl) => (tl.captions = captions), { immediate: true });
    } catch (err) {
      showError(err.message);
    }
  }
  if (e.target.id === "srt-download") {
    const ts = (s) => new Date(s * 1000).toISOString().slice(11, 23).replace(".", ",");
    const text = S.tl.captions.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join("\n");
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type: "text/plain" })), download: "captions.srt" });
    a.click();
  }
});

// ---------- audio tab ----------
function renderAudioTab() {
  const m = S.tl.music;
  const audioSources = S.project.sources.filter((s) => s.hasAudio);
  const bases = S.status?.rightsBases || {};
  $("#tab-audio").innerHTML = `
    <h4>Clean-up</h4>
    <label class="check"><input type="checkbox" data-a="cleanup" ${S.tl.audio.cleanup ? "checked" : ""}/> Remove rumble and background hiss</label>
    <label class="check"><input type="checkbox" data-a="normalize" ${S.tl.audio.normalize ? "checked" : ""}/> Even out loudness (YouTube level, -14 LUFS)</label>
    <h4>Music</h4>
    <label class="field wide"><span>Track</span><select data-m="sourceId"><option value="">No music</option>${audioSources
      .map((s) => `<option value="${s.id}" ${m?.sourceId === s.id ? "selected" : ""}>${esc(short(s.label))}${s.kind === "music" ? " (music)" : ""}</option>`)
      .join("")}</select></label>
    ${m ? `${slider("Volume", "volume", 0, 1.5, 0.05, m.volume, (v) => `${Math.round(v * 100)}%`).replace("data-path", "data-m")}
    <label class="field wide"><span>Start at (s)</span><input type="number" step="0.5" data-m="in" value="${m.in}"/></label>
    <label class="check"><input type="checkbox" data-m="duck" ${m.duck ? "checked" : ""}/> Lower music automatically when people speak</label>` : ""}
    <h4>Add a music file</h4>
    <form id="music-form" class="tab-body">
      <input type="file" name="file" accept="audio/*,.mp3,.m4a,.wav" required />
      <select name="basis">${Object.entries(bases).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>
      <input name="holder" placeholder="Rights holder" required />
      <input name="evidence" placeholder="Licence link (e.g. the YouTube Audio Library page)" />
      <input name="attribution" placeholder="Credit line if the licence asks for one" />
      <label class="check"><input type="checkbox" name="confirmed" value="true" required /> I may use this music in published videos.</label>
      <input type="hidden" name="kind" value="music" />
      <button type="submit" class="ghost">Upload music</button>
    </form>`;
}
$("#tab-audio").addEventListener("change", (e) => {
  const a = e.target.dataset.a;
  const m = e.target.dataset.m;
  if (a) mutate((tl) => (tl.audio[a] = e.target.checked));
  if (m === "sourceId") mutate((tl) => (tl.music = e.target.value ? { sourceId: e.target.value, in: 0, volume: 0.25, duck: true } : null));
  else if (m) mutate((tl) => (tl.music[m] = readInput(e.target)));
});
$("#tab-audio").addEventListener("input", (e) => {
  if (e.target.type === "range" && e.target.dataset.m) {
    e.target.parentElement.querySelector("output").textContent = `${Math.round(e.target.value * 100)}%`;
  }
});
$("#tab-audio").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    S.project = await api(`/api/projects/${PID}/sources`, { method: "POST", body: new FormData(e.target) });
    const added = S.project.sources.at(-1);
    mutate((tl) => (tl.music = { sourceId: added.id, in: 0, volume: 0.25, duck: true }), { immediate: true });
  } catch (err) {
    showError(err.message);
  }
});

// ---------- publish tab ----------
async function refreshSuggestions() {
  try {
    const s = await api(`/api/projects/${PID}/meta/suggest`, jsonOpts("POST", {}));
    S.suggestions = s.titles;
    return s;
  } catch {
    return null;
  }
}
function renderPublishTab() {
  const meta = S.tl.meta;
  $("#tab-publish").innerHTML = `
    <label class="field wide"><span>Title</span><input data-meta="title" maxlength="100" value="${esc(meta.title)}"/></label>
    <div class="row-tools">${S.suggestions.map((t) => `<button class="ghost small" data-title="${esc(t)}">${esc(t)}</button>`).join("")}</div>
    <label class="field wide"><span>Description</span><textarea data-meta="description">${esc(meta.description)}</textarea></label>
    ${S.credits.length ? `<p class="hint"><b>Credits that must stay in the description:</b><br>${S.credits.map(esc).join("<br>")}</p>` : ""}
    <label class="field wide"><span>Cover text</span><input data-meta="coverText" maxlength="60" value="${esc(meta.coverText)}"/></label>
    <label class="field wide"><span>Cover frame (s)</span><input type="number" step="0.1" data-meta="coverTime" value="${meta.coverTime}"/></label>
    <div class="row-tools"><button class="ghost small" id="cover-here">Use playhead as cover</button><button class="ghost small" id="suggest">Suggest again</button></div>
    <p class="hint">Suggestions come from templates. Edit them so they're accurate and sound like you.</p>`;
}
$("#tab-publish").addEventListener("change", (e) => {
  const k = e.target.dataset.meta;
  if (k) mutate((tl) => (tl.meta[k] = k === "coverTime" ? Number(e.target.value) : e.target.value));
});
$("#tab-publish").addEventListener("click", async (e) => {
  if (e.target.dataset.title) mutate((tl) => (tl.meta.title = e.target.dataset.title));
  if (e.target.id === "cover-here") mutate((tl) => (tl.meta.coverTime = r2(S.playhead)));
  if (e.target.id === "suggest") {
    await flush();
    const s = await refreshSuggestions();
    if (s) mutate((tl) => Object.assign(tl.meta, { description: s.description, coverText: tl.meta.coverText || s.coverText }));
  }
});

// ---------- render ----------
async function render(preview) {
  await flush();
  const btns = [$("#preview-btn"), $("#export-btn")];
  btns.forEach((b) => (b.disabled = true));
  $("#render-state").textContent = preview ? "Rendering a quick preview…" : "Rendering the final video, this can take a minute…";
  try {
    const out = await api(`/api/projects/${PID}/render`, jsonOpts("POST", { preview }));
    S.viewer = "render";
    const p = $("#player");
    p.src = `/media/${PID}/${out.file}`;
    $("#viewer-label").textContent = preview ? "Quick preview (low resolution)" : "Final export";
    $("#trim-tools").hidden = true;
    $("#render-state").textContent = `${preview ? "Preview" : "Export"} ready: ${out.media.duration}s, ${out.media.width}×${out.media.height}`;
    if (!preview) {
      S.project = await api(`/api/projects/${PID}`);
      renderExports();
    }
  } catch (e) {
    $("#render-state").textContent = "";
    showError(e.message);
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}
$("#preview-btn").addEventListener("click", () => render(true));
$("#export-btn").addEventListener("click", () => render(false));

function renderExports() {
  const ex = S.project.exports || [];
  $("#exports-card").hidden = !ex.length;
  $("#exports").innerHTML = ex
    .slice()
    .reverse()
    .map(
      (x) => `<div class="cut">
        <h4>${esc(x.title || "Untitled")}</h4>
        <video controls preload="metadata" poster="/media/${PID}/${x.cover}" src="/media/${PID}/${x.file}"></video>
        <p class="hint">${x.media.duration}s · ${x.media.width}×${x.media.height} · ${new Date(x.createdAt).toLocaleString()}</p>
        <div class="row-tools">
          <a href="/media/${PID}/${x.file}" download>MP4</a>
          <a href="/media/${PID}/${x.cover}" download>Cover</a>
          ${x.srt ? `<a href="/media/${PID}/${x.srt}" download>Captions .srt</a>` : ""}
          <button class="ghost small" data-copy="${esc(`${x.title}\n\n${x.description}`)}">Copy title and description</button>
        </div>
      </div>`,
    )
    .join("");
}
$("#exports").addEventListener("click", (e) => {
  if (e.target.dataset.copy) navigator.clipboard?.writeText(e.target.dataset.copy).then(() => (e.target.textContent = "Copied"));
});

load().catch((e) => showError(e.message));
