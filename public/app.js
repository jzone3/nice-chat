// Nice Chat client: join → stream → type (Jev scores as you go) → send (server re-checks).
(() => {
  const $ = (id) => document.getElementById(id);
  const el = {
    thread: $("thread"), hello: $("thread-hello"), composer: $("composer"), draft: $("draft"), send: $("send"),
    sendLabel: document.querySelector(".send-label"), sendEmoji: document.querySelector(".send-emoji"),
    verdict: $("verdict"), face: $("verdict-face"), meter: $("meter-fill"), vtext: $("verdict-text"), chars: $("chars"), reasons: $("reasons"),
    meEmoji: $("me-emoji"), online: $("online-count"), faces: $("faces"), debug: $("debug-toggle"),
    liveHint: $("live-hint"), liveProbs: $("live-probs"), liveMeta: $("live-meta"), fame: $("fame"),
    sReq: $("s-requests"), sBlocked: $("s-blocked"), sLat: $("s-latency"), sModel: $("s-model"), sBudget: $("s-budget"),
    modal: $("join-modal"), joinForm: $("join-form"), joinName: $("join-name"), grid: $("emoji-grid"), shuffle: $("shuffle"),
    pvEmoji: document.querySelector(".pv-emoji"), pvName: document.querySelector(".pv-name"), joinErr: $("join-err"), joinBtn: $("join-btn"),
    joinClose: $("join-close"), joinTitle: $("join-title"), joinSub: $("join-sub"),
    welcome: $("welcome-modal"), welcomeWho: $("welcome-who"), welcomeOk: $("welcome-ok"), welcomeClose: $("welcome-close"), about: $("about"),
    toast: $("toast"),
    chat: document.querySelector(".chat"), rail: $("rail"), live: $("live"),
    railToggle: $("rail-toggle"), railClose: $("rail-close"), railBackdrop: $("rail-backdrop"),
  };
  // Mirrors the phone media query in style.css.
  const MOBILE = matchMedia("(max-width: 640px), ((max-height: 520px) and (pointer: coarse))");
  const COARSE = matchMedia("(pointer: coarse)");

  const EMOJIS = "😀 😎 🥳 🤩 😇 🥰 🤠 🤓 🧐 🥸 😺 🐶 🦊 🐼 🐨 🦁 🐸 🐙 🦄 🐝 🦋 🐢 🐧 🦖 🌈 🌸 🌻 🍀 🌙 ⭐ 🔥 🍕 🍩 🧁 🍓 🥑 🎈 🎨 🎸 🚀 🛸 🧸 🪐 🍄 🐳 🦥 🦩 🫧".split(" ");
  const FLAG_LABELS = {
    is_kind: "kind",
    is_laughter: "laughter",
    is_insult: "insult",
    is_sarcastic_or_backhanded: "sarcasm",
    is_passive_aggressive: "passive-aggr.",
    is_profane_or_slur: "profanity/slur",
    is_disguised_slur: "disguised slur",
    is_derogatory_label: "put-down label",
    is_hateful: "hateful",
    is_harassment_or_threat: "harass/threat",
    has_link: "link",
  };
  const FACES = ["😡", "😒", "😐", "😊", "🥰"];
  const REACTIONS = ["❤️", "😂"];

  let me = null;
  let latest = null; // last verdict for the current draft
  let seq = 0;
  let judgeTimer = null;
  let judgeCtl = null;
  let sending = false;

  // ------------------------------------------------------------ utils
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const pct = (p) => `${Math.round((p ?? 0) * 100)}%`;
  const TINTS = 5;
  const tintOf = (key) => {
    let h = 5381;
    for (const ch of key) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
    return h % TINTS;
  };
  const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;

  function toast(msg, ms = 2200) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.toast.classList.remove("show"), ms);
  }

  async function api(path, body, signal) {
    const res = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    let data = {};
    try { data = await res.json(); } catch {}
    return { status: res.status, ok: res.ok, data };
  }

  function probRow(label, p, { hot = false, detail = false } = {}) {
    const row = document.createElement("div");
    row.className = "prob" + (hot ? " hot" : "") + (detail ? " detail" : "");
    row.innerHTML = `<span class="lbl"></span><span class="bar"><i style="width:${pct(p)}"></i></span><span class="val">${(p ?? 0).toFixed(2)}</span>`;
    row.querySelector(".lbl").textContent = label;
    return row;
  }
  function groupRow(text, detail = false) {
    const row = document.createElement("div");
    row.className = "prob group" + (detail ? " detail" : "");
    row.textContent = text;
    return row;
  }

  // Renders every probability Jev returned for a draft or a message.
  function renderProbs(container, v) {
    container.replaceChildren();
    if (!v || !v.flags) return;
    container.append(groupRow("flags (p = yes)"));
    for (const [k, label] of Object.entries(FLAG_LABELS)) {
      if (v.flags[k] == null) continue;
      container.append(probRow(label, v.flags[k], { hot: k !== "is_kind" && (v.hits || []).includes(k) }));
    }
    // tone + niceness distributions only show in debugger mode
    if (v.tone_probs) {
      container.append(groupRow(`tone → ${v.tone}`, true));
      for (const [k, p] of Object.entries(v.tone_probs)) container.append(probRow(k, p, { hot: (k === "hostile" || k === "cold") && (v.hits || []).includes(k), detail: true }));
    }
    if (v.niceness_probs) {
      container.append(groupRow(`niceness → ${v.niceness} / 5`, true));
      for (const [k, p] of Object.entries(v.niceness_probs)) container.append(probRow(`${k} ${FACES[Number(k) - 1] || ""}`, p, { detail: true }));
    }
    if (v.meanness != null) container.append(probRow("meanness (wiggle)", v.meanness, { hot: v.meanness >= 0.6 }));
  }

  // ------------------------------------------------------------ join
  let pickedEmoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  function renderGrid() {
    el.grid.replaceChildren(
      ...EMOJIS.map((e) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = e;
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(e === pickedEmoji));
        b.onclick = () => { pickedEmoji = e; renderGrid(); preview(); };
        return b;
      })
    );
  }
  function preview() {
    el.pvEmoji.textContent = pickedEmoji;
    el.pvName.textContent = el.joinName.value.trim() || "you";
  }
  el.shuffle.onclick = () => { pickedEmoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)]; renderGrid(); preview(); };
  el.joinName.oninput = preview;
  renderGrid();
  preview();

  // The same card joins and edits: with an account it opens pre-filled as "change your look".
  function openJoin(editing) {
    el.joinTitle.textContent = editing ? "✏️ Change your look" : "💖 Nice Chat";
    el.joinSub.textContent = editing ? "New name, new emoji, or both. Jev checks names too." : "One big room. Everyone in the world. Only nice messages get through.";
    el.joinBtn.textContent = editing ? "Save ✨" : "Join the chat 🎉";
    el.joinClose.classList.toggle("hidden", !editing);
    el.joinErr.replaceChildren();
    if (editing) { el.joinName.value = me.name; pickedEmoji = me.emoji; renderGrid(); preview(); }
    el.modal.classList.remove("hidden");
    el.joinName.focus();
  }
  el.meEmoji.onclick = () => { if (me) openJoin(true); };
  el.joinClose.onclick = () => { if (me) el.modal.classList.add("hidden"); };
  el.modal.addEventListener("keydown", (e) => { if (e.key === "Escape" && me) el.modal.classList.add("hidden"); });

  function joinError(data) {
    el.joinErr.replaceChildren(document.createTextNode(data.error || "Hmm, try again"));
    if (data.reasons?.length) {
      const tips = document.createElement("span");
      tips.className = "reasons";
      tips.replaceChildren(...data.reasons.map((r) => { const c = document.createElement("span"); c.className = "tip"; c.textContent = r; return c; }));
      el.joinErr.append(tips);
    }
  }

  el.joinForm.onsubmit = async (e) => {
    e.preventDefault();
    el.joinErr.replaceChildren();
    el.joinBtn.disabled = true;
    const editing = Boolean(me);
    try {
      const { ok, data } = await api("/api/join", { name: el.joinName.value, emoji: pickedEmoji });
      if (!ok) { joinError(data); if (data.blocked) wiggle(0.8, el.joinBtn); return; }
      enter(data.user);
      if (editing) toast(`You're now ${data.user.emoji} ${data.user.name}`);
      else { connect(); openWelcome(); } // reconnect so the stream carries our identity for presence
    } catch {
      joinError({ error: "Couldn't reach the server — try again" });
    } finally {
      el.joinBtn.disabled = false;
    }
  };

  // House rules, shown once right after joining and again from the footer's "about".
  // While open, the rest of the page is inert and Tab cycles inside the dialog; closing returns focus to the opener.
  const behindWelcome = () => [...document.body.children].filter((n) => n !== el.welcome && n.tagName !== "SCRIPT");
  let welcomeOpener = null;
  function openWelcome(opener = null) {
    welcomeOpener = opener;
    el.welcomeWho.textContent = me ? `${me.emoji} ${me.name}` : "friend";
    for (const n of behindWelcome()) n.inert = true;
    el.welcome.classList.remove("hidden");
    el.welcomeOk.focus();
  }
  function closeWelcome() {
    el.welcome.classList.add("hidden");
    for (const n of behindWelcome()) n.inert = false;
    (welcomeOpener || (me ? el.draft : el.joinName)).focus();
    welcomeOpener = null;
  }
  el.about.onclick = () => openWelcome(el.about);
  el.welcomeOk.onclick = closeWelcome;
  el.welcomeClose.onclick = closeWelcome;
  el.welcome.onclick = (e) => { if (e.target === el.welcome) closeWelcome(); };
  el.welcome.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return closeWelcome();
    if (e.key !== "Tab") return;
    const stops = [...el.welcome.querySelectorAll("button, a[href]")];
    const first = stops[0], last = stops[stops.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // Every look this tab has worn, so messages sent under an old name stay "mine" after a change.
  const myLooks = new Set();
  const isMine = (m) => myLooks.has(`${m.name}\u0000${m.emoji}`);
  function enter(user) {
    me = user;
    myLooks.add(`${me.name}\u0000${me.emoji}`);
    el.modal.classList.add("hidden");
    el.meEmoji.textContent = user.emoji;
    el.meEmoji.disabled = false;
    el.draft.disabled = false;
    el.send.disabled = false;
    el.draft.focus();
    for (const m of el.thread.querySelectorAll(".msg")) m.classList.toggle("mine", isMine(m.dataset));
  }

  // ------------------------------------------------------------ realtime
  // Two transports, chosen by the server (/api/me): "sse" (one process pushes) or "poll" (serverless; we ask every few seconds).
  let transport = "sse";
  let pollMs = 2500;
  let es = null;
  let pollTimer = null;
  // Cursor is server time at the last poll minus an overlap window: messages written a moment before
  // that time (e.g. by another instance) would otherwise be skipped; dedupe by id makes the overlap free.
  let pollCursor = 0;
  const POLL_OVERLAP_MS = 10_000;
  let polling = false;
  // The thread is live-only: nothing said before this page loaded is shown, so a refresh starts clean.
  // Server time (from the first payload) so it compares with message ts regardless of the local clock.
  let joinedAt = 0;

  function applyHistory(d) {
    if (!joinedAt) joinedAt = d.now || Date.now();
    el.thread.querySelectorAll(".msg").forEach((n) => n.remove());
    for (const m of d.messages) addMessage(m, false);
    applyReactions(d.reactions);
    scrollDown(true);
    renderFame(d.fame);
    renderPresence(d.presence);
    renderStats(d.stats);
  }

  function connect() {
    if (transport === "poll") return startPolling(true);
    es?.close();
    es = new EventSource("/api/stream");
    es.addEventListener("history", (ev) => applyHistory(JSON.parse(ev.data)));
    es.addEventListener("message", (ev) => {
      const d = JSON.parse(ev.data);
      addMessage(d.message, true);
      renderFame(d.fame);
    });
    es.addEventListener("presence", (ev) => renderPresence(JSON.parse(ev.data)));
    es.addEventListener("reactions", (ev) => {
      const d = JSON.parse(ev.data);
      applyReactions({ [d.id]: d.reactions });
    });
    es.onerror = () => { el.online.textContent = "…"; };
  }

  async function poll(full = false) {
    if (polling) return;
    polling = true;
    try {
      const { ok, data } = await api(full ? "/api/poll" : `/api/poll?since=${pollCursor}`);
      if (!ok) { el.online.textContent = "…"; return; }
      if (data.full) applyHistory(data);
      else {
        for (const m of data.messages) addMessage(m, true);
        applyReactions(data.reactions);
        renderFame(data.fame);
        renderPresence(data.presence);
        renderStats(data.stats);
      }
      pollCursor = Math.max(pollCursor, (data.now || Date.now()) - POLL_OVERLAP_MS, joinedAt);
    } catch {
      el.online.textContent = "…";
    } finally {
      polling = false;
    }
  }

  function startPolling(full) {
    clearInterval(pollTimer);
    poll(full);
    pollTimer = setInterval(() => { if (document.visibilityState !== "hidden") poll(); }, pollMs);
  }
  document.addEventListener("visibilitychange", () => {
    if (transport === "poll" && document.visibilityState === "visible") poll();
  });

  function nearBottom() {
    return el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight < 120;
  }
  function scrollDown(force) {
    if (force || nearBottom()) el.thread.scrollTop = el.thread.scrollHeight;
  }

  function addMessage(m, live) {
    if (m.ts < joinedAt) return;
    if (m.id && el.thread.querySelector(`.msg[data-id="${m.id}"]`)) return;
    el.hello.style.display = "none";
    const stick = nearBottom();
    const node = document.createElement("article");
    node.className = "msg" + (isMine(m) ? " mine" : "");
    node.dataset.id = m.id || "";
    node.dataset.ts = m.ts;
    node.dataset.name = m.name;
    node.dataset.emoji = m.emoji;
    node.dataset.tint = tintOf(`${m.name}\u0000${m.emoji}`);
    node.innerHTML = `
      <div class="avatar"></div>
      <div class="bubble">
        <div class="meta"><span class="name"></span><span class="time">${fmtTime(m.ts)}</span><span class="nice-badge"></span></div>
        <p class="text"></p>
        <div class="reacts"></div>
        <div class="probs"></div>
      </div>`;
    const reacts = node.querySelector(".reacts");
    for (const e of REACTIONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "react";
      b.dataset.emoji = e;
      b.title = e === "❤️" ? "Love" : "Haha";
      b.innerHTML = `<span class="e"></span><span class="n"></span>`;
      b.querySelector(".e").textContent = e;
      b.addEventListener("click", () => react(m.id, e, b));
      reacts.append(b);
    }
    node.querySelector(".avatar").textContent = m.emoji;
    node.querySelector(".name").textContent = m.name;
    node.querySelector(".text").textContent = m.text;
    node.querySelector(".nice-badge").textContent = m.niceness != null ? `${FACES[Math.max(0, Math.min(4, Math.round(m.niceness) - 1))]} ${m.niceness.toFixed(1)} · ${m.tone}` : "";
    renderProbs(node.querySelector(".probs"), { flags: m.scores?.flags, tone: m.tone, tone_probs: m.scores?.tone_probs, niceness: m.niceness, niceness_probs: m.scores?.niceness_probs, hits: [] });
    if (m.scores?.latency_ms != null) node.querySelector(".probs").append(groupRow(`jev latency ${m.scores.latency_ms} ms`));
    // Polling can deliver a peer's slightly older message after our own; keep the thread in ts order.
    let before = null;
    for (let n = el.thread.lastElementChild; n && n.classList.contains("msg") && Number(n.dataset.ts) > m.ts; n = n.previousElementSibling) before = n;
    if (before) el.thread.insertBefore(node, before);
    else el.thread.append(node);
    while (el.thread.querySelectorAll(".msg").length > 300) el.thread.querySelector(".msg").remove();
    if (live ? stick : true) scrollDown(true);
  }

  // Snapshots arrive from the POST reply, polls and SSE in no fixed order; `at` (server ms of the last
  // change) keeps an older one from overwriting a newer. Other viewers' SSE copies carry counts only,
  // so `me` is kept as-is when absent.
  function applyReactions(map) {
    for (const [id, rx] of Object.entries(map || {})) {
      const node = el.thread.querySelector(`.msg[data-id="${id}"]`);
      if (!node) continue;
      const at = Number(rx.at) || 0;
      if (at < Number(node.dataset.rxAt || 0)) continue;
      node.dataset.rxAt = at;
      for (const b of node.querySelectorAll(".react")) {
        const r = rx[b.dataset.emoji];
        if (!r || typeof r !== "object") continue;
        b.querySelector(".n").textContent = r.n > 0 ? r.n : "";
        b.classList.toggle("has", r.n > 0);
        if (r.me !== undefined) b.classList.toggle("on", r.me);
      }
    }
  }

  async function react(id, emoji, btn) {
    if (!me) return toast("Join first to react!");
    if (!id || btn.disabled) return;
    // optimistic flip; the server answer below is authoritative
    const was = btn.classList.contains("on");
    const n = Number(btn.querySelector(".n").textContent) || 0;
    btn.classList.toggle("on", !was);
    btn.querySelector(".n").textContent = Math.max(0, n + (was ? -1 : 1)) || "";
    btn.classList.remove("pop");
    void btn.offsetWidth;
    btn.classList.add("pop");
    btn.disabled = true;
    try {
      const { ok, data } = await api("/api/react", { id, emoji });
      if (ok) applyReactions({ [id]: data.reactions });
      else {
        btn.classList.toggle("on", was);
        btn.querySelector(".n").textContent = n || "";
        toast(data.error || "Couldn't react");
      }
    } catch {
      btn.classList.toggle("on", was);
      btn.querySelector(".n").textContent = n || "";
    } finally {
      btn.disabled = false;
    }
  }

  function renderFame(list) {
    el.fame.replaceChildren(
      ...(list || []).map((m) => {
        const li = document.createElement("li");
        li.innerHTML = `<span class="who"></span> <span class="what"></span> <span class="score"></span>`;
        li.querySelector(".who").textContent = `${m.emoji} ${m.name}:`;
        li.querySelector(".what").textContent = m.text.length > 70 ? m.text.slice(0, 70) + "…" : m.text;
        li.querySelector(".score").textContent = `(${m.niceness.toFixed(1)} 🥰)`;
        return li;
      })
    );
  }

  function renderPresence(p) {
    el.online.textContent = p.online;
    el.faces.textContent = p.people.slice(0, 12).map((x) => x.emoji).join("");
    el.faces.title = p.people.map((x) => `${x.emoji} ${x.name}`).join(", ");
  }

  function renderStats(s) {
    if (!s) return;
    el.sReq.textContent = s.requests;
    el.sBlocked.textContent = s.blocked;
    el.sLat.textContent = s.requests ? `${Math.round(s.total_latency_ms / s.requests)} ms` : "–";
    if (s.model) el.sModel.textContent = s.model;
    if (s.budget) {
      const pct = Math.round((s.budget.used / s.budget.max) * 100);
      el.sBudget.textContent = `${s.budget.used.toLocaleString()} / ${s.budget.max.toLocaleString()} (${pct}%)${s.budget.preview_paused ? " · preview paused" : ""}`;
    }
  }

  // ------------------------------------------------------------ typing → judge
  function setVerdict(v, { thinking = false } = {}) {
    el.verdict.classList.toggle("thinking", thinking);
    el.send.classList.remove("blocked", "pending");
    el.reasons.replaceChildren();
    if (thinking) {
      el.face.textContent = "🤔";
      el.vtext.textContent = "Jev is reading…";
      el.send.classList.add("pending");
      el.sendLabel.textContent = "Send";
      return;
    }
    if (!v || v.skipped) {
      el.face.textContent = "😶";
      el.meter.style.width = "0%";
      el.vtext.textContent = v?.preview_paused
        ? "Busy day! Jev is saving its energy for real messages — just hit send."
        : v?.skipped ? "Keep going — Jev scores drafts of 3+ words as you type." : "Jev checks every message for niceness before it lands.";
      el.sendLabel.textContent = "Send";
      el.sendEmoji.textContent = "💌";
      return;
    }
    if (v.error) {
      el.face.textContent = "😵";
      el.vtext.textContent = v.error;
      return;
    }
    const n = v.niceness ?? 3;
    el.face.textContent = FACES[Math.max(0, Math.min(4, Math.round(n) - 1))];
    el.meter.style.width = `${Math.round(((n - 1) / 4) * 100)}%`;
    if (v.allowed) {
      el.vtext.textContent = n >= 4.5 ? "Delightful! Send it!" : n >= 3.5 ? "Nice — that'll land well." : "Fine by Jev. Could be warmer, but it passes.";
      el.sendLabel.textContent = "Send";
      el.sendEmoji.textContent = n >= 4.5 ? "🥰" : "💌";
    } else {
      el.vtext.textContent = v.meanness >= 0.8 ? "Yikes. That's not going through." : "Hmm, Jev isn't feeling that one.";
      el.send.classList.add("blocked");
      el.sendLabel.textContent = "Nope";
      el.sendEmoji.textContent = "🙈";
      el.reasons.replaceChildren(...(v.reasons || []).map((r) => { const c = document.createElement("span"); c.className = "tip"; c.textContent = r; return c; }));
    }
  }

  function renderLive(v) {
    if (!v || v.skipped || !v.flags) {
      el.liveProbs.replaceChildren();
      el.liveMeta.textContent = "";
      el.liveHint.style.display = "";
      el.live.classList.add("empty");
      return;
    }
    el.liveHint.style.display = "none";
    el.live.classList.remove("empty");
    renderProbs(el.liveProbs, v);
    el.liveMeta.textContent = `${v.allowed ? "ALLOW" : "BLOCK"} · ${v.latency_ms} ms${v.cached ? " · cached" : ""}${v.hits?.length ? " · hits: " + v.hits.join(", ") : ""}`;
  }

  // Counter only appears in the last stretch before the limit, so it's not noise while chatting normally.
  function renderChars() {
    const max = el.draft.maxLength > 0 ? el.draft.maxLength : 280;
    const left = max - el.draft.value.length;
    el.chars.textContent = left <= 60 ? `${left}` : "";
    el.chars.classList.toggle("over", left <= 10);
  }

  async function judgeDraft() {
    const text = el.draft.value;
    seq++;
    judgeCtl?.abort();
    // Short drafts skip Jev, but one that could be an address still goes to the server's link check.
    if (words(text) < 3 && !/[./:@]/.test(text)) { latest = null; setVerdict(text.trim() ? { skipped: true } : null); renderLive(null); return; }
    const mySeq = seq;
    judgeCtl = new AbortController();
    setVerdict(null, { thinking: true });
    try {
      const { status, data } = await api("/api/judge", { draft: text }, judgeCtl.signal);
      if (mySeq !== seq) return;
      if (status === 400 || status === 429 || status === 503) { setVerdict({ error: data.error }); return; }
      if (status === 401) { el.modal.classList.remove("hidden"); return; }
      if (data.preview_paused) { latest = null; setVerdict(data); renderLive(null); renderStats(data.stats); return; }
      latest = { ...data, text: text.trim() };
      setVerdict(data);
      renderLive(data);
      renderStats(data.stats);
    } catch (e) {
      if (e.name !== "AbortError" && mySeq === seq) setVerdict({ error: "Couldn't reach Jev" });
    }
  }

  el.draft.addEventListener("input", () => {
    el.draft.style.height = "auto";
    el.draft.style.height = Math.min(el.draft.scrollHeight, 180) + "px";
    renderChars();
    clearTimeout(judgeTimer);
    judgeTimer = setTimeout(judgeDraft, 380);
  });
  // Enter sends with a keyboard; on touch devices it inserts a newline and the Send button sends.
  el.draft.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !COARSE.matches) { e.preventDefault(); el.composer.requestSubmit(); }
  });

  // ------------------------------------------------------------ wiggle
  // meanness 0..1 → amplitude 4–30px, rotation 1–12°, duration 0.45–1.1s, red flash 0.18–0.6 opacity
  // (+ full-screen quake when it's really mean). meanness 0 is an empty draft: nudge only, no flash.
  function flash(m) {
    const b = document.body;
    b.style.setProperty("--flash-a", (0.18 + m * 0.42).toFixed(2));
    b.style.setProperty("--flash-dur", `${(0.45 + m * 0.5).toFixed(2)}s`);
    b.classList.remove("flash");
    void b.offsetWidth;
    b.classList.add("flash");
    clearTimeout(flash.t);
    flash.t = setTimeout(() => b.classList.remove("flash"), 1000);
  }
  function wiggle(meanness = 0.3, target = el.send) {
    const m = Math.max(0, Math.min(1, meanness));
    if (m > 0) flash(m);
    target.style.setProperty("--amp", `${(4 + m * 26).toFixed(1)}px`);
    target.style.setProperty("--rot", `${(1 + m * 11).toFixed(1)}deg`);
    target.style.setProperty("--wiggle-dur", `${(0.45 + m * 0.65).toFixed(2)}s`);
    target.classList.remove("wiggle");
    void target.offsetWidth; // restart animation
    target.classList.add("wiggle");
    // drop the class when done, or it replays whenever the element is hidden and shown again (the join card)
    target.addEventListener("animationend", () => target.classList.remove("wiggle"), { once: true });
    if (m >= 0.85) {
      document.body.classList.remove("quake");
      void document.body.offsetWidth;
      document.body.classList.add("quake");
      setTimeout(() => document.body.classList.remove("quake"), 600);
    }
    if (navigator.vibrate) navigator.vibrate(m >= 0.85 ? [80, 40, 120] : 40);
  }

  // ------------------------------------------------------------ send
  el.composer.onsubmit = async (e) => {
    e.preventDefault();
    if (sending || !me) return;
    const text = el.draft.value.trim();
    if (!text) { wiggle(0); return; }
    if (latest && !latest.allowed && latest.text === text) { wiggle(latest.meanness); toast("Try saying it kindly 💕"); return; }
    sending = true;
    clearTimeout(judgeTimer);
    judgeCtl?.abort();
    seq++;
    setVerdict(null, { thinking: true });
    el.send.disabled = true;
    try {
      const { status, data } = await api("/api/send", { text });
      if (status === 401) { el.modal.classList.remove("hidden"); return; }
      if (status === 403 && data.blocked) {
        latest = { ...data, text };
        setVerdict(data);
        renderLive(data);
        renderStats(data.stats);
        wiggle(data.meanness);
        return;
      }
      if (!data.ok) { setVerdict({ error: data.error || "Something went sideways" }); wiggle(0.15); return; }
      el.draft.value = "";
      el.draft.style.height = "auto";
      renderChars();
      latest = null;
      setVerdict(null);
      renderLive(MOBILE.matches ? null : data); // the phone strip sits above the composer; the sent message carries its own badge
      renderStats(data.stats);
      if (transport === "poll") { addMessage(data.message, true); renderFame(data.fame); }
      scrollDown(true);
    } catch {
      setVerdict({ error: "Couldn't reach the server" });
      wiggle(0.15);
    } finally {
      sending = false;
      el.send.disabled = false;
      el.draft.focus();
    }
  };

  // ------------------------------------------------------------ phones
  // The live Jev read sits above the composer, the rail folds into a bottom sheet, and the page is sized
  // to the visual viewport so the composer stays above the on-screen keyboard (iOS pans the viewport
  // instead of resizing it; --vvt follows that pan).
  function placeLive() {
    if (MOBILE.matches) el.chat.insertBefore(el.live, el.composer);
    else el.rail.insertBefore(el.live, el.rail.querySelector(".fame"));
  }
  function openRail(on) {
    el.rail.classList.toggle("open", on);
    el.railBackdrop.classList.toggle("show", on);
    el.railToggle.setAttribute("aria-expanded", String(on));
  }
  el.railToggle.onclick = () => openRail(!el.rail.classList.contains("open"));
  el.railClose.onclick = () => openRail(false);
  el.railBackdrop.onclick = () => openRail(false);

  const vv = window.visualViewport;
  function fitViewport() {
    const root = document.documentElement.style;
    if (!MOBILE.matches) { root.removeProperty("--vvh"); root.removeProperty("--vvt"); return; }
    const stick = nearBottom();
    root.setProperty("--vvh", `${Math.round(vv ? vv.height : innerHeight)}px`);
    root.setProperty("--vvt", `${Math.round(vv ? vv.offsetTop : 0)}px`);
    if (stick) scrollDown(true);
  }
  (vv || window).addEventListener("resize", fitViewport);
  vv?.addEventListener("scroll", fitViewport);
  MOBILE.addEventListener("change", () => { placeLive(); openRail(false); fitViewport(); });
  placeLive();
  fitViewport();

  // ------------------------------------------------------------ debugger
  const params = new URLSearchParams(location.search);
  const debugOn = params.get("debug") === "1" || (params.get("debug") !== "0" && localStorage.getItem("nc_debug") === "1");
  function setDebug(on) {
    document.body.classList.toggle("debug", on);
    el.debug.checked = on;
    localStorage.setItem("nc_debug", on ? "1" : "0");
    document.title = on ? "[jev] nice-chat :: debugger" : "Nice Chat 💖 — the chat where only nice things get through";
  }
  el.debug.onchange = () => setDebug(el.debug.checked);
  setDebug(debugOn);
  document.addEventListener("keydown", (e) => {
    if (e.key === "`" && e.ctrlKey) setDebug(!document.body.classList.contains("debug"));
  });

  // ------------------------------------------------------------ boot
  // The join card stays hidden until the server has actually answered who we are: a cold start or a
  // flaky request must not look like "you have no account" to someone who already joined.
  async function whoami() {
    for (let attempt = 0; ; attempt++) {
      try {
        const { ok, status, data } = await api("/api/me");
        if (ok) return data;
        if (status < 500 || attempt >= 3) return data;
      } catch {
        if (attempt >= 3) return {};
      }
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }

  (async () => {
    const placeholder = el.draft.placeholder;
    el.draft.placeholder = "Connecting…";
    const data = await whoami();
    el.draft.placeholder = placeholder;
    if (data.transport === "poll") { transport = "poll"; pollMs = data.poll_ms || pollMs; }
    if (data.max_text > 0) el.draft.maxLength = data.max_text;
    connect();
    if (data.user) enter(data.user);
    else openJoin(false);
  })();
})();
