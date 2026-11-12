// Tempo: a school planner. Vanilla JS, no build step. Data lives in Firebase Firestore under each signed-in user.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, collection, doc, onSnapshot, setDoc, deleteDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// ---------- constants ----------
const CLASS_COLORS = ["#1f3a68", "#2f6b4f", "#7a2e2e", "#5a3f7a", "#8a5a00", "#1f6470", "#555555", "#7a4b2e"];
const CAT = { sat: "var(--coral)", comp: "var(--sun)", other: "var(--mint)" };
const TYPES = ["Homework", "Lab report", "Quiz / test", "Essay", "Project", "Reading"];
const ESTS = [[15, "15m"], [30, "30m"], [45, "45m"], [60, "1h"], [90, "1.5h"], [120, "2h"], [180, "3h+"]];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOWL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DEFAULT_META = { testDate: "2026-12-05", testTime: "07:45", registered: false, goal: null, satDaily: 45, hoursPerDay: 1.5 };

const S = {
  classes: [], tasks: [], events: [], comps: [], scores: [], sessions: [],
  meta: Object.assign({}, DEFAULT_META),
  view: "today", weekStart: null, selDay: null, sort: "oldest", classFilter: "all", taskFilter: "all", showDone: false
};
let db = null, memoryOnly = false;

// ---------- dates ----------
const pad = n => (n < 10 ? "0" : "") + n;
const key = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const parse = k => { const p = k.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); };
const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
const mondayOf = d => addDays(d, -((d.getDay() + 6) % 7));
const today = () => key(new Date());
const nowHM = () => { const d = new Date(); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
const dayDiff = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
const fmtTime = t => { if (!t) return ""; const p = t.split(":"); let h = +p[0]; const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return h + (p[1] === "00" ? "" : ":" + p[1]) + " " + ap; };
const shortDate = k => { const d = parse(k); return DOW[d.getDay()] + ", " + MON[d.getMonth()] + " " + d.getDate(); };
const fmtMin = m => m < 60 ? m + "m" : (Math.round(m / 6) / 10).toString().replace(/\.0$/, "") + "h";
S.weekStart = mondayOf(new Date()); S.selDay = today();

// ---------- DOM ----------
const $ = id => document.getElementById(id);
function h(tag, attrs, kids) {
  const e = document.createElement(tag);
  if (attrs) for (const a in attrs) {
    const v = attrs[a];
    if (v == null || v === false) continue;
    if (a === "text") e.textContent = v;
    else if (a === "html") e.innerHTML = v;
    else if (a === "style") e.setAttribute("style", v);
    else if (a.slice(0, 2) === "on") e.addEventListener(a.slice(2), v);
    else e.setAttribute(a, v === true ? "" : v);
  }
  (kids || []).forEach(k => { if (k != null && k !== false) e.appendChild(typeof k === "string" || typeof k === "number" ? document.createTextNode(String(k)) : k); });
  return e;
}
const CHECK_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
const PLAY_SVG = 'Timer';
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const strip = o => { const c = Object.assign({}, o); delete c.id; return c; };
const cls = id => S.classes.find(c => c.id === id) || null;
const comp = id => S.comps.find(c => c.id === id) || null;
function colorOf(t) {
  if (t.cat === "class") { const c = cls(t.classId); return c ? c.color : "var(--cobalt)"; }
  return CAT[t.cat] || CAT.other;
}
function showBanner(msg) { const b = $("banner"); b.textContent = msg || ""; b.hidden = !msg; }

// ---------- storage (Firebase Firestore, private per user) ----------
// Every document lives under users/{uid}/..., and firestore.rules lets only that user read or write it.
let uid = null, unsubs = [];
const userPath = (col, id) => "users/" + uid + "/" + col + (id ? "/" + id : "");
function put(col, id, body) {
  if (memoryOnly) {
    if (col === "meta") { S.meta = Object.assign({}, DEFAULT_META, body); render(); return Promise.resolve(); }
    const list = S[col], item = Object.assign({ id: id }, body), i = list.findIndex(x => x.id === id);
    if (i >= 0) list[i] = item; else list.push(item);
    render(); return Promise.resolve();
  }
  return setDoc(doc(db, userPath(col, id)), body);
}
function del(col, id) {
  if (memoryOnly) { S[col] = S[col].filter(x => x.id !== id); render(); return Promise.resolve(); }
  return deleteDoc(doc(db, userPath(col, id)));
}
async function putMany(items) {
  // items: [{ col, id, body }]; Firestore batches hold up to 500 writes.
  if (memoryOnly) { items.forEach(x => put(x.col, x.id, x.body)); return; }
  for (let i = 0; i < items.length; i += 400) {
    const batch = writeBatch(db);
    items.slice(i, i + 400).forEach(x => batch.set(doc(db, userPath(x.col, x.id)), x.body));
    await batch.commit();
  }
}
function saveMeta(patch) { S.meta = Object.assign({}, S.meta, patch); return put("meta", "settings", strip(S.meta)).catch(failed); }
function failed(e) {
  console.error(e);
  showBanner("That change didn't save. Check your connection and try again.");
}
const COLS = ["classes", "tasks", "events", "comps", "scores", "sessions"];
function subscribe() {
  const timer = setTimeout(() => showBanner("Can't reach your planner right now. Changes will sync when you're back online."), 10000);
  const ok = {};
  const onErr = e => { clearTimeout(timer); console.error(e); showBanner("Your planner couldn't load. Reload the page to try again."); };
  COLS.forEach(c => unsubs.push(onSnapshot(collection(db, userPath(c)), { includeMetadataChanges: false }, snap => {
    S[c] = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
    if (!snap.metadata.fromCache) { ok[c] = true; if (COLS.every(x => ok[x])) { clearTimeout(timer); showBanner(""); } }
    render();
  }, onErr)));
  unsubs.push(onSnapshot(doc(db, userPath("meta", "settings")), s => { S.meta = Object.assign({}, DEFAULT_META, s.exists() ? s.data() : {}); render(); }, onErr));
}
function resetState() {
  unsubs.forEach(u => u()); unsubs = [];
  COLS.forEach(c => { S[c] = []; }); S.meta = Object.assign({}, DEFAULT_META);
}
let auth = null, user = null;
function connect() {
  if (!firebaseConfig || !firebaseConfig.apiKey || firebaseConfig.apiKey.indexOf("PASTE") === 0) {
    memoryOnly = true; showApp(true);
    showBanner("Demo mode: add your Firebase config in firebase-config.js to sign in and save.");
    render(); return;
  }
  const app = initializeApp(firebaseConfig);
  db = initializeFirestore(app, { localCache: persistentLocalCache() });
  auth = getAuth(app);
  getRedirectResult(auth).catch(e => console.error(e));
  onAuthStateChanged(auth, u => {
    resetState(); user = u; uid = u ? u.uid : null;
    showApp(!!u);
    if (u) subscribe();
    render();
  });
}
async function signIn() {
  const provider = new GoogleAuthProvider();
  $("signinErr").hidden = true;
  try { await signInWithPopup(auth, provider); }
  catch (e) {
    if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) return signInWithRedirect(auth, provider);
    if (e && e.code === "auth/popup-closed-by-user") return;
    $("signinErr").textContent = "Sign-in didn't work. Try again."; $("signinErr").hidden = false; console.error(e);
  }
}
function showApp(on) {
  $("signin").hidden = on;
  document.querySelectorAll("[data-app]").forEach(el => { el.hidden = !on; });
}

// ---------- Canvas calendar import (.ics) ----------
function parseICS(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const events = []; let cur = null;
  lines.forEach(line => {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT") { if (cur) events.push(cur); cur = null; }
    else if (cur) {
      const i = line.indexOf(":"); if (i < 0) return;
      const name = line.slice(0, i).split(";")[0], val = line.slice(i + 1);
      if (!(name in cur)) cur[name] = val.replace(/\\,/g, ",").replace(/\;/g, ";").replace(/\\n/gi, " ");
    }
  });
  return events;
}
function icsDate(v) {
  if (/^\d{8}$/.test(v)) return { date: v.slice(0, 4) + "-" + v.slice(4, 6) + "-" + v.slice(6, 8), time: null };
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/); if (!m) return null;
  const d = m[7] ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])) : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const t = pad(d.getHours()) + ":" + pad(d.getMinutes());
  return { date: key(d), time: t === "23:59" ? null : t };
}
function guessType(title) {
  if (/lab/i.test(title)) return ["Lab report", 120];
  if (/read/i.test(title)) return ["Reading", 45];
  if (/quiz|test|exam|midterm|final/i.test(title)) return ["Quiz / test", 60];
  if (/essay|paper/i.test(title)) return ["Essay", 120];
  if (/project/i.test(title)) return ["Project", 120];
  return ["Homework", 90];
}
async function importCanvas(text) {
  const evs = parseICS(text).filter(e => /assignment/.test(e.UID || "") && e.SUMMARY && e.DTSTART);
  const writes = [], classByCode = {};
  S.classes.forEach(c => { if (c.canvasCode) classByCode[c.canvasCode] = c; });
  let added = 0, updated = 0, skipped = 0;
  evs.forEach(e => {
    const m = e.SUMMARY.match(/^(.*)\s\[([^\]]+)\]\s*$/);
    const code = m ? m[2].trim() : null;
    if (code && /sandbox/i.test(code)) { skipped++; return; }
    let title = (m ? m[1] : e.SUMMARY).replace(/\s*\(\d{4}[A-Z]{2}\s.*\)\s*$/, "").replace(/^Lab(\d)/i, "Lab $1").trim();
    const when = icsDate(e.DTSTART); if (!when) { skipped++; return; }
    let classId = null;
    if (code) {
      let c = classByCode[code];
      if (!c) {
        const short = code.replace(/^\d{4}[A-Z]{2}\s+/, "").replace(/-\d+$/, "").replace("-", " ");
        const used = S.classes.map(x => x.color).concat(Object.values(classByCode).map(x => x.color));
        c = { id: "canvas-" + code.replace(/^\d{4}[A-Z]{2}\s+/, "").replace(/[^A-Za-z0-9-]/g, ""), name: short, color: CLASS_COLORS.find(x => used.indexOf(x) < 0) || CLASS_COLORS[0], canvasCode: code };
        classByCode[code] = c;
        writes.push({ col: "classes", id: c.id, body: strip(c) });
      }
      classId = c.id;
    }
    const id = "canvas-" + e.UID.replace("event-assignment-override-", "o").replace("event-assignment-", "").replace(/[^A-Za-z0-9-]/g, "");
    const old = S.tasks.find(t => t.id === id);
    const tg = guessType(title);
    if (old) {
      if (old.date === when.date && old.time === when.time && old.title === title) return;
      writes.push({ col: "tasks", id, body: Object.assign(strip(old), { title, date: when.date, time: when.time }) }); updated++;
    } else {
      writes.push({ col: "tasks", id, body: { title, cat: "class", classId, type: tg[0], date: when.date, time: when.time, est: tg[1], done: false, doneAt: null, spent: 0, created: Date.now(), source: "canvas", canvasUid: e.UID } }); added++;
    }
  });
  await putMany(writes);
  return { added, updated, skipped };
}

