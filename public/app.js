const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => (n == null ? "n/a" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
const dur = (s) => (s == null ? "" : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

const state = { status: null, results: [], selected: null, project: null };

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error([body.error, ...(body.details || [])].filter(Boolean).join(" · ") || res.statusText);
  return body;
}

async function init() {
  state.status = await api("/api/status");
  $("#basis").innerHTML = Object.entries(state.status.rightsBases).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
  $("#features tbody").innerHTML = state.status.features
    .map((f) => `<tr><td>${esc(f.area)}</td><td>${esc(f.feature)}</td><td><span class="pill ${f.status}">${f.status}</span></td><td>${esc(f.note || "")}</td></tr>`)
    .join("");
}

// ---------- Find ----------
$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  search();
});
document.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", () => $("#q").value && search()));

async function search() {
  const params = new URLSearchParams({
    q: $("#q").value,
    mode: document.querySelector("input[name=mode]:checked").value,
    period: $("#period").value,
    format: $("#format").value,
    lang: $("#lang").value,
    region: $("#region").value.toUpperCase(),
  });
  $("#results").innerHTML = `<p class="hint">Searching…</p>`;
  try {
    const data = await api(`/api/search?${params}`);
    state.results = data.results;
    const n = $("#notice");
    n.hidden = false;
    n.textContent = data.notice;
    n.classList.toggle("live", !data.sampleData);
    renderResults(data);
  } catch (e) {
    $("#results").innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

function metric(label, m, f = fmt) {
  if (!m || m.value == null) return `<span class="metric">${label} <b>n/a</b></span>`;
  return `<span class="metric">${label} <b>${f(m.value)}</b><span class="basis ${m.basis}">${m.basis}</span></span>`;
}

function renderResults(data) {
  if (!data.results.length) {
    $("#results").innerHTML = `<p class="hint">No videos matched. Try a wider period or another format.</p>`;
    return;
  }
  $("#results").innerHTML = data.results
    .map(
      (v, i) => `
    <article class="result">
      <div class="rank">${v.rank}</div>
      <div>
        <h3>${esc(v.title)}</h3>
        <div class="meta">${esc(v.channelTitle)} · ${new Date(v.publishedAt).toLocaleDateString()} · ${dur(v.durationSeconds)} · <span class="tag">${v.format === "short" ? "Short (by length)" : "Long form"}</span></div>
        <div class="metrics">
          ${metric("Views", v.metrics.views)}
          ${metric("Views/hour", v.metrics.viewsPerHour)}
          ${metric("Engagement", v.metrics.engagementRate, (x) => `${x}%`)}
          ${metric("vs channel", v.metrics.outlierScore, (x) => `${x}x`)}
        </div>
        <ul class="reasons">${v.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
      </div>
      <div class="actions">
        ${v.url ? `<a class="tag" href="${esc(v.url)}" target="_blank" rel="noopener">Open on YouTube ↗</a>` : `<span class="tag">Sample, no link</span>`}
        <button data-pick="${i}">Use this</button>
      </div>
    </article>`,
    )
    .join("");
  document.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => pick(state.results[b.dataset.pick])));
}

// ---------- Make ----------
function showStep(step) {
  $("#find").hidden = step !== "find";
  $("#make").hidden = step !== "make";
  document.querySelectorAll(".step[data-step]").forEach((s) => s.classList.toggle("active", s.dataset.step === step));
  window.scrollTo(0, 0);
}
$("#back").addEventListener("click", () => showStep("find"));

function pick(video) {
  state.selected = { ...video, query: $("#q").value };
  state.project = null;
  $("#reference").innerHTML = `<div class="meta">Reference video</div><h3>${esc(video.title)}</h3><div class="meta">${esc(video.channelTitle)} · ${fmt(video.views)} views${
    video.url ? ` · <a href="${esc(video.url)}" target="_blank" rel="noopener">original link</a>` : " · sample data"
  }</div>`;
  $("#clip-panel").hidden = true;
  $("#original-panel").hidden = true;
  $("#sources").innerHTML = "";
  $("#cuts").innerHTML = "";
  $("#rights-log").hidden = true;
  document.querySelectorAll(".path").forEach((p) => p.classList.remove("selected"));
  showStep("make");
}