// ---------- backup ----------
function exportBackup() {
  const data = { app: "tempo", version: 1, exportedAt: new Date().toISOString(), meta: strip(S.meta) };
  COLS.forEach(c => { data[c] = S[c]; });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "tempo-backup-" + today() + ".json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function importBackup(text) {
  const data = JSON.parse(text);
  if (!data || data.app !== "tempo") throw new Error("Not a Tempo backup");
  const writes = [];
  COLS.forEach(c => (data[c] || []).forEach(x => { if (x && x.id) writes.push({ col: c, id: String(x.id), body: strip(x) }); }));
  if (data.meta) writes.push({ col: "meta", id: "settings", body: Object.assign({}, DEFAULT_META, data.meta) });
  await putMany(writes);
  return writes.length;
}
function pickFile(accept, cb) {
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = accept;
  inp.addEventListener("change", () => { const f = inp.files && inp.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => cb(String(r.result)); r.readAsText(f); });
  inp.click();
}
function settingsSheet() {
  openSheet(s => {
    s.appendChild(h("div", { class: "sheet-head" }, [h("h2", { text: "Settings" }), h("button", { class: "linkish", type: "button", onclick: closeSheet }, ["Done"])]));
    const msg = h("p", { class: "small-note", style: "margin:0" });
    const row = (title, sub, fn) => h("button", { class: "arow", type: "button", onclick: fn }, [h("span", { class: "atext" }, [h("span", { class: "ttl", text: title }), h("span", { class: "tmeta", text: sub })]), h("span", { class: "chev", "aria-hidden": "true", text: "›" })]);
    s.appendChild(h("div", { class: "group" }, [
      row("Import from Canvas", "Calendar → Calendar Feed, download the .ics file, then pick it here", () => pickFile(".ics,text/calendar", async t => {
        try { const r = await importCanvas(t); msg.textContent = "Canvas: " + r.added + " added, " + r.updated + " updated" + (r.skipped ? ", " + r.skipped + " skipped" : "") + "."; }
        catch (e) { console.error(e); msg.textContent = "That file couldn't be read. Make sure it's the .ics file from Canvas."; }
      })),
      row("Manage classes", "Rename or recolor", classesSheet)
    ]));
    s.appendChild(h("div", { class: "group" }, [
      row("Export backup", "Download everything as a .json file", exportBackup),
      row("Import backup", "Restore from a Tempo .json file", () => pickFile(".json,application/json", async t => {
        try { const n = await importBackup(t); msg.textContent = n + " items restored."; }
        catch (e) { console.error(e); msg.textContent = "That file isn't a Tempo backup."; }
      }))
    ]));
    s.appendChild(msg);
    if (user) s.appendChild(h("div", { class: "group" }, [row("Sign out", user.email || "", () => { closeSheet(); signOut(auth); })]));
  });
}

// ---------- derived ----------
const est = t => t.est || 60;
function isLate(t) {
  if (t.done || !t.date) return false;
  const tk = today();
  return t.date < tk || (t.date === tk && t.time && t.time < nowHM());
}
const openTasks = () => S.tasks.filter(t => !t.done);
const lateTasks = () => openTasks().filter(isLate);
function dueLabel(t) {
  if (!t.date) return "No date";
  const tk = today(), dd = dayDiff(tk, t.date);
  if (isLate(t)) return dd === 0 ? "Due earlier today" : (-dd) + (dd === -1 ? " day late" : " days late");
  if (dd === 0) return "Today" + (t.time ? " " + fmtTime(t.time) : "");
  if (dd === 1) return "Tomorrow" + (t.time ? " " + fmtTime(t.time) : "");
  if (dd < 7) return DOWL[parse(t.date).getDay()] + (t.time ? " " + fmtTime(t.time) : "");
  return shortDate(t.date);
}
function satTarget() {
  const d = parse(S.meta.testDate || DEFAULT_META.testDate), p = (S.meta.testTime || "07:45").split(":");
  d.setHours(+p[0], +p[1], 0, 0); return d;
}
function countdown() {
  let ms = satTarget() - new Date(); if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return { d: Math.floor(s / 86400), h: Math.floor(s % 86400 / 3600), m: Math.floor(s % 3600 / 60), s: s % 60, past: ms === 0 };
}
const minutesOn = (k, cat) => S.sessions.filter(s => s.date === k && (!cat || s.cat === cat)).reduce((a, s) => a + (s.minutes || 0), 0);
function pickNext(n) {
  const tk = today();
  const late = lateTasks().sort((a, b) => a.date.localeCompare(b.date) || est(a) - est(b));
  const due = openTasks().filter(t => !isLate(t) && t.date).sort((a, b) => a.date.localeCompare(b.date) || (a.time || "99").localeCompare(b.time || "99"));
  const undated = openTasks().filter(t => !t.date);
  return late.concat(due, undated).slice(0, n);
}

// ---------- small components ----------
function ring(size, pct, cls2) {
  const r = size / 2 - 7, c = 2 * Math.PI * r, off = c * (1 - Math.max(0, Math.min(1, pct)));
  return h("span", { class: "ring " + (cls2 || ""), style: "display:inline-flex", html: '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
    '<circle class="track" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '"/>' +
    '<circle class="val" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '" transform="rotate(-90 ' + size / 2 + ' ' + size / 2 + ')"/></svg>' });
}
function secTitle(title, sub, btn) {
  return h("div", { class: "sec-title" }, [h("div", null, [h("h2", { text: title }), sub ? h("div", { class: "sub", text: sub }) : null]), btn || null]);
}
function taskRow(t) {
  const late = isLate(t), c = colorOf(t), meta = [];
  if (t.cat === "class") { const k = cls(t.classId); if (k) meta.push(h("span", { class: "pill", style: "color:" + k.color, text: k.name })); }
  else if (t.cat === "sat") meta.push(h("span", { class: "pill", style: "color:var(--coral)", text: "SAT" }));
  else if (t.cat === "comp") { const k = comp(t.compId); meta.push(h("span", { class: "pill", style: "color:var(--ink)", text: k ? k.name : "Comp" })); }
  if (t.type) meta.push(h("span", { text: t.type }));
  meta.push(late ? h("span", { class: "pill late", text: dueLabel(t) }) : h("span", { text: dueLabel(t) }));
  if (t.spent) meta.push(h("span", { text: fmtMin(t.spent) + " done" }));
  const chk = h("button", { class: "check", type: "button", "aria-pressed": t.done ? "true" : "false", "aria-label": (t.done ? "Mark not done: " : "Mark done: ") + t.title, html: CHECK_SVG });
  chk.addEventListener("click", ev => toggleDone(t, ev));
  return h("div", { class: "trow" + (late ? " late" : "") + (t.done ? " done" : ""), style: "--c:" + c }, [
    chk,
    h("button", { class: "tbody", type: "button", onclick: () => taskSheet(t) }, [h("div", { class: "ttl", text: t.title }), h("div", { class: "tmeta" }, meta)]),
    h("div", { class: "tside" }, [
      h("span", { class: "est", text: fmtMin(est(t)) }),
      t.done ? null : h("button", { class: "play", type: "button", "aria-label": "Start focus timer for " + t.title, html: PLAY_SVG, onclick: () => startFocus({ task: t }) })
    ])
  ]);
}

// ---------- complete / undo ----------
function toggleDone(t, ev) {
  const nowDone = !t.done, body = strip(t);
  body.done = nowDone; body.doneAt = nowDone ? Date.now() : null;
  if (nowDone) {
    toast("Cleared: " + t.title, "Undo", () => { const b = strip(t); b.done = false; b.doneAt = null; put("tasks", t.id, b).catch(failed); });
  }
  put("tasks", t.id, body).catch(failed);
}
let toastT = null;
function toast(msg, btnLabel, fn) {
  $("toastMsg").textContent = msg;
  const b = $("toastBtn"); b.hidden = !fn; b.textContent = btnLabel || "";
  b.onclick = () => { $("toast").hidden = true; fn && fn(); };
  $("toast").hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { $("toast").hidden = true; }, 4500);
}
// ---------- render ----------
const LEGACY = (() => { const m = {}, n = CLASS_COLORS; ["#007aff", "#5856d6", "#30b0c7", "#ff2d55", "#ff9500", "#34c759", "#8e8e93", "#a2845e"].forEach((c, i) => m[c] = n[i]); ["#2b50ff", "#8b5cf6", "#0ea5a4", "#ec4899", "#f97316", "#16a34a", "#64748b", "#0891b2"].forEach((c, i) => m[c] = n[i]); return m; })();
function render() {
  S.classes.forEach(c => { if (LEGACY[c.color]) c.color = LEGACY[c.color]; });
  const d = new Date();
  $("topDate").textContent = DOWL[d.getDay()] + ", " + MON[d.getMonth()] + " " + d.getDate();
  $("pageTitle").textContent = { today: "Today", tasks: "Tasks", goals: "Goals", week: "Calendar" }[S.view];
  document.querySelectorAll("nav.tabs button").forEach(b => { if (b.dataset.v === S.view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  const v = $("view"); v.textContent = "";
  ({ today: viewToday, tasks: viewTasks, goals: viewGoals, week: viewWeek })[S.view](v);
  tick();
}
function go(view) { const alias = { catchup: "tasks", sat: "goals", comps: "goals" }; S.view = alias[view] || view; render(); window.scrollTo(0, 0); }

// TODAY
function viewToday(v) {
  const tk = today(), late = lateTasks(), cd = countdown();
  const dueToday = openTasks().filter(t => t.date === tk && !isLate(t)).length;
  const sum = h("div", { class: "summary" });
  if (S.meta.testDate) sum.appendChild(h("button", { class: "sumchip", type: "button", style: "--c:var(--coral)", onclick: () => go("goals") }, [h("b", { "data-cd": "d", text: String(cd.d) }), cd.d === 1 ? " day to SAT" : " days to SAT"]));
  if (late.length) sum.appendChild(h("button", { class: "sumchip", type: "button", style: "--c:var(--late)", onclick: () => { S.taskFilter = "overdue"; go("tasks"); } }, [h("b", { text: String(late.length) }), " overdue"]));
  sum.appendChild(h("button", { class: "sumchip", type: "button", style: "--c:var(--cobalt)", onclick: () => { S.taskFilter = "all"; go("tasks"); } }, [h("b", { text: String(dueToday) }), " due today"]));
  v.appendChild(sum);

  if (!S.tasks.length && !S.classes.length && !S.comps.length && !S.events.length) { v.appendChild(onboarding()); return; }

  const picks = pickNext(3);
  v.appendChild(secTitle("Up next", null, openTasks().length > 3 ? h("button", { class: "linkish", type: "button", onclick: () => { S.taskFilter = "all"; go("tasks"); } }, ["See all"]) : null));
  if (!picks.length) v.appendChild(h("div", { class: "stick empty", text: "Nothing left to do. Tap + to add a task." }));
  else { const l = h("div", { class: "list" }); picks.forEach(t => l.appendChild(taskRow(t))); v.appendChild(l); }

  const items = S.events.filter(e => e.date === tk).map(e => ({ t: e.start || "", e }))
    .concat(S.comps.filter(c => c.date === tk).map(c => ({ t: c.time || "", c })))
    .sort((a, b) => (a.t || "99").localeCompare(b.t || "99"));
  v.appendChild(secTitle("Schedule", null, h("button", { class: "linkish", type: "button", onclick: () => go("week") }, ["Calendar"])));
  const tl = h("div", { class: "stick tl-wrap" });
  if (!items.length) tl.appendChild(h("div", { class: "empty", text: "Nothing scheduled today." }));
  else { const l = h("div", { class: "tl" }); items.forEach(x => l.appendChild(tlItem(x))); tl.appendChild(l); }
  v.appendChild(tl);
}
function tlItem(x) {
  if (x.c) return h("button", { class: "tl-item", type: "button", style: "--c:var(--sun)", onclick: () => compSheet(x.c) }, [h("div", { class: "tl-time", text: x.c.time ? fmtTime(x.c.time) : "All day" }), h("div", { class: "tl-body" }, [h("div", { class: "ttl", text: x.c.name }), h("div", { class: "tmeta", text: x.c.location || "Competition day" })])]);
  const e = x.e, c = e.cat === "class" ? (cls(e.classId) || {}).color || "var(--cobalt)" : CAT[e.cat] || CAT.other;
  return h("button", { class: "tl-item", type: "button", style: "--c:" + c, onclick: () => eventSheet(e) }, [
    h("div", { class: "tl-time", text: e.start ? fmtTime(e.start) : "All day" }),
    h("div", { class: "tl-body" }, [h("div", { class: "ttl", text: e.title }), h("div", { class: "tmeta", text: [e.end ? "until " + fmtTime(e.end) : null, e.notes].filter(Boolean).join(" · ") })])
  ]);
}
function onboarding() {
  const step = (n, c, title, sub, btn) => h("div", { class: "step", style: "--c:" + c }, [h("div", { class: "n", text: String(n) }), h("p", null, [title, h("small", { text: sub })]), btn]);
  return h("div", { class: "stick onboard pop" }, [
    h("h2", { text: "Getting started" }),
    h("div", { class: "steps" }, [
      step(1, "var(--lilac)", "Add your classes", "Use the same names as on Canvas.", h("button", { class: "btn small", type: "button", onclick: classesSheet }, ["Add"])),
      step(2, "var(--coral)", "Add your assignments", "Go through Canvas one class at a time. Start with anything late.", h("button", { class: "btn small", type: "button", onclick: () => taskSheet(null, { cat: "class" }) }, ["Add"])),
      step(3, "var(--sun)", "Add your competitions", "Add the date, then the prep for each one.", h("button", { class: "btn small", type: "button", onclick: () => compSheet(null) }, ["Add"]))
    ])
  ]);
}

function chart(sc) {
  const W = 600, H = 170, P = 26;
  const totals = sc.map(s => s.math + s.rw), goal = S.meta.goal;
  const lo = Math.max(400, Math.floor((Math.min(...totals, goal || 1600) - 60) / 50) * 50);
  const hi = Math.min(1600, Math.ceil((Math.max(...totals, goal || 0) + 40) / 50) * 50);
  const x = i => sc.length === 1 ? W / 2 : P + i * (W - 2 * P) / (sc.length - 1);
  const y = t => H - P - (t - lo) / Math.max(1, hi - lo) * (H - 2 * P);
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Practice test total scores over time">';
  s += '<line x1="' + P + '" x2="' + (W - P) + '" y1="' + y(lo) + '" y2="' + y(lo) + '" stroke="var(--line)" stroke-width="2"/>';
  s += '<text x="' + P + '" y="' + (y(hi) - 6) + '" font-size="13" font-weight="700" fill="var(--muted)">' + hi + '</text>';
  s += '<text x="' + P + '" y="' + (y(lo) + 18) + '" font-size="13" font-weight="700" fill="var(--muted)">' + lo + '</text>';
  if (goal) s += '<line x1="' + P + '" x2="' + (W - P) + '" y1="' + y(goal) + '" y2="' + y(goal) + '" stroke="var(--coral)" stroke-width="2.5" stroke-dasharray="8 6"/><text x="' + (W - P) + '" y="' + (y(goal) - 7) + '" text-anchor="end" font-size="13" font-weight="800" fill="var(--coral)">Goal ' + goal + '</text>';
  const pts = totals.map((t, i) => x(i).toFixed(1) + "," + y(t).toFixed(1)).join(" ");
  if (sc.length > 1) s += '<polyline points="' + pts + '" fill="none" stroke="var(--coral)" stroke-width="3" stroke-linejoin="round"/>';
  totals.forEach((t, i) => { const last = i === totals.length - 1; s += '<circle cx="' + x(i) + '" cy="' + y(t) + '" r="' + (last ? 8 : 5) + '" fill="' + (last ? "var(--coral)" : "var(--surface)") + '" stroke="var(--coral)" stroke-width="2.5"/>'; if (last) s += '<text x="' + Math.min(x(i), W - P - 10) + '" y="' + (y(t) - 14) + '" text-anchor="middle" font-size="15" font-weight="800" fill="var(--ink)">' + t + '</text>'; });
  s += "</svg>";
  return h("div", { html: s });
}

function compCard(c, past) {
  const tasks = S.tasks.filter(t => t.cat === "comp" && t.compId === c.id).sort((a, b) => a.done - b.done || (a.date || "~").localeCompare(b.date || "~"));
  const done = tasks.filter(t => t.done).length, dd = c.date ? dayDiff(today(), c.date) : null;
  const body = h("div", { class: "comp-body" });
  if (tasks.length) {
    body.appendChild(h("div", { class: "small-note", style: "font-weight:700", text: "Prep " + done + " / " + tasks.length }));
    body.appendChild(h("div", { class: "bar" }, [h("span", { style: "width:" + Math.round(done / tasks.length * 100) + "%" })]));
    tasks.forEach(t => body.appendChild(taskRow(t)));
  }
  if (!past) body.appendChild(h("div", { class: "actions" }, [h("button", { class: "btn small", type: "button", onclick: () => taskSheet(null, { cat: "comp", compId: c.id }) }, ["+ Prep task"])]));
  return h("div", { class: "stick comp" + (past ? "" : " pop"), style: past ? "opacity:0.7" : "" }, [
    h("button", { class: "comp-head", type: "button", style: "width:100%;border-left:0;border-right:0;border-top:0;text-align:left", onclick: () => compSheet(c) }, [
      h("div", null, [h("h3", { text: c.name }), h("div", { class: "small-note", text: [c.date ? shortDate(c.date) : "Date TBD", c.time ? fmtTime(c.time) : null, c.location].filter(Boolean).join(" · ") })]),
      dd == null ? null : h("div", { class: "comp-in" }, past ? [h("span", { class: "small-note", text: "Done" })] : [h("b", { text: dd === 0 ? "Today" : String(dd) }), dd === 0 ? null : h("span", { class: "small-note", text: dd === 1 ? "day left" : "days left" })])
    ]),
    body
  ]);
}

// WEEK
function evColor(e) { return e.cat === "class" ? ((cls(e.classId) || {}).color || "var(--cobalt)") : CAT[e.cat] || CAT.other; }
function dayItems(k) {
  const ev = S.events.filter(e => e.date === k).map(e => ({ kind: "event", t: e.start || "", title: e.title, c: evColor(e), ref: e }));
  const cp = S.comps.filter(c => c.date === k).map(c => ({ kind: "comp", t: c.time || "", title: c.name, c: "var(--sun)", ref: c }));
  const tk = S.tasks.filter(t => t.date === k && !t.done).map(t => ({ kind: "task", t: t.time || "99", title: t.title, c: colorOf(t), ref: t, late: isLate(t) }));
  return ev.concat(cp).sort((a, b) => (a.t || "00").localeCompare(b.t || "00")).concat(tk);
}
function openItem(x) { if (x.kind === "event") eventSheet(x.ref); else if (x.kind === "comp") compSheet(x.ref); else taskSheet(x.ref); }

function viewWeek(v) {
  const tk = today();
  if (!S.calMode) S.calMode = "month";
  if (!S.monthStart) { const n = new Date(); S.monthStart = new Date(n.getFullYear(), n.getMonth(), 1); }
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Calendar view", style: "max-width:none;width:100%;margin-top:14px" });
  [["month", "Month"], ["week", "Week"]].forEach(o => seg.appendChild(h("button", { type: "button", "aria-pressed": S.calMode === o[0] ? "true" : "false", onclick: () => { S.calMode = o[0]; const sd = parse(S.selDay); S.weekStart = mondayOf(sd); S.monthStart = new Date(sd.getFullYear(), sd.getMonth(), 1); render(); } }, [o[1]])));
  v.appendChild(seg);
  if (S.calMode === "month") viewMonth(v, tk); else viewTimeGrid(v, tk);
}

function calNav(v, label, prev, next, isCurrent, toCurrent) {
  v.appendChild(h("div", { class: "weeknav" }, [
    h("button", { class: "round", type: "button", "aria-label": "Previous", onclick: prev }, ["‹"]),
    h("div", { style: "text-align:center" }, [h("h2", { text: label }), isCurrent ? null : h("button", { class: "linkish", type: "button", onclick: toCurrent }, ["Today"])]),
    h("button", { class: "round", type: "button", "aria-label": "Next", onclick: next }, ["›"])
  ]));
}

function viewMonth(v, tk) {
  const ms = S.monthStart, y = ms.getFullYear(), m = ms.getMonth();
  const now = new Date();
  calNav(v, ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m] + " " + y,
    () => { S.monthStart = new Date(y, m - 1, 1); render(); }, () => { S.monthStart = new Date(y, m + 1, 1); render(); },
    y === now.getFullYear() && m === now.getMonth(), () => { S.monthStart = new Date(now.getFullYear(), now.getMonth(), 1); S.selDay = tk; render(); });
  const grid = h("div", { class: "month", role: "grid" });
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach(d => grid.appendChild(h("div", { class: "mhead", text: d })));
  const first = mondayOf(ms);
  const lastOfMonth = new Date(y, m + 1, 0);
  const weeks = Math.ceil((dayDiff(key(first), key(lastOfMonth)) + 1) / 7);
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(first, i), k = key(d), items = dayItems(k);
    const cell = h("button", { class: "mcell" + (d.getMonth() !== m ? " out" : "") + (k === tk ? " today" : "") + (k === S.selDay ? " sel" : ""), type: "button", "aria-label": shortDate(k) + ", " + items.length + " items", onclick: () => { S.selDay = k; render(); } }, [
      h("span", { class: "mnum", text: String(d.getDate()) })
    ]);
    items.slice(0, 3).forEach(x => cell.appendChild(h("span", { class: "mev" + (x.kind === "task" ? " task" : "") + (x.late ? " late" : ""), style: "--c:" + x.c, text: x.title })));
    if (items.length > 3) cell.appendChild(h("span", { class: "more", text: "+" + (items.length - 3) }));
    grid.appendChild(cell);
  }
  v.appendChild(grid);
  dayDetail(v, S.selDay, tk);
}

function dayDetail(v, k, tk) {
  const items = dayItems(k);
  v.appendChild(secTitle(k === tk ? "Today" : shortDate(k), items.length ? null : "Nothing scheduled", h("div", { class: "actions" }, [
    h("button", { class: "btn small", type: "button", onclick: () => eventSheet(null, { date: k }) }, ["+ Event"]),
    h("button", { class: "btn small", type: "button", onclick: () => taskSheet(null, { cat: "class", date: k }) }, ["+ Due"])
  ])));
  const sched = items.filter(x => x.kind !== "task");
  if (sched.length) { const tl = h("div", { class: "stick tl-wrap" }), l = h("div", { class: "tl" }); sched.forEach(x => l.appendChild(tlItem(x.kind === "comp" ? { c: x.ref } : { e: x.ref }))); tl.appendChild(l); v.appendChild(tl); }
  const tasks = S.tasks.filter(t => t.date === k).sort((a, b) => a.done - b.done);
  if (tasks.length) { v.appendChild(h("div", { style: "height:10px" })); const l = h("div", { class: "list" }); tasks.forEach(t => l.appendChild(taskRow(t))); v.appendChild(l); }
}

function viewTimeGrid(v, tk) {
  const ws = S.weekStart, we = addDays(ws, 6);
  calNav(v, MON[ws.getMonth()] + " " + ws.getDate() + " – " + (ws.getMonth() === we.getMonth() ? "" : MON[we.getMonth()] + " ") + we.getDate(),
    () => { S.weekStart = addDays(ws, -7); render(); }, () => { S.weekStart = addDays(ws, 7); render(); },
    key(ws) === key(mondayOf(new Date())), () => { S.weekStart = mondayOf(new Date()); S.selDay = tk; render(); });
  const keys = []; for (let i = 0; i < 7; i++) keys.push(key(addDays(ws, i)));
  const timed = S.events.filter(e => keys.indexOf(e.date) >= 0 && e.start).map(e => ({ k: e.date, s: e.start, e2: e.end, title: e.title, c: evColor(e), kind: "event", ref: e }))
    .concat(S.comps.filter(c => keys.indexOf(c.date) >= 0 && c.time).map(c => ({ k: c.date, s: c.time, e2: null, title: c.name, c: "var(--sun)", kind: "comp", ref: c })));
  const toH = t => { const p = t.split(":"); return +p[0] + (+p[1]) / 60; };
  let h0 = 7, h1 = 22;
  timed.forEach(x => { h0 = Math.min(h0, Math.floor(toH(x.s))); const e = x.e2 && toH(x.e2) > toH(x.s) ? toH(x.e2) : toH(x.s) + 1; h1 = Math.max(h1, Math.ceil(e)); });
  h1 = Math.min(24, h1);
  const HH = 46;
  const wrap = h("div", { class: "tg stick" });
  // header
  const head = h("div", { class: "tg-row tg-head" }, [h("div", { class: "tg-gut" })]);
  keys.forEach(k => { const d = parse(k); head.appendChild(h("button", { class: "tg-day" + (k === tk ? " today" : ""), type: "button", onclick: () => { S.selDay = k; S.calMode = "month"; S.monthStart = new Date(d.getFullYear(), d.getMonth(), 1); render(); } }, [h("span", { class: "dw", text: DOW[d.getDay()] }), h("span", { class: "dn", text: String(d.getDate()) })])); });
  wrap.appendChild(head);
  // all-day row
  const allDay = h("div", { class: "tg-row tg-all" }, [h("div", { class: "tg-gut", text: "due" })]);
  keys.forEach(k => {
    const col = h("div", { class: "tg-allcol" });
    S.tasks.filter(t => t.date === k && !t.done).concat(S.comps.filter(c => c.date === k && !c.time).map(c => ({ __comp: c }))).slice(0, 3).forEach(t => {
      if (t.__comp) col.appendChild(h("button", { class: "mev", type: "button", style: "--c:var(--sun)", text: t.__comp.name, onclick: () => compSheet(t.__comp) }));
      else col.appendChild(h("button", { class: "mev task" + (isLate(t) ? " late" : ""), type: "button", style: "--c:" + colorOf(t), text: t.title, onclick: () => taskSheet(t) }));
    });
    allDay.appendChild(col);
  });
  wrap.appendChild(allDay);
  // body
  const body = h("div", { class: "tg-body", style: "height:" + (h1 - h0) * HH + "px" });
  const gut = h("div", { class: "tg-gut tg-hours" });
  for (let hr = h0; hr < h1; hr++) gut.appendChild(h("div", { class: "tg-hr", style: "top:" + (hr - h0) * HH + "px", text: hr === 12 ? "Noon" : (hr % 12 || 12) + (hr < 12 ? " AM" : " PM") }));
  body.appendChild(gut);
  const nowD = new Date(), nowH = nowD.getHours() + nowD.getMinutes() / 60;
  keys.forEach(k => {
    const col = h("div", { class: "tg-col" + (k === tk ? " today" : "") });
    for (let hr = h0; hr < h1; hr++) {
      const slot = h("button", { class: "tg-slot", type: "button", style: "top:" + (hr - h0) * HH + "px;height:" + HH + "px", "aria-label": "Add event " + shortDate(k) + " " + hr + ":00", onclick: () => eventSheet(null, { date: k, start: pad(hr) + ":00", end: pad(Math.min(23, hr + 1)) + ":00" }) });
      col.appendChild(slot);
    }
    timed.filter(x => x.k === k).forEach(x => {
      const s = toH(x.s), e = x.e2 && toH(x.e2) > s ? toH(x.e2) : s + 1;
      col.appendChild(h("button", { class: "tg-ev", type: "button", style: "--c:" + x.c + ";top:" + ((s - h0) * HH + 1) + "px;height:" + Math.max(22, (e - s) * HH - 2) + "px", onclick: () => openItem(x) }, [h("b", { text: x.title }), h("span", { text: fmtTime(x.s) })]));
    });
    if (k === tk && nowH >= h0 && nowH <= h1) col.appendChild(h("div", { class: "tg-now", style: "top:" + (nowH - h0) * HH + "px" }));
    body.appendChild(col);
  });
  wrap.appendChild(body);
  v.appendChild(wrap);
  v.appendChild(h("p", { class: "small-note", style: "margin:8px 4px 0", text: "Tap an empty slot to add an event there. Tap a day to see it in Month view." }));
}

// TASKS
function viewTasks(v) {
  const tk = today(), late = lateTasks(), f = S.taskFilter || "all";
  const opts = [["all", "All", null], ["overdue", "Overdue" + (late.length ? " " + late.length : ""), "var(--late)"]]
    .concat(S.classes.slice().sort((a, b) => a.name.localeCompare(b.name)).map(c => [c.id, c.name, c.color]))
    .concat([["sat", "SAT", "var(--coral)"], ["comp", "Comps", "var(--sun)"], ["other", "Personal", "var(--mint)"]]);
  const ch = h("div", { class: "chips", style: "margin-top:14px" });
  opts.forEach(o => ch.appendChild(h("button", { class: "chip", type: "button", style: o[2] ? "--c:" + o[2] : null, "aria-pressed": f === o[0] ? "true" : "false", onclick: () => { S.taskFilter = o[0]; render(); } }, [o[1]])));
  ch.appendChild(h("button", { class: "linkish", type: "button", style: "font-size:0.85rem", onclick: classesSheet }, ["Edit classes"]));
  v.appendChild(ch);

  const match = t => f === "all" ? true : f === "overdue" ? isLate(t) : ["sat", "comp", "other"].indexOf(f) >= 0 ? t.cat === f : t.classId === f;
  const all = S.tasks.filter(match), open = all.filter(t => !t.done);

  // one-line catch-up plan
  const lateHere = open.filter(isLate);
  if (lateHere.length && (f === "all" || f === "overdue" || cls(f))) {
    const mins = lateHere.reduce((a, t) => a + est(t), 0), hrs = S.meta.hoursPerDay || 1.5;
    const days = Math.max(1, Math.ceil(mins / (hrs * 60)));
    const step = d => { const n = Math.min(6, Math.max(0.5, hrs + d)); saveMeta({ hoursPerDay: n }); render(); };
    v.appendChild(h("div", { class: "stick plan2" }, [
      h("div", null, [
        h("div", { class: "ttl", text: lateHere.length + " overdue · about " + fmtMin(mins) + " of work" }),
        h("div", { class: "tmeta" }, [h("span", { text: "At " + hrs + "h a day, you're caught up " + (days === 1 ? "tonight" : "by " + shortDate(key(addDays(new Date(), days - 1)))) })])
      ]),
      h("div", { class: "stepper" }, [h("button", { type: "button", "aria-label": "Less time per day", onclick: () => step(-0.5) }, ["−"]), h("button", { type: "button", "aria-label": "More time per day", onclick: () => step(0.5) }, ["+"])])
    ]));
  }

  const end = key(addDays(new Date(), 7));
  const byDate = (a, b) => (a.date || "").localeCompare(b.date || "") || (a.time || "99").localeCompare(b.time || "99");
  const groups = [
    ["Overdue", open.filter(isLate).sort(byDate)],
    ["Today", open.filter(t => t.date === tk && !isLate(t)).sort(byDate)],
    ["This week", open.filter(t => t.date > tk && t.date <= end).sort(byDate)],
    ["Later", open.filter(t => t.date > end).sort(byDate)],
    ["No date", open.filter(t => !t.date)]
  ];
  let any = false;
  groups.forEach(g => {
    if (!g[1].length) return; any = true;
    v.appendChild(h("div", { class: "ghead" + (g[0] === "Overdue" ? " late" : "") }, [h("span", { text: g[0] }), h("span", { text: String(g[1].length) })]));
    const l = h("div", { class: "list" }); g[1].forEach(t => l.appendChild(taskRow(t))); v.appendChild(l);
  });
  if (!any) v.appendChild(h("div", { class: "stick empty", style: "margin-top:16px", text: f === "overdue" ? "Nothing overdue." : "Nothing here. Tap + to add a task." }));
  const done = all.filter(t => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  if (done.length) {
    v.appendChild(h("button", { class: "linkish", type: "button", style: "margin:18px 4px 8px;display:block", onclick: () => { S.showDone = !S.showDone; render(); } }, [(S.showDone ? "Hide" : "Show") + " completed (" + done.length + ")"]));
    if (S.showDone) { const l = h("div", { class: "list" }); done.slice(0, 30).forEach(t => l.appendChild(taskRow(t))); v.appendChild(l); }
  }
}

// GOALS
function viewGoals(v) {
  const tk = today(), cd = countdown();
  v.appendChild(secTitle("SAT", null, h("button", { class: "linkish", type: "button", onclick: satSheet }, ["Edit"])));
  const card = h("div", { class: "stick goalcard" });
  card.appendChild(h("div", { class: "grow" }, [
    h("div", null, [h("div", { class: "big", style: "color:var(--coral)", "data-cd": "d", text: String(cd.d) }), h("div", { class: "small-note", text: "days · " + shortDate(S.meta.testDate) + " at " + fmtTime(S.meta.testTime) })]),
    S.meta.goal ? h("div", { style: "text-align:right" }, [h("div", { class: "small-note", text: "Goal" }), h("div", { class: "mid", text: String(S.meta.goal) })]) : null
  ]));
  if (!S.meta.registered && S.meta.testDate === "2026-12-05" && tk <= "2026-11-24") {
    card.appendChild(h("div", { class: "note-row" }, [h("span", { text: tk <= "2026-11-20" ? "Register by Fri, Nov 20" : "Late registration ends Tue, Nov 24" }), h("button", { class: "linkish", type: "button", onclick: () => saveMeta({ registered: true }) }, ["I'm registered"])]));
  }
  const mins = minutesOn(tk, "sat"), goal = S.meta.satDaily || 45;
  card.appendChild(h("div", { class: "note-row" }, [
    h("div", { style: "display:flex;align-items:center;gap:10px" }, [ring(34, mins / goal, "sat-ring"), h("span", { text: fmtMin(mins) + " of " + fmtMin(goal) + " practice today" })]),
    h("div", { style: "display:flex;gap:6px" }, [
      h("button", { class: "btn small coral", type: "button", onclick: () => startFocus({ cat: "sat", section: "Math", label: "SAT Math practice" }) }, ["Math"]),
      h("button", { class: "btn small coral", type: "button", onclick: () => startFocus({ cat: "sat", section: "Reading & Writing", label: "SAT Reading & Writing practice" }) }, ["R&W"])
    ])
  ]));
  const sc = S.scores.slice().sort((a, b) => a.date.localeCompare(b.date));
  const scoreRow = h("div", { class: "note-row", style: "display:block" });
  if (sc.length) {
    const last = sc[sc.length - 1];
    scoreRow.appendChild(h("div", { style: "display:flex;justify-content:space-between;align-items:center;margin-bottom:6px" }, [h("span", { text: "Latest practice test: " + (last.math + last.rw) + (S.meta.goal ? " · " + Math.max(0, S.meta.goal - last.math - last.rw) + " to go" : "") }), h("button", { class: "linkish", type: "button", onclick: () => scoreSheet(null) }, ["Log score"])]));
    if (sc.length > 1) scoreRow.appendChild(chart(sc));
  } else scoreRow.appendChild(h("div", { style: "display:flex;justify-content:space-between;align-items:center" }, [h("span", { class: "small-note", text: "No practice tests logged yet" }), h("button", { class: "linkish", type: "button", onclick: () => scoreSheet(null) }, ["Log score"])]));
  card.appendChild(scoreRow);
  const satOpen = S.tasks.filter(t => t.cat === "sat" && !t.done).length;
  card.appendChild(h("button", { class: "note-row linkrow", type: "button", onclick: () => { S.taskFilter = "sat"; go("tasks"); } }, [h("span", { text: "SAT to-dos" }), h("span", { class: "small-note", text: satOpen + " open ›" })]));
  v.appendChild(card);

  v.appendChild(secTitle("Competitions", null, h("button", { class: "linkish", type: "button", onclick: () => compSheet(null) }, ["Add"])));
  const up = S.comps.filter(c => !c.date || c.date >= tk).sort((a, b) => (a.date || "~").localeCompare(b.date || "~"));
  if (!up.length) v.appendChild(h("div", { class: "stick empty", text: "No upcoming competitions." }));
  up.forEach(c => v.appendChild(compCard(c, false)));
}

// ---------- sheets ----------
function openSheet(build) {
  const s = $("sheet"); s.textContent = ""; build(s);
  $("sheetWrap").hidden = false;
  setTimeout(() => { const f = s.querySelector("input:not([type=hidden]), button"); f && f.focus(); }, 40);
}
function closeSheet() { $("sheetWrap").hidden = true; }
$("sheetWrap").addEventListener("click", e => { if (e.target.id === "sheetWrap") closeSheet(); });
function chipPick(opts, value, onPick, multiColor) {
  const w = h("div", { class: "wrapchips" });
  let cur = value;
  const paint = () => w.querySelectorAll(".chip").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === String(cur) ? "true" : "false"));
  opts.forEach(o => w.appendChild(h("button", { type: "button", class: "chip" + (o.c ? "" : " dark"), "data-v": String(o.v), style: o.c ? "--c:" + o.c : null, onclick: () => { cur = o.v; paint(); onPick(o.v); } }, [o.c && multiColor ? h("span", { class: "dot" }) : null, o.label])));
  paint(); w.set = v2 => { cur = v2; paint(); };
  return w;
}
function field(label, input, id) { if (id) input.id = id; return h("div", { class: "field" }, [h("label", { for: id || null, text: label }), input]); }
function armBtn(label, fn) {
  const b = h("button", { class: "btn danger", type: "button", text: label });
  let armed = false, t;
  b.addEventListener("click", () => { if (armed) { fn(); return; } armed = true; b.classList.add("armed"); b.textContent = "Tap again to delete"; t = setTimeout(() => { armed = false; b.classList.remove("armed"); b.textContent = label; }, 4000); });
  return b;
}
function errLine() { return h("p", { class: "err", hidden: true }); }
function showErr(e, m) { e.textContent = m; e.hidden = false; }

function addChooser() {
  const ICONS = {
    late: '<path d="M12 8v5M12 16.5v.01"/><circle cx="12" cy="12" r="9"/>',
    doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
    sat: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>',
    trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3a3 3 0 0 1-3 4M7 5H4a3 3 0 0 0 3 4"/>',
    cal: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    cls: '<path d="M4 5h16v12H4zM8 21h8M12 17v4"/>'
  };
  const row = (c, icon, title, sub, fn) => h("button", { class: "arow", type: "button", style: "--c:" + c, onclick: fn }, [
    h("span", { class: "aicon", html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + ICONS[icon] + '</svg>' }),
    h("span", { class: "atext" }, [h("span", { class: "ttl", text: title }), h("span", { class: "tmeta", text: sub })]),
    h("span", { class: "chev", "aria-hidden": "true", text: "›" })
  ]);
  openSheet(s => {
    s.appendChild(h("div", { class: "sheet-head" }, [h("span"), h("h2", { text: "Add" }), h("button", { class: "linkish", type: "button", onclick: closeSheet }, ["Done"])]));
    s.appendChild(h("div", { class: "group" }, [
      row("var(--late)", "late", "Missing work", "Already late on Canvas", () => taskSheet(null, { cat: "class", lateDefault: true })),
      row("var(--cobalt)", "doc", "Assignment", "Homework, lab report, essay, test", () => taskSheet(null, { cat: "class" }))
    ]));
    s.appendChild(h("div", { class: "group" }, [
      row("var(--coral)", "sat", "SAT to-do", "Practice sets, review, full tests", () => taskSheet(null, { cat: "sat" })),
      row("var(--sun)", "trophy", "Competition", "Date, time and place", () => compSheet(null)),
      row("var(--mint)", "cal", "Event", "Class, practice, meeting", () => eventSheet(null, {}))
    ]));
    s.appendChild(h("div", { class: "group" }, [row("var(--muted)", "cls", "Manage classes", "Add, rename or recolor", classesSheet)]));
  });
}

function taskSheet(t, preset) {
  preset = preset || {};
  const editing = !!t;
  const d = Object.assign({ cat: preset.cat || "class", classId: null, compId: preset.compId || null, type: null, date: preset.date || null, time: null, est: 60, title: "" }, t || {});
  if (!editing && d.cat === "class" && !d.classId && S.classes.length === 1) d.classId = S.classes[0].id;
  if (!editing && !d.date && !preset.lateDefault && d.cat !== "comp") d.date = null;
  openSheet(s => {
    s.appendChild(h("h2", { text: editing ? "Edit" : preset.lateDefault ? "Add missing work" : d.cat === "sat" ? "SAT to-do" : d.cat === "comp" ? "Comp prep task" : "Add assignment" }));
    const title = h("input", { class: "big-in", maxlength: "140", autocomplete: "off", placeholder: d.cat === "sat" ? "e.g. Practice test #2" : d.cat === "comp" ? "e.g. Finish slides" : "e.g. Lab report: enzymes" });
    title.value = d.title; s.appendChild(field("What is it?", title, "t-title"));

    if (!editing) {
      s.appendChild(h("div", { class: "field" }, [h("span", { class: "lbl", text: "Kind" }), chipPick([{ v: "class", label: "Class" }, { v: "sat", label: "SAT", c: "var(--coral)" }, { v: "comp", label: "Comp prep", c: "var(--sun)" }, { v: "other", label: "Personal", c: "var(--mint)" }], d.cat, v => { d.cat = v; classBox.hidden = v !== "class"; compBox.hidden = v !== "comp"; })]));
    }
    // class picker
    const classBox = h("div", { class: "field" });
    function drawClasses() {
      classBox.textContent = "";
      classBox.appendChild(h("span", { class: "lbl", text: "Class" }));
      const opts = S.classes.slice().sort((a, b) => a.name.localeCompare(b.name)).map(c => ({ v: c.id, label: c.name, c: c.color }));
      const cp = chipPick(opts, d.classId, v => { d.classId = v; }, true);
      const newIn = h("input", { placeholder: "New class name", maxlength: "40", style: "flex:1;min-width:0" });
      const addB = h("button", { class: "btn small", type: "button", onclick: async () => {
        const n = newIn.value.trim(); if (!n) { newIn.focus(); return; }
        const id = newId(), used = S.classes.map(c => c.color);
        const color = CLASS_COLORS.find(c => used.indexOf(c) < 0) || CLASS_COLORS[S.classes.length % CLASS_COLORS.length];
        try { await put("classes", id, { name: n, color }); } catch (e) { failed(e); return; }
        if (!S.classes.find(c => c.id === id)) S.classes.push({ id, name: n, color });
        d.classId = id; drawClasses();
      } }, ["Add"]);
      newIn.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addB.click(); } });
      classBox.appendChild(cp);
      classBox.appendChild(h("div", { style: "display:flex;gap:8px;margin-top:4px" }, [h("div", { class: "field", style: "flex:1" }, [newIn]), addB]));
    }
    drawClasses(); classBox.hidden = d.cat !== "class"; s.appendChild(classBox);
    // comp picker
    const compSel = h("select");
    compSel.appendChild(h("option", { value: "", text: S.comps.length ? "Pick a competition" : "Add a competition first" }));
    S.comps.forEach(c => compSel.appendChild(h("option", { value: c.id, text: c.name })));
    compSel.value = d.compId || "";
    const compBox = field("Competition", compSel, "t-comp"); compBox.hidden = d.cat !== "comp"; s.appendChild(compBox);
    // type
    const typeBox = h("div", { class: "field" }, [h("span", { class: "lbl", text: "Type" }), chipPick(TYPES.map(x => ({ v: x, label: x })), d.type, v => { d.type = d.type === v ? null : v; })]);
    s.appendChild(typeBox);
    // due
    const tk = today(), dateIn = h("input", { type: "date" }); dateIn.value = d.date || "";
    const quick = [{ v: tk, label: "Today" }, { v: key(addDays(new Date(), 1)), label: "Tomorrow" }];
    for (let i = 2; i < 7; i++) { const x = addDays(new Date(), i); if (x.getDay() === 5 || x.getDay() === 1) quick.push({ v: key(x), label: DOW[x.getDay()] + " " + x.getDate() }); }
    if (preset.lateDefault) quick.unshift({ v: key(addDays(new Date(), -1)), label: "Yesterday" }, { v: key(addDays(new Date(), -7)), label: "Last week" });
    quick.push({ v: "", label: "No date" });
    const qp = chipPick(quick, d.date || "", v => { dateIn.value = v; });
    dateIn.addEventListener("change", () => qp.set(dateIn.value));
    const timeIn = h("input", { type: "time" }); timeIn.value = d.time || "";
    s.appendChild(h("div", { class: "field" }, [h("span", { class: "lbl", text: preset.lateDefault ? "When was it due?" : "Due" }), qp]));
    s.appendChild(h("div", { class: "two" }, [field("Date", dateIn, "t-date"), field("Time (optional)", timeIn, "t-time")]));
    // estimate
    s.appendChild(h("div", { class: "field" }, [h("span", { class: "lbl", text: "How long will it take?" }), chipPick(ESTS.map(e => ({ v: e[0], label: e[1] })), d.est, v => { d.est = v; })]));
    const err = errLine(); s.appendChild(err);
    const save = h("button", { class: "btn go", type: "button" }, [editing ? "Save" : "Add it"]);
    save.addEventListener("click", async () => {
      const ttl = title.value.trim();
      if (!ttl) return showErr(err, "Give it a name first.");
      if (d.cat === "comp" && !compSel.value) return showErr(err, S.comps.length ? "Pick which competition this is for." : "Add the competition first, then its prep tasks.");
      const body = { title: ttl, cat: d.cat, classId: d.cat === "class" ? d.classId || null : null, compId: d.cat === "comp" ? compSel.value : null, type: d.type || null, date: dateIn.value || null, time: timeIn.value || null, est: d.est || 60, done: t ? !!t.done : false, doneAt: t ? t.doneAt || null : null, spent: t ? t.spent || 0 : 0, created: t ? t.created || Date.now() : Date.now() };
      save.disabled = true;
      try { await put("tasks", t ? t.id : newId(), body); closeSheet(); if (!editing) toast(isLate(body) ? "Added to your catch-up list" : "Added", null, null); }
      catch (e) { showErr(err, "That didn't save. Check your connection and try again."); }
      finally { save.disabled = false; }
    });
    const addAnother = !editing ? h("button", { class: "btn", type: "button", onclick: async () => { save.click(); setTimeout(() => { if ($("sheetWrap").hidden) taskSheet(null, Object.assign({}, preset, { cat: d.cat, compId: compSel.value || preset.compId })); }, 250); } }, ["Save + another"]) : null;
    s.appendChild(h("div", { class: "actions" }, [editing ? armBtn("Delete", () => { closeSheet(); del("tasks", t.id).catch(failed); }) : null, h("span", { class: "sp" }), h("button", { class: "btn ghost", type: "button", onclick: closeSheet }, ["Cancel"]), addAnother, save]));
  });
}