$("#path-clip").addEventListener("click", async () => {
  $("#path-clip").classList.add("selected");
  $("#path-original").classList.remove("selected");
  $("#original-panel").hidden = true;
  $("#clip-panel").hidden = false;
  if (!state.project) {
    state.project = await api("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: state.selected.title, reference: { title: state.selected.title, url: state.selected.url, id: state.selected.id } }),
    });
  }
});

$("#upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector("button");
  btn.disabled = true;
  btn.textContent = "Uploading…";
  try {
    state.project = await api(`/api/projects/${state.project.id}/sources`, { method: "POST", body: new FormData(form) });
    form.reset();
    form.querySelector(".error")?.remove();
    renderSources();
  } catch (err) {
    alertInline(form, err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Add source";
  }
});

function renderSources() {
  const p = state.project;
  $("#sources").innerHTML = p.sources
    .map((s) => {
      const r = p.rights.find((x) => x.sourceId === s.id);
      return `<li>🎞 <b>${esc(s.label)}</b> · ${dur(s.duration)} · ${s.width}×${s.height}${s.hasAudio ? "" : " · no audio"} · rights: ${esc(r?.basisText || "missing")}</li>`;
    })
    .join("");
  $("#make-cuts").disabled = !p.sources.length;
  $("#rights-log").hidden = !p.rights.length;
  $("#rights-log pre").textContent = JSON.stringify(p.rights, null, 2);
}

$("#make-cuts").addEventListener("click", async () => {
  const btn = $("#make-cuts");
  btn.disabled = true;
  $("#cut-status").textContent = "Finding strong moments, removing dead air and rendering three cuts…";
  try {
    const out = await api(`/api/projects/${state.project.id}/cuts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetSeconds: Number($("#target").value), aspect: $("#aspect").value }),
    });
    const dead = out.analysis.reduce((s, a) => s + a.deadAirSeconds, 0);
    $("#cut-status").textContent = `Done. Removed ${dead.toFixed(1)}s of dead air across ${out.analysis.length} source(s).`;
    $("#cuts").innerHTML = out.cuts
      .map(
        (c) => `
      <div class="cut">
        <h4>Cut ${c.id}: ${esc(c.name)}</h4>
        <video controls preload="metadata" poster="/media/${state.project.id}/${c.cover}" src="/media/${state.project.id}/${c.file}"></video>
        <p class="hint">${esc(c.opening)}</p>
        <p class="hint">${c.media.duration}s · ${c.media.width}×${c.media.height} · ${c.segments.length} shots</p>
        <a href="/media/${state.project.id}/${c.file}" download>Download MP4</a>
      </div>`,
      )
      .join("");
  } catch (err) {
    $("#cut-status").innerHTML = `<span class="error">${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});

$("#path-original").addEventListener("click", async () => {
  $("#path-original").classList.add("selected");
  $("#path-clip").classList.remove("selected");
  $("#clip-panel").hidden = true;
  const panel = $("#original-panel");
  panel.hidden = false;
  panel.innerHTML = `<p class="hint">Drafting…</p>`;
  try {
    const b = await api("/api/original", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reference: state.selected, options: { topic: state.selected.query } }),
    });
    panel.innerHTML = `
      <div class="card brief">
        <p class="hint">Draft from templates, based on the format only. Rewrite it in your own voice before filming.</p>
        <h3>Format: ${esc(b.format)} · ${b.targetSeconds}s · ${esc(b.orientation)}</h3>
        <h3>Hook options</h3><ol>${b.hooks.map((h) => `<li>${esc(h)}</li>`).join("")}</ol>
        <h3>Title ideas</h3><ul>${b.titleIdeas.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>
        <h3>Beats</h3><table><tr><th>Time</th><th>Beat</th><th>What to do</th></tr>${b.beats.map((x) => `<tr><td>${x.at}–${x.until}s</td><td>${esc(x.beat)}</td><td>${esc(x.note)}</td></tr>`).join("")}</table>
        <h3>Shot list</h3><table><tr><th>Shot</th><th>Framing</th><th>Source</th></tr>${b.shots.map((x) => `<tr><td>${esc(x.shot)}</td><td>${esc(x.framing)}</td><td>${esc(x.source)}</td></tr>`).join("")}</table>
        <h3>Rights guardrails</h3><ul>${b.rightsGuardrails.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>
      </div>`;
  } catch (err) {
    panel.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
});

function alertInline(el, msg) {
  let p = el.querySelector(".error");
  if (!p) {
    p = document.createElement("p");
    p.className = "error";
    el.append(p);
  }
  p.textContent = msg;
}

init();