function eventSheet(e, preset) {
  preset = preset || {};
  const d = Object.assign({ title: "", cat: "other", classId: null, date: preset.date || today(), start: preset.start || "", end: preset.end || "", notes: "" }, e || {});
  openSheet(s => {
    s.appendChild(h("h2", { text: e ? "Edit event" : "Add event" }));
    const title = h("input", { class: "big-in", maxlength: "120", placeholder: "e.g. Robotics practice" }); title.value = d.title;
    s.appendChild(field("What", title, "e-title"));
    const classSel = h("select"); classSel.appendChild(h("option", { value: "", text: "No class" })); S.classes.forEach(c => classSel.appendChild(h("option", { value: c.id, text: c.name }))); classSel.value = d.classId || "";
    const classF = field("Class", classSel, "e-class"); classF.hidden = d.cat !== "class";
    s.appendChild(h("div", { class: "field" }, [h("span", { class: "lbl", text: "Category" }), chipPick([{ v: "class", label: "Class" }, { v: "sat", label: "SAT", c: "var(--coral)" }, { v: "comp", label: "Competition", c: "var(--sun)" }, { v: "other", label: "Personal", c: "var(--mint)" }], d.cat, v => { d.cat = v; classF.hidden = v !== "class"; })]));
    s.appendChild(classF);
    const date = h("input", { type: "date" }); date.value = d.date || "";
    const st = h("input", { type: "time" }); st.value = d.start || "";
    const en = h("input", { type: "time" }); en.value = d.end || "";
    s.appendChild(field("Date", date, "e-date"));
    s.appendChild(h("div", { class: "two" }, [field("Starts", st, "e-start"), field("Ends", en, "e-end")]));
    const rep = h("select"); [["1", "Doesn't repeat"], ["4", "Weekly × 4"], ["8", "Weekly × 8"], ["12", "Weekly × 12"]].forEach(o => rep.appendChild(h("option", { value: o[0], text: o[1] })));
    if (!e) s.appendChild(field("Repeat", rep, "e-rep"));
    const notes = h("textarea", { maxlength: "500", placeholder: "Room, what to bring…" }); notes.value = d.notes || "";
    s.appendChild(field("Notes", notes, "e-notes"));
    const err = errLine(); s.appendChild(err);
    const save = h("button", { class: "btn go", type: "button" }, [e ? "Save" : "Add"]);
    save.addEventListener("click", async () => {
      if (!title.value.trim()) return showErr(err, "Give it a name.");
      if (!date.value) return showErr(err, "Pick a date.");
      const body = { title: title.value.trim(), cat: d.cat, classId: d.cat === "class" ? classSel.value || null : null, date: date.value, start: st.value || null, end: en.value || null, notes: notes.value.trim() || null };
      save.disabled = true;
      try {
        if (e) await put("events", e.id, body);
        else { const n = +rep.value; for (let i = 0; i < n; i++) await put("events", newId(), Object.assign({}, body, { date: key(addDays(parse(date.value), 7 * i)) })); }
        closeSheet();
      } catch (x) { showErr(err, "That didn't save. Try again."); } finally { save.disabled = false; }
    });
    s.appendChild(h("div", { class: "actions" }, [e ? armBtn("Delete", () => { closeSheet(); del("events", e.id).catch(failed); }) : null, h("span", { class: "sp" }), h("button", { class: "btn ghost", type: "button", onclick: closeSheet }, ["Cancel"]), save]));
  });
}

function compSheet(c) {
  openSheet(s => {
    s.appendChild(h("h2", { text: c ? "Edit competition" : "Add competition" }));
    const name = h("input", { class: "big-in", maxlength: "80", placeholder: "e.g. Science Olympiad regionals" }); name.value = c ? c.name : "";
    const date = h("input", { type: "date" }); date.value = c && c.date || "";
    const time = h("input", { type: "time" }); time.value = c && c.time || "";
    const loc = h("input", { maxlength: "80", placeholder: "School, city…" }); loc.value = c && c.location || "";
    s.appendChild(field("Name", name, "c-name"));
    s.appendChild(h("div", { class: "two" }, [field("Date", date, "c-date"), field("Start time", time, "c-time")]));
    s.appendChild(field("Where (optional)", loc, "c-loc"));
    const err = errLine(); s.appendChild(err);
    const save = h("button", { class: "btn go", type: "button" }, [c ? "Save" : "Add"]);
    save.addEventListener("click", async () => {
      if (!name.value.trim()) return showErr(err, "Give it a name.");
      save.disabled = true;
      try { await put("comps", c ? c.id : newId(), { name: name.value.trim(), date: date.value || null, time: time.value || null, location: loc.value.trim() || null }); closeSheet(); if (!c) go("comps"); }
      catch (x) { showErr(err, "That didn't save. Try again."); } finally { save.disabled = false; }
    });
    s.appendChild(h("div", { class: "actions" }, [c ? armBtn("Delete", () => { closeSheet(); del("comps", c.id).catch(failed); }) : null, h("span", { class: "sp" }), h("button", { class: "btn ghost", type: "button", onclick: closeSheet }, ["Cancel"]), save]));
  });
}

function classesSheet() {
  openSheet(s => {
    s.appendChild(h("h2", { text: "Your classes" }));
    const list = h("div", { style: "display:grid;gap:8px" });
    function draw() {
      list.textContent = "";
      if (!S.classes.length) list.appendChild(h("p", { class: "small-note", style: "margin:0", text: "Add each class you have on Canvas." }));
      S.classes.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach(c => {
        const sw = h("button", { class: "swatch", type: "button", style: "--c:" + c.color, "aria-label": "Change color for " + c.name });
        sw.addEventListener("click", () => { const i = (CLASS_COLORS.indexOf(c.color) + 1) % CLASS_COLORS.length; c.color = CLASS_COLORS[i]; sw.style.setProperty("--c", c.color); put("classes", c.id, { name: c.name, color: c.color }).catch(failed); });
        const nm = h("input", { maxlength: "40", "aria-label": "Class name" }); nm.value = c.name;
        nm.addEventListener("change", () => { const v = nm.value.trim(); if (v) { c.name = v; put("classes", c.id, { name: v, color: c.color }).catch(failed); } });
        list.appendChild(h("div", { class: "clsrow" }, [sw, h("div", { class: "field" }, [nm]), armBtn("Delete", () => { del("classes", c.id).catch(failed); S.classes = S.classes.filter(x => x.id !== c.id); draw(); })]));
      });
    }
    draw(); s.appendChild(list);
    const inp = h("input", { maxlength: "40", placeholder: "e.g. AP Bio" });
    const add = h("button", { class: "btn go", type: "button" }, ["Add class"]);
    add.addEventListener("click", async () => {
      const n = inp.value.trim(); if (!n) { inp.focus(); return; }
      const used = S.classes.map(c => c.color), color = CLASS_COLORS.find(c => used.indexOf(c) < 0) || CLASS_COLORS[S.classes.length % CLASS_COLORS.length], id = newId();
      try { await put("classes", id, { name: n, color }); if (!S.classes.find(c => c.id === id)) S.classes.push({ id, name: n, color }); inp.value = ""; draw(); inp.focus(); } catch (e) { failed(e); }
    });
    inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); add.click(); } });
    s.appendChild(h("div", { style: "display:flex;gap:8px;align-items:center" }, [h("div", { class: "field", style: "flex:1" }, [inp]), add]));
    s.appendChild(h("p", { class: "small-note", style: "margin:0;color:var(--muted)", text: "Tap a color square to change it." }));
    s.appendChild(h("div", { class: "actions" }, [h("span", { class: "sp" }), h("button", { class: "btn", type: "button", onclick: () => { closeSheet(); render(); } }, ["Done"])]));
  });
}

function satSheet() {
  openSheet(s => {
    s.appendChild(h("h2", { text: "SAT settings" }));
    const date = h("input", { type: "date" }); date.value = S.meta.testDate;
    const time = h("input", { type: "time" }); time.value = S.meta.testTime || "07:45";
    const goal = h("input", { type: "number", min: "400", max: "1600", step: "10", inputmode: "numeric", placeholder: "e.g. 1400" }); goal.value = S.meta.goal || "";
    const daily = h("input", { type: "number", min: "5", max: "300", step: "5", inputmode: "numeric" }); daily.value = S.meta.satDaily || 45;
    let reg = !!S.meta.registered;
    const tg = h("button", { class: "toggle", type: "button", "aria-pressed": reg ? "true" : "false", onclick: () => { reg = !reg; tg.setAttribute("aria-pressed", reg ? "true" : "false"); } }, ["I'm registered", h("span", { class: "sw" })]);
    s.appendChild(h("div", { class: "two" }, [field("Test date", date, "s-date"), field("Check-in time", time, "s-time")]));
    s.appendChild(tg);
    s.appendChild(h("div", { class: "two" }, [field("Goal score", goal, "s-goal"), field("Daily practice (min)", daily, "s-daily")]));
    const err = errLine(); s.appendChild(err);
    const save = h("button", { class: "btn go", type: "button" }, ["Save"]);
    save.addEventListener("click", () => {
      const g = parseInt(goal.value, 10);
      if (!date.value) return showErr(err, "Pick your test date.");
      saveMeta({ testDate: date.value, testTime: time.value || "07:45", registered: reg, goal: g >= 400 && g <= 1600 ? g : null, satDaily: Math.max(5, parseInt(daily.value, 10) || 45) });
      closeSheet(); render();
    });
    s.appendChild(h("div", { class: "actions" }, [h("span", { class: "sp" }), h("button", { class: "btn ghost", type: "button", onclick: closeSheet }, ["Cancel"]), save]));
  });
}

function scoreSheet(sc) {
  openSheet(s => {
    s.appendChild(h("h2", { text: sc ? "Edit score" : "Log a practice test" }));
    const date = h("input", { type: "date" }); date.value = sc ? sc.date : today();
    const m = h("input", { type: "number", min: "200", max: "800", step: "10", inputmode: "numeric", placeholder: "200–800" }); m.value = sc ? sc.math : "";
    const r = h("input", { type: "number", min: "200", max: "800", step: "10", inputmode: "numeric", placeholder: "200–800" }); r.value = sc ? sc.rw : "";
    s.appendChild(field("Date", date, "sc-date"));
    s.appendChild(h("div", { class: "two" }, [field("Reading & Writing", r, "sc-rw"), field("Math", m, "sc-m")]));
    const err = errLine(); s.appendChild(err);
    const save = h("button", { class: "btn go", type: "button" }, ["Save"]);
    save.addEventListener("click", async () => {
      const mv = parseInt(m.value, 10), rv = parseInt(r.value, 10);
      if (!(mv >= 200 && mv <= 800 && rv >= 200 && rv <= 800)) return showErr(err, "Each section score is between 200 and 800.");
      try { await put("scores", sc ? sc.id : newId(), { date: date.value || today(), math: mv, rw: rv }); closeSheet(); if (!sc) { toast("Logged " + (mv + rv), null, null); } }
      catch (x) { showErr(err, "That didn't save. Try again."); }
    });
    s.appendChild(h("div", { class: "actions" }, [sc ? armBtn("Delete", () => { closeSheet(); del("scores", sc.id).catch(failed); }) : null, h("span", { class: "sp" }), h("button", { class: "btn ghost", type: "button", onclick: closeSheet }, ["Cancel"]), save]));
  });
}

// ---------- focus timer ----------
const F = { len: 25, left: 25 * 60, running: false, endAt: 0, startedAt: 0, elapsed: 0, task: null, cat: null, section: null, label: "", int: null, finished: false };
const ARC = 2 * Math.PI * 104;
$("fArc").setAttribute("stroke-dasharray", ARC.toFixed(1));
function startFocus(o) {
  F.task = o.task || null; F.cat = o.task ? o.task.cat : (o.cat || "other"); F.section = o.section || null;
  F.label = o.task ? o.task.title : (o.label || "Deep work");
  F.len = F.cat === "sat" ? 30 : 25; F.left = F.len * 60; F.running = false; F.elapsed = 0; F.finished = false;
  $("fKick").textContent = o.task ? "Focusing on" : F.cat === "sat" ? "SAT practice" : "Focus session";
  $("fWhat").textContent = F.label;
  $("focus").hidden = false; drawFocus();
}
function drawFocus() {
  const m = Math.floor(F.left / 60), s = Math.floor(F.left % 60);
  $("fTime").textContent = F.finished ? "Done!" : m + ":" + pad(s);
  $("fArc").setAttribute("stroke-dashoffset", (ARC * (1 - F.left / (F.len * 60))).toFixed(1));
  const lens = $("fLens"); lens.textContent = "";
  if (!F.running && F.elapsed === 0 && !F.finished) [15, 25, 30, 45, 60].forEach(n => lens.appendChild(h("button", { class: "chip", type: "button", "aria-pressed": F.len === n ? "true" : "false", onclick: () => { F.len = n; F.left = n * 60; drawFocus(); } }, [n + " min"])));
  const b = $("fBtns"); b.textContent = "";
  if (F.finished) {
    if (F.task && !F.task.done) b.appendChild(h("button", { class: "btn mint", type: "button", onclick: () => { const t = S.tasks.find(x => x.id === F.task.id) || F.task; const body = strip(t); body.done = true; body.doneAt = Date.now(); put("tasks", t.id, body).catch(failed); closeFocus(); toast("Cleared: " + t.title, null, null); } }, ["I finished it ✓"]));
    b.appendChild(h("button", { class: "btn", type: "button", onclick: () => { F.left = F.len * 60; F.elapsed = 0; F.finished = false; drawFocus(); } }, ["Another round"]));
    b.appendChild(h("button", { class: "btn", type: "button", onclick: closeFocus }, ["Close"]));
    return;
  }
  b.appendChild(h("button", { class: "btn mint", type: "button", onclick: F.running ? pauseFocus : runFocus }, [F.running ? "Pause" : F.elapsed ? "Resume" : "Start"]));
  b.appendChild(h("button", { class: "btn", type: "button", onclick: () => finishFocus(false) }, [F.elapsed ? "Stop & log" : "Cancel"]));
}
function runFocus() { F.running = true; F.endAt = Date.now() + F.left * 1000; F.startedAt = Date.now() - F.elapsed * 1000; clearInterval(F.int); F.int = setInterval(tickFocus, 250); drawFocus(); }
function pauseFocus() { F.running = false; clearInterval(F.int); F.elapsed = (Date.now() - F.startedAt) / 1000; drawFocus(); }
function tickFocus() {
  F.left = Math.max(0, (F.endAt - Date.now()) / 1000); F.elapsed = (Date.now() - F.startedAt) / 1000;
  const m = Math.floor(F.left / 60), s = Math.floor(F.left % 60);
  $("fTime").textContent = m + ":" + pad(s);
  $("fArc").setAttribute("stroke-dashoffset", (ARC * (1 - F.left / (F.len * 60))).toFixed(1));
  if (F.left <= 0) finishFocus(true);
}
async function finishFocus(natural) {
  clearInterval(F.int); if (F.running) F.elapsed = (Date.now() - F.startedAt) / 1000; F.running = false;
  const mins = Math.round(F.elapsed / 60);
  if (mins >= 1) {
    try {
      await put("sessions", newId(), { date: today(), minutes: mins, cat: F.cat, section: F.section, taskId: F.task ? F.task.id : null, at: Date.now() });
      if (F.task) { const t = S.tasks.find(x => x.id === F.task.id); if (t) { const body = strip(t); body.spent = (t.spent || 0) + mins; await put("tasks", t.id, body); } }
    } catch (e) { failed(e); }
  }
  if (natural) { F.finished = true; F.left = 0; drawFocus(); }
  else { closeFocus(); if (mins >= 1) toast("Logged " + fmtMin(mins) + " of focus", null, null); }
}
function closeFocus() { clearInterval(F.int); F.running = false; $("focus").hidden = true; render(); }

// ---------- live ticker ----------
let lastDay = today();
function tick() {
  const cd = countdown();
  document.querySelectorAll("[data-cd]").forEach(el => {
    const k = el.dataset.cd;
    el.textContent = k === "hms" ? (cd.past ? "Test day has passed" : (cd.d === 1 ? "day · " : "days · ") + cd.h + "h " + pad(cd.m) + "m " + pad(cd.s) + "s") : String(cd[k]);
  });
  if (today() !== lastDay) { lastDay = today(); render(); }
}
setInterval(tick, 1000);

// ---------- wiring ----------
document.querySelectorAll("nav.tabs button").forEach(b => b.addEventListener("click", () => go(b.dataset.v)));
$("fab").addEventListener("click", () => {
  if (S.view === "tasks") taskSheet(null, { cat: ["sat", "comp", "other"].indexOf(S.taskFilter) >= 0 ? S.taskFilter : "class", lateDefault: S.taskFilter === "overdue" });
  else addChooser();
});
document.addEventListener("keydown", e => { if (e.key === "Escape") { if (!$("sheetWrap").hidden) closeSheet(); } });

$("settingsBtn").addEventListener("click", settingsSheet);
$("signinBtn").addEventListener("click", signIn);
render();
connect();
