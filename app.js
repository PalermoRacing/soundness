// Palermo Gait Check — app logic
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, query, orderBy, limit }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2,6);

const GEMINI = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-3-flash-preview";
const INLINE_MAX = 14 * 1024 * 1024;   // videos up to ~14 MB are sent directly

const FOOTAGE = { inhand_straight:"In hand, towards/away", inhand_side:"In hand, side-on", behind:"From behind, walked/run away", cart:"In the cart", lunge:"Lunging / circle" };
const LIMBS = {LF:"Left fore", RF:"Right fore", LH:"Left hind", RH:"Right hind"};
const VERDICT = {sound:"Looks sound", possible:"Possible lameness", lame:"Lame", unclear:"Can't tell"};
const LEVEL = {none:"No sign", watch:"Watch", suspect:"Suspect", likely:"Likely"};
const WORK = {jog:"Jog", canter:"Canter", fast:"Fast work", heats:"Heats", trial:"Trial / workout", race:"Race", other:"Other"};
const DTYPE = {jog:"Jog", canter:"Canter", fast:"Fast work", heats:"Heats", track:"Trackwork", trial:"Trial", race:"Race", swim:"Swim", walker:"Walker", treadmill:"Treadmill", paddock:"Paddock / turnout", rest:"Rest day", farrier:"Shod / farrier", vet:"Vet / treatment", other:"Other"};
const SHOEWORK = {full:"Full set", fronts:"Fronts only", hinds:"Hinds only", reset:"Reset", trim:"Trim only", lost:"Lost shoe replaced"};
const horseById = (id) => S.horses.find(h => h.id === id);
const hLabel = (h) => !h ? "" : (h.stableName && h.stableName.trim().toLowerCase() !== String(h.name||"").trim().toLowerCase()) ? `${h.stableName} (${h.name})` : h.name;
const hShort = (h) => !h ? "" : (h.stableName || h.name);
const hName = (id, fallback) => { const h = horseById(id); return h ? hLabel(h) : (fallback || "Unknown horse"); };
const todayStr = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0,10); };
const addDays = (str, n) => { const d = new Date(str + "T12:00:00"); d.setDate(d.getDate() + n); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0,10); };
const fmtDay = (str) => { try { return new Date(str + "T12:00:00").toLocaleDateString("en-NZ", {weekday:"short", day:"numeric", month:"short", year:"numeric"}); } catch(_){ return str; } };

const S = { fs:null, auth:null, me:null, horses:[], checks:[], hr:[], settings:{}, unsubs:[],
  diary:[], temps:[], starts:[], care:[], supps:[], diaryMode:"work", invMonth:null, showAllDiary:false, editHorse:false,
  file:null, segStart:0, ctl:null, openHorse:null, openCheck:null, prevTab:"diary" };

/* ================= boot & auth ================= */
function boot(){
  const cfg = window.PALERMO_CONFIG?.firebase;
  if (!cfg || !cfg.apiKey || cfg.apiKey === "PASTE-HERE"){ $("setupView").hidden = false; return; }
  const app = initializeApp(cfg);
  S.auth = getAuth(app); S.fs = getFirestore(app);
  bindUI();
  getRedirectResult(S.auth).catch(err => showSigninErr(err));
  onAuthStateChanged(S.auth, (user) => {
    S.unsubs.forEach(u => u()); S.unsubs = [];
    S.me = user;
    $("signinView").hidden = !!user; $("appView").hidden = !user; $("who").hidden = !user;
    if (user){ $("whoName").textContent = user.displayName || user.email; startData(); }
  });
}
function showSigninErr(err){
  if (!err) return;
  const m = {"auth/unauthorized-domain":"This web address isn't on Firebase's authorised domains list yet (setup guide, step 3).",
    "auth/popup-closed-by-user":"", "auth/cancelled-popup-request":""}[err.code];
  alertBox("signinMsg", m ?? ("Sign-in didn't work: " + (err.message || err.code)));
}
async function doSignIn(){
  alertBox("signinMsg","");
  const p = new GoogleAuthProvider(); p.setCustomParameters({prompt:"select_account"});
  try { await signInWithPopup(S.auth, p); }
  catch(err){
    if (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment") signInWithRedirect(S.auth, p);
    else showSigninErr(err);
  }
}
function startData(){
  const denied = (err) => {
    if (err?.code === "permission-denied"){
      alertBox("storeNote", `${S.me?.email} isn't on the team list yet. Ask whoever set up Gait Check to add this address to the Firestore rules (setup guide, step 7).`);
    } else alertBox("storeNote", "Can't reach the database right now. Check your internet connection.");
  };
  S.unsubs.push(onSnapshot(collection(S.fs,"horses"), snap => {
    S.horses = snap.docs.map(d => ({id:d.id, ...d.data()})).sort((a,b)=>String(hShort(a)).localeCompare(String(hShort(b))));
    renderHorseSelect(); renderHorses(); renderDiaryRecent(); renderHrRecent(); renderTempRecent(); renderSuppTotals();
  }, denied));
  S.unsubs.push(onSnapshot(query(collection(S.fs,"checks"), orderBy("createdAt","desc"), limit(500)), snap => {
    S.checks = snap.docs.map(d => ({id:d.id, ...d.data()}));
    renderHorses(); renderLatestOrExample();
  }, denied));
  S.unsubs.push(onSnapshot(query(collection(S.fs,"hr"), orderBy("at","desc"), limit(1000)), snap => {
    S.hr = snap.docs.map(d => ({id:d.id, ...d.data()}));
    renderHrRecent(); renderTempRecent(); renderDiaryRecent(); renderHorses();
  }, denied));
  S.unsubs.push(onSnapshot(query(collection(S.fs,"temps"), orderBy("at","desc"), limit(2000)), snap => {
    S.temps = snap.docs.map(d => ({id:d.id, ...d.data()}));
    renderTempRecent(); renderHorses();
  }, denied));
  S.unsubs.push(onSnapshot(query(collection(S.fs,"starts"), orderBy("date","desc"), limit(1000)), snap => {
    S.starts = snap.docs.map(d => ({id:d.id, ...d.data()}));
    renderDiaryRecent(); renderHorses();
  }, denied));
  S.unsubs.push(onSnapshot(query(collection(S.fs,"care"), orderBy("date","desc"), limit(2000)), snap => {
    S.care = snap.docs.map(d => ({id:d.id, ...d.data()}));
    renderDiaryRecent(); renderHorses();
  }, denied));
  S.unsubs.push(onSnapshot(doc(S.fs,"settings","supplements"), snap => {
    S.supps = snap.exists() ? (snap.data().list || []) : []; S.suppDetails = snap.exists() ? (snap.data().details || {}) : {};
    renderSuppSettings(); renderHorses();
  }, () => {}));
  S.unsubs.push(onSnapshot(query(collection(S.fs,"diary"), orderBy("date","desc"), limit(3000)), snap => {
    S.diary = snap.docs.map(d => ({id:d.id, ...d.data()})).sort((a,b) => (b.date||"").localeCompare(a.date||"") || (b.createdAt||"").localeCompare(a.createdAt||""));
    renderDiaryRecent(); renderHorses();
  }, denied));
  S.unsubs.push(onSnapshot(doc(S.fs,"settings","app"), snap => {
    S.settings = snap.exists() ? snap.data() : {};
    $("setKey").value = S.settings.geminiKey || ""; $("setModel").value = S.settings.model || "";
    keyNote(); updateAnalyseBtn();
  }, () => {}));
  renderHorseSelect(); renderHorses(); renderLatestOrExample(); renderHrRecent(); renderTempRecent(); renderDiaryRecent(); renderSuppSettings();
}
function keyNote(){
  const n = $("storeNote");
  if (!S.settings.geminiKey){ n.innerHTML = `Add the Gemini API key in <button class="link" type="button" id="goSettings">Settings</button> before analysing videos.`; n.hidden = false; $("goSettings").onclick = () => showTab("settings"); }
  else if (n.querySelector("#goSettings")) n.hidden = true;
}
const save = (col, id, data) => setDoc(doc(S.fs, col, id), data);
const remove = (col, id) => deleteDoc(doc(S.fs, col, id));
const patch = (col, id, data) => setDoc(doc(S.fs, col, id), data, { merge: true });
function saveErrMsg(err){
  if (err?.code === "permission-denied") return "You don't have permission to save. Ask for your email to be added to the team list.";
  return "Couldn't save just now. Check your connection and try again.";
}

/* ================= tabs & UI ================= */
function showTab(t){
  if (t === "settings"){ const cur = document.querySelector('nav.tabs [aria-selected="true"]'); S.prevTab = cur?.dataset.tab || "diary"; }
  document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab===t)));
  ["diary","temp","check","horses","guide","settings"].forEach(p => $("panel-"+p).hidden = p!==t);
  window.scrollTo(0,0);
}
function bindUI(){
  $("signInBtn").onclick = doSignIn;
  $("signOutBtn").onclick = () => signOut(S.auth);
  $("settingsBtn").onclick = () => showTab("settings");
  $("settingsBack").onclick = () => showTab(S.prevTab);
  $("goGuide").onclick = () => showTab("guide");
  $("guideBack").onclick = () => showTab("check");
  document.querySelectorAll("nav.tabs button").forEach(b => b.onclick = () => showTab(b.dataset.tab));
  mountAddForm("add", "addHorseBtn", "addHorseSlot", "horseSel");
  mountAddForm("hha", "hAddHorseBtn", "hAddHorseSlot", null);
  mountAddForm("dad", "dAddHorseBtn", "dAddHorseSlot", "dHorse");
  mountAddForm("tad", "tAddHorseBtn", "tAddHorseSlot", "tHorse");
  $("dForm").onsubmit = saveDiary;
  $("sForm").onsubmit = saveStart;
  $("dModeWork").onclick = () => setDiaryMode("work");
  $("dModeStart").onclick = () => setDiaryMode("start");
  $("tForm").onsubmit = saveTemp;
  $("suppForm").onsubmit = addSupp;
  resetDiaryForm(); setDiaryMode("work");
  $("horseSel").onchange = updateAnalyseBtn;
  $("horseSearch").oninput = renderHorses;
  resetHrWhen();
  $("videoIn").onchange = (e) => { const f = e.target.files[0]; if (f) loadVideo(f); };
  const drop = $("drop");
  drop.ondragover = (e) => e.preventDefault();
  drop.ondrop = (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith("video")) loadVideo(f); };
  $("setStart").onclick = () => { S.segStart = $("video").currentTime || 0; updateSegInfo(); drawPicker(true); };
  $("segLen").onchange = () => { updateSegInfo(); drawPicker(true); };
  $("analyseBtn").onclick = analyse;
  $("measureBtn").onclick = measure;
  bindPicker();
  $("stopBtn").onclick = () => S.ctl?.abort();
  $("settingsForm").onsubmit = async (e) => {
    e.preventDefault();
    try{
      await save("settings","app",{geminiKey:$("setKey").value.trim(), model:$("setModel").value.trim(), updatedAt:new Date().toISOString()});
      msg("settingsMsg","Saved.", true);
    }catch(err){ msg("settingsMsg", saveErrMsg(err), false); }
  };
  $("testKeyBtn").onclick = async () => {
    msg("settingsMsg","Testing…", true);
    try{
      const key = $("setKey").value.trim(); if (!key) throw new Error("Paste a key first.");
      const r = await fetch(`${GEMINI}/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`);
      if (!r.ok) throw new Error(await apiErrText(r));
      const j = await r.json();
      const want = $("setModel").value.trim() || DEFAULT_MODEL;
      const has = (j.models||[]).some(m => m.name === "models/"+want);
      msg("settingsMsg", has ? `The key works and ${want} is available.` : `The key works, but ${want} isn't listed. Gait Check will pick the best available Flash model automatically.`, true);
    }catch(err){ msg("settingsMsg", String(err.message||err), false); }
  };
}
function msg(id, text, ok){ const b=$(id); b.textContent = text; b.hidden = !text; b.className = "small " + (ok ? "ok-text" : "err-text"); }
function alertBox(id, text){ const b=$(id); b.textContent = text; b.hidden = !text; }
function updateAnalyseBtn(){
  $("analyseBtn").disabled = !($("horseSel").value && S.file && S.settings.geminiKey);
  $("measureBtn").disabled = !($("horseSel").value && S.file && S.box && window.Measure);
}

function mountAddForm(p, btnId, slotId, selectId){
  $(slotId).innerHTML = `<form class="seg" id="${p}Form" hidden>
    <div class="row">
      <div class="field"><label for="${p}Name">Race name</label><input id="${p}Name" type="text" required placeholder="Registered name, e.g. Palermo Star"></div>
      <div class="field"><label for="${p}Stable">Stable name (optional)</label><input id="${p}Stable" type="text" placeholder="What you call them, e.g. Star"></div>
    </div>
    <div class="row">
      <div class="field"><label for="${p}Gait">Gait</label><select id="${p}Gait"><option value="pacer">Pacer</option><option value="trotter">Trotter</option></select></div>
    </div>
    <div class="field"><label for="${p}Notes">Notes (optional)</label><input id="${p}Notes" type="text" placeholder="Age, known issues, shoeing…"></div>
    <div class="row"><button class="btn primary" type="submit">Save horse</button><button class="btn" type="button" id="${p}Cancel">Cancel</button></div>
    <div class="small" id="${p}Msg" hidden></div>
  </form>`;
  const form = $(p+"Form");
  $(btnId).onclick = () => { form.hidden = false; $(p+"Name").focus(); };
  $(p+"Cancel").onclick = () => { form.hidden = true; };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const name = $(p+"Name").value.trim(); if (!name) return;
    if (S.horses.some(h => h.name.toLowerCase() === name.toLowerCase())){ msg(p+"Msg", `${name} is already in the list.`, false); return; }
    const id = uid("h");
    try{ await save("horses", id, {name, stableName:$(p+"Stable").value.trim(), gait:$(p+"Gait").value, notes:$(p+"Notes").value.trim(), createdAt:new Date().toISOString()}); }
    catch(err){ msg(p+"Msg", saveErrMsg(err), false); return; }
    form.reset(); form.hidden = true; msg(p+"Msg","",true);
    if (selectId) setTimeout(()=>{ $(selectId).value = id; updateAnalyseBtn(); }, 300);
  };
}
function renderHorseSelect(){
  ["horseSel","tHorse","dHorse"].forEach(id => {
    const sel = $(id); const cur = sel.value;
    sel.innerHTML = S.horses.length
      ? `<option value="">Choose a horse…</option>` + S.horses.map(h => `<option value="${esc(h.id)}">${esc(hLabel(h))} · ${h.gait==="trotter"?"Trotter":"Pacer"}</option>`).join("")
      : `<option value="">Add your first horse →</option>`;
    if (S.horses.some(h=>h.id===cur)) sel.value = cur;
  });
  updateAnalyseBtn();
}

/* ================= heart rate ================= */
const dayAt = (d) => new Date((d || todayStr()) + "T12:00:00").toISOString();   // date-only readings are stored at midday
const dayOf = (iso) => { try{ const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0,10); }catch(_){ return String(iso||"").slice(0,10); } };
function resetHrWhen(){ $("tWhen").value = todayStr(); }
function hrFlag(r){
  const prior = S.hr.filter(x => x.horseId===r.horseId && x.id!==r.id && x.work===r.work && x.at < r.at);
  const avg = (k) => { const v = prior.map(x=>x[k]).filter(n=>n!==null && n!==undefined); return v.length>=2 ? v.reduce((a,b)=>a+b,0)/v.length : null; };
  const a10 = avg("bpm10"), a20 = avg("bpm20");
  const slow = (v,a) => v!==null && v!==undefined && a!==null && v > a*1.15 && v - a >= 6;
  const wk = (WORK[r.work]||r.work||"work").toLowerCase(), nm = hShort(horseById(r.horseId)) || r.horseName;
  if (slow(r.bpm20,a20) || slow(r.bpm10,a10))
    return {level:"slow", text:`Recovering slower than ${nm}'s usual for ${wk} (average ${a10!==null?Math.round(a10):"–"} at 10 min, ${a20!==null?Math.round(a20):"–"} at 20 min).`};
  if (a10===null && a20===null) return {level:"new", text:`Log a few more ${wk} sessions to see ${nm}'s normal recovery.`};
  return {level:"ok", text:`In line with ${nm}'s usual recovery.`};
}
const hasHr = (r) => r.bpm10 != null || r.bpm20 != null;
function hrRow(r, showHorse, delKey){
  const f = hrFlag(r);
  const pill = f.level==="slow" ? `<span class="pill p-possible">Slow recovery</span>` : f.level==="ok" ? `<span class="pill p-sound">Normal</span>` : "";
  return `<div class="hrrow">
    <div><span class="d mono">${esc(fmtDay(dayOf(r.at)))}</span>${showHorse?` · <b>${esc(hName(r.horseId, r.horseName))}</b>`:""} · ${esc(WORK[r.work]||r.work||"")} ${pill}</div>
    <div class="bpm mono" style="grid-template-columns:repeat(2,1fr)"><span><b>${r.bpm10 ?? "–"}</b><i>10 min</i></span><span><b>${r.bpm20 ?? "–"}</b><i>20 min</i></span></div>
    ${delKey?delBtn("hr", r.id, delKey):""}
  </div>`;
}
function renderHrRecent(){
  const list = S.hr.filter(hasHr);
  if (!$("hrRecent")) return;
  $("hrRecent").innerHTML = list.length ? list.slice(0,10).map(r=>hrRow(r,true)).join("")
    : `<p class="muted small" style="margin:0">No readings yet. Saved readings show here and on each horse's page.</p>`;
}
/* line chart over time: points [{d: ISO, v: number, s: seriesIndex}] */
function timeChart(series, { band, unit, colors = ["var(--accent)", "var(--ink)"], names = [] } = {}){
  const all = series.flat(); if (all.length < 2) return "";
  const W = 640, H = 190, pl = 40, pr = 12, pt = 12, pb = 26;
  const ts = all.map(p => +new Date(p.d)), t0 = Math.min(...ts), t1 = Math.max(...ts) || t0 + 1;
  let lo = Math.min(...all.map(p => p.v), band ? band[0] : Infinity), hi = Math.max(...all.map(p => p.v), band ? band[1] : -Infinity);
  const pad = (hi - lo) * 0.15 || 1; lo -= pad; hi += pad;
  const x = t => pl + (t - t0) / Math.max(1, t1 - t0) * (W - pl - pr), y = v => pt + (hi - v) / (hi - lo) * (H - pt - pb);
  const nt = 4, ticks = Array.from({length: nt + 1}, (_, i) => lo + (hi - lo) * i / nt);
  const dec = (hi - lo) < 5 ? 1 : 0;
  const days = Array.from({length: 4}, (_, i) => t0 + (t1 - t0) * i / 3);
  const lines = series.map((pts, si) => {
    const s = pts.slice().sort((a, b) => new Date(a.d) - new Date(b.d));
    return `<polyline fill="none" stroke="${colors[si]}" stroke-width="2.2" points="${s.map(p => `${x(+new Date(p.d)).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}"/>` +
      s.map((p, i) => `<circle cx="${x(+new Date(p.d)).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="${i === s.length-1 ? 4.5 : 3}" fill="${colors[si]}"><title>${esc(fmtDay(dayOf(p.d)))}: ${p.v}${unit||""}</title></circle>`).join("");
  }).join("");
  const legend = names.length ? `<p class="small muted" style="margin:0">${names.map((n, i) => `<span style="color:${colors[i]};font-weight:600">●</span> ${esc(n)}`).join("&nbsp;&nbsp;")}</p>` : "";
  return `<div style="overflow-x:auto"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Chart over time">
    ${band ? `<rect x="${pl}" y="${y(band[1])}" width="${W-pl-pr}" height="${y(band[0]) - y(band[1])}" fill="var(--ok-bg)"/>` : ""}
    ${ticks.map(v => `<line x1="${pl}" x2="${W-pr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pl-6}" y="${y(v)+4}" text-anchor="end" font-size="11" fill="var(--muted)" font-family="IBM Plex Mono, monospace">${v.toFixed(dec)}</text>`).join("")}
    ${days.map(t => `<text x="${x(t)}" y="${H-7}" text-anchor="middle" font-size="11" fill="var(--muted)">${new Date(t).toLocaleDateString("en-NZ",{day:"numeric",month:"short"})}</text>`).join("")}
    ${lines}</svg></div>${legend}`;
}

/* ================= temperature ================= */
async function saveTemp(e){
  e.preventDefault();
  const horse = horseById($("tHorse").value);
  if (!horse){ msg("tMsg","Choose a horse first.", false); return; }
  const tv = $("tTemp").value.trim().replace(",", "."), temp = Math.round(parseFloat(tv)*10)/10;
  if (!tv || isNaN(temp) || temp < 30 || temp > 45){ msg("tMsg","Enter the temperature in °C, e.g. 37.8.", false); return; }
  const rec = {horseId:horse.id, horseName:horse.name, at:dayAt($("tWhen").value), temp, createdAt:new Date().toISOString()};
  try{ await save("temps", uid("t"), rec); }catch(err){ msg("tMsg", saveErrMsg(err), false); return; }
  $("tTemp").value = "";
  msg("tMsg", `Saved for ${hShort(horse)}. ${tempFlag(temp).text}`, true);
}
/* Normal adult horse temperature is roughly 37.5–38.5 °C. */
function tempFlag(t){
  if (t === null || t === undefined) return null;
  if (t > 38.5) return {level:"high", text:`Temperature ${t}°C is above the normal 37.5–38.5°C. Recheck, and call the vet if it stays high.`};
  if (t < 37.0) return {level:"low", text:`Temperature ${t}°C is below normal. Recheck the reading.`};
  return {level:"ok", text:`Temperature ${t}°C is normal.`};
}
function allTemps(){ // new temps collection plus any temperatures saved with older heart-rate entries
  const legacy = S.hr.filter(r => r.temp != null).map(r => ({ id: r.id, horseId: r.horseId, horseName: r.horseName, at: r.at, temp: r.temp, _col: "hr" }));
  return [...S.temps.map(t => ({...t, _col: "temps"})), ...legacy].sort((a, b) => (b.at||"").localeCompare(a.at||""));
}
function tempRow(t, showHorse, delKey){
  const f = tempFlag(t.temp);
  const pill = f.level === "high" ? `<span class="pill p-lame">High</span>` : f.level === "low" ? `<span class="pill p-possible">Low</span>` : `<span class="pill p-sound">Normal</span>`;
  return `<div class="hrrow"><div><span class="d mono">${esc(fmtDay(dayOf(t.at)))}</span>${showHorse?` · <b>${esc(hName(t.horseId, t.horseName))}</b>`:""} ${pill}</div>
    <div class="bpm mono" style="grid-template-columns:1fr"><span><b>${t.temp}</b><i>°C</i></span></div>
    ${delKey && t._col === "temps" ? delBtn("temps", t.id, delKey) : ""}</div>`;
}
function renderTempRecent(){
  const list = allTemps();
  $("tRecent").innerHTML = list.length ? list.slice(0,10).map(t => tempRow(t, true)).join("")
    : `<p class="muted small" style="margin:0">No temperatures yet. Saved readings show here and as a graph on each horse's page.</p>`;
}

/* ================= generic delete buttons ================= */
function delBtn(col, id, key){ return `<div class="confirm" data-delwrap="${esc(key)}_${esc(col)}_${esc(id)}"><button class="link small" type="button" data-delcol="${esc(col)}" data-delid="${esc(id)}" data-delkey="${esc(key)}">Delete</button></div>`; }
function bindDeletes(root, key, after){
  root.querySelectorAll(`[data-delkey="${key}"]`).forEach(b => b.onclick = () => {
    const col = b.dataset.delcol, id = b.dataset.delid;
    confirmIn(root.querySelector(`[data-delwrap="${key}_${col}_${id}"]`), "Delete this entry?", async () => {
      try{
        await remove(col, id);
        if (col === "diary") for (const r of S.hr.filter(r => r.diaryId === id)) await remove("hr", r.id);   // heart rate saved with that diary entry
      }catch(err){ alertBox("storeNote", saveErrMsg(err)); }
    }, after);
  });
}

/* ================= video ================= */
function clipDuration(){ const d = $("video").duration; return isFinite(d) ? d : 0; }
function segWindow(){
  const dur = clipDuration(), lenSel = $("segLen").value;
  if (lenSel === "all" || !dur){ const st = dur > 45 ? Math.min(S.segStart, dur - 45) : 0; return {start: st, len: Math.min(dur, 45)}; }
  const len = Math.min(+lenSel, dur);
  return {start:Math.min(S.segStart, Math.max(0, dur - len)), len};
}
function updateSegInfo(){
  const {start,len} = segWindow(), d = clipDuration();
  $("segInfo").innerHTML = d
    ? `Using <span class="mono">${start.toFixed(1)}s – ${(start+len).toFixed(1)}s</span> of a <span class="mono">${d.toFixed(1)}s</span> clip · <span class="mono">${(S.file.size/1048576).toFixed(0)} MB</span>`
    : "Loading video…";
}
function loadVideo(f){
  alertBox("videoErr",""); S.file = f; S.segStart = 0;
  const v = $("video");
  if (v.src) URL.revokeObjectURL(v.src);
  v.src = URL.createObjectURL(f);
  $("videoBox").hidden = false;
  $("drop").querySelector("strong").textContent = "Choose a different video";
  v.onloadedmetadata = () => {
    const d = clipDuration();
    S.box = null;
    updateSegInfo(); updateAnalyseBtn(); drawPicker(true);
  };
  v.onerror = () => {
    S.file = null; updateAnalyseBtn(); $("videoBox").hidden = true;
    alertBox("videoErr","This browser can't play that video. On iPhone, try Settings › Camera › Formats › Most Compatible, or open this page in Safari.");
  };
  updateSegInfo(); updateAnalyseBtn();
}
/* ---- horse box picker (drag a box on the first frame) ---- */
async function drawPicker(reseek){
  const v = $("video"), c = $("picker");
  if (!S.file || !v.videoWidth) return;
  if (reseek){ await seekTo(v, segWindow().start + 0.05); }
  c.width = v.videoWidth; c.height = v.videoHeight;
  const g = c.getContext("2d"); g.drawImage(v, 0, 0);
  const b = S.box;
  if (b){
    g.fillStyle = "rgba(0,0,0,.45)"; g.fillRect(0,0,c.width,c.height);
    g.drawImage(v, b.x, b.y, b.w, b.h, b.x, b.y, b.w, b.h);
    g.strokeStyle = "#00e5ff"; g.lineWidth = Math.max(3, c.width/300); g.strokeRect(b.x, b.y, b.w, b.h);
  } else {
    g.fillStyle = "rgba(0,0,0,.35)"; g.fillRect(0, c.height - c.height*0.12, c.width, c.height*0.12);
    g.fillStyle = "#fff"; g.font = `600 ${Math.round(c.height*0.05)}px sans-serif`; g.textAlign = "center";
    g.fillText("Drag a box around the horse", c.width/2, c.height - c.height*0.04);
  }
}
function bindPicker(){
  const c = $("picker"); let start = null;
  const pt = (e) => { const r = c.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * c.width, y: (e.clientY - r.top) / r.height * c.height }; };
  c.addEventListener("pointerdown", e => { if (!S.file) return; c.setPointerCapture(e.pointerId); start = pt(e); });
  c.addEventListener("pointermove", e => { if (!start) return; const p = pt(e);
    S.box = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) }; drawPicker(false); });
  c.addEventListener("pointerup", () => { start = null; if (S.box && (S.box.w < 20 || S.box.h < 20)) S.box = null; drawPicker(false); updateAnalyseBtn(); });
}
function traceSVG(part, fps, color){
  if (!part?.ok || !part.trace) return "";
  const idx = part.trace.map((v, i) => v === null ? -1 : i).filter(i => i >= 0);
  if (idx.length < 10) return "";
  const i0 = idx[0], i1 = idx[idx.length-1], vals = idx.map(i => part.trace[i]);
  const lim = Math.max(10, Math.ceil(Math.max(...vals.map(Math.abs)) / 10) * 10);
  const W = 640, H = 150, pl = 36, pr = 8, pt = 8, pb = 22;
  const x = i => pl + (i - i0) / Math.max(1, i1 - i0) * (W - pl - pr), y = v => pt + (lim - v) / (2*lim) * (H - pt - pb);
  let d = "", pen = false;
  for (let i = i0; i <= i1; i++){ const v = part.trace[i]; if (v === null){ pen = false; continue; } d += (pen ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1); pen = true; }
  const dots = (part.steps||[]).map(s => part.trace[s.i] === null ? "" : `<circle cx="${x(s.i).toFixed(1)}" cy="${y(part.trace[s.i]).toFixed(1)}" r="4.5" fill="${s.side === "L" ? "#2563eb" : "#ea580c"}"/>`).join("");
  const secs = (i1 - i0) / fps, ticks = [];
  for (let t = 0; t <= secs; t += Math.max(1, Math.round(secs/6))) ticks.push(t);
  return `<div style="overflow-x:auto"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Vertical movement trace">
    ${[-lim, 0, lim].map(v => `<line x1="${pl}" x2="${W-pr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pl-5}" y="${y(v)+4}" text-anchor="end" font-size="11" fill="var(--muted)" font-family="IBM Plex Mono, monospace">${v}</text>`).join("")}
    ${ticks.map(t => `<text x="${x(i0 + t*fps)}" y="${H-5}" text-anchor="middle" font-size="11" fill="var(--muted)">${t}s</text>`).join("")}
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>${dots}</svg></div>`;
}
function metricsHTML(m){
  if (!m) return "";
  const f = (n) => Number.isFinite(n) ? (n > 0 ? "+" : "") + n.toFixed(1) : "–";
  const row = (name, p, thr) => p?.ok ? `<tr><td>${name}</td><td class="mono">${f(p.minDiff.mean)}</td><td class="mono">${f(p.maxDiff.mean)}</td><td class="mono">${p.strides}</td><td class="mono">${Math.round((p.minDiff.agree||0)*100)}%</td></tr>`
    : `<tr><td>${name}</td><td colspan="4" class="muted">Not measured: ${esc(p?.reason || "no footage from this angle")}</td></tr>`;
  return `<div><h3 style="margin-bottom:6px">Measurements</h3>
    <div style="overflow-x:auto"><table class="mtable"><thead><tr><th></th><th>MinDiff</th><th>MaxDiff</th><th>Strides</th><th>Consistent</th></tr></thead>
    <tbody>${row("Head (front legs)", m.head)}${row("Pelvis (hind legs)", m.pelvis)}
    ${m.hips?.ok ? `<tr><td>Hip hike</td><td colspan="4" class="mono">${f(m.hips.diff)} mm (left minus right hip travel)</td></tr>` : ""}</tbody></table></div>
    <p class="small muted" style="margin:6px 0 0">Approximate millimetres. + means the left side sits higher. As a guide, measuring systems start to flag about 6 mm for the head and 3 mm for the pelvis. Blue dots are left-leg steps, orange are right.</p>
    ${m.head?.ok ? `<p class="small" style="margin:10px 0 2px"><b>Head</b> (jogging towards)</p>${traceSVG(m.head, m.fps, "var(--accent)")}` : ""}
    ${m.pelvis?.ok ? `<p class="small" style="margin:10px 0 2px"><b>Pelvis</b> (jogging away)</p>${traceSVG(m.pelvis, m.fps, "var(--ink)")}` : ""}
  </div>`;
}

/* ---- measure movement ---- */
async function measure(){
  const horse = S.horses.find(h => h.id === $("horseSel").value);
  if (!horse || !S.file || !S.box || !window.Measure) return;
  alertBox("checkError",""); $("reportOut").innerHTML = ""; $("stripBox").hidden = true;
  $("measureBtn").disabled = true; $("analyseBtn").disabled = true; $("status").hidden = false;
  const tv = $("trackView"); tv.hidden = false;
  const t0 = Date.now(); let stage = "";
  const show = () => { $("statusText").textContent = `${stage} (${Math.round((Date.now()-t0)/1000)}s)`; };
  const setStatus = (t, p) => { stage = t; show(); if (p !== undefined){ $("progBar").hidden = false; $("progFill").style.width = Math.round(p*100) + "%"; } };
  const ticker = setInterval(show, 1000);
  S.ctl = new AbortController();
  const v = $("video"), win = segWindow(), fps = 25;
  try{
    setStatus("Getting the tracking model ready…", 0);
    const snaps = [];
    const frames = await Measure.track({ video: v, start: win.start, end: win.start + win.len, box: S.box, fps, signal: S.ctl.signal,
      onStatus: (t, p) => setStatus(t, p ?? 0),
      onFrame: ({ i, n, kp, box, eta, ep }) => {
        tv.width = Math.min(960, v.videoWidth); tv.height = Math.round(tv.width * v.videoHeight / v.videoWidth);
        const g = tv.getContext("2d"), k = tv.width / v.videoWidth; g.setTransform(1,0,0,1,0,0); g.drawImage(v, 0, 0, tv.width, tv.height);
        g.setTransform(k,0,0,k,0,0); Measure.draw(g, kp, box); g.setTransform(1,0,0,1,0,0);
        if (i === 1 || i === Math.round(n/3) || i === Math.round(2*n/3) || i === n) snaps.push(thumbFromCanvas(tv));
        setStatus(`Tracking the horse… frame ${i} of ${n}, about ${eta}s to go${ep === "webgpu" ? "" : " (slower mode on this device)"}`, i/n);
      } });
    setStatus("Measuring the strides…");
    const a = Measure.analyse(frames, { fps, direction: $("mDir").value });
    const result = Measure.report(a, horse.gait);
    const pick = (p) => p?.ok ? { ok: true, minDiff: p.minDiff, maxDiff: p.maxDiff, strides: p.strides, seconds: p.seconds, stepMs: p.stepMs, sideCheck: p.sideCheck, trace: p.trace, steps: p.steps } : { ok: false, reason: p?.reason || "", seconds: p?.seconds || 0 };
    const metrics = { fps, head: pick(a.parts.head), pelvis: pick(a.parts.pelvis), hips: a.parts.hips, meanConf: +a.meanConf.toFixed(2), away: +a.counts.away.toFixed(1), towards: +a.counts.towards.toFixed(1) };
    const check = {
      horseId: horse.id, horseName: horse.name, horseGait: horse.gait,
      footage: $("footage").value, pace: $("pace").value, lungeDir: $("lungeDir").value, surface: $("surface").value,
      notes: $("notes").value.trim(), clipName: (S.file.name||"").slice(0,120),
      window: {start:+win.start.toFixed(2), len:+win.len.toFixed(2)}, mode: "measure", frameCount: frames.length, model: "rtmpose-ap10k",
      createdAt: new Date().toISOString(), result, metrics, thumbs: snaps.slice(0,4),
    };
    $("reportOut").innerHTML = reportHTML(check);
    try{ await save("checks", uid("c"), check); addSaved(`Saved to ${hShort(horse)}'s history.`); }
    catch(err){ addSaved(saveErrMsg(err) + " (The traces may be too long to save; try a shorter section.)"); }
    $("notes").value = "";
    $("reportOut").scrollIntoView({behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block:"start"});
  }catch(e){
    if (e?.name !== "AbortError") alertBox("checkError", e?.message || "Something went wrong while measuring. Try again.");
  }finally{
    clearInterval(ticker); tv.hidden = true; $("progBar").hidden = true;
    $("status").hidden = true; updateAnalyseBtn();
  }
}
function thumbFromCanvas(c, w = 240){ const t = document.createElement("canvas"); t.width = w; t.height = Math.round(c.height * w / c.width); t.getContext("2d").drawImage(c, 0, 0, t.width, t.height); return t.toDataURL("image/jpeg", 0.7); }

function seekTo(v, t){
  return new Promise(res => { let done=false; const fin=()=>{ if(!done){done=true;res();} };
    v.addEventListener("seeked", fin, {once:true}); setTimeout(fin, 4000); v.currentTime = Math.max(0,t); });
}
function drawFrame(v, W, H, label){
  const c = document.createElement("canvas"); c.width=W; c.height=H;
  const g = c.getContext("2d"); g.drawImage(v,0,0,W,H);
  if (label){
    const fs = Math.round(H*0.045)+8; g.font = `600 ${fs}px monospace`;
    const tw = g.measureText(label).width;
    g.fillStyle="rgba(0,0,0,.7)"; g.fillRect(0,0,tw+16,fs+10);
    g.fillStyle="#fff"; g.textBaseline="top"; g.fillText(label,8,5);
  }
  return c;
}
async function grabFrames(n, longSide, labelled, onProg){
  const v = $("video");
  try { await v.play(); v.pause(); } catch(_){}
  const {start, len} = segWindow();
  const vw = v.videoWidth || 1280, vh = v.videoHeight || 720;
  const k = Math.min(1, longSide/Math.max(vw,vh)); const W = Math.round(vw*k), H = Math.round(vh*k);
  const out = [];
  for (let i=0;i<n;i++){
    const t = start + len*(i+0.5)/n; onProg?.(i+1,n);
    await seekTo(v,t);
    out.push({c: drawFrame(v,W,H, labelled ? `F${i+1}  ${t.toFixed(2)}s` : ""), t, n:i+1});
  }
  return out;
}
const toBlob = (c,q) => new Promise(r => c.toBlob(b => r(b), "image/jpeg", q));
function thumb(src, w=240){
  const c = document.createElement("canvas"); const k = w/src.width;
  c.width = w; c.height = Math.round(src.height*k);
  c.getContext("2d").drawImage(src,0,0,c.width,c.height);
  return c.toDataURL("image/jpeg",0.7);
}
const b64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });
function videoMime(f){
  const t = (f.type||"").toLowerCase(), n = (f.name||"").toLowerCase();
  if (t.includes("quicktime") || n.endsWith(".mov")) return "video/mov";
  if (t.startsWith("video/")) return t;
  if (n.endsWith(".webm")) return "video/webm";
  if (n.endsWith(".3gp")) return "video/3gpp";
  return "video/mp4";
}

/* ================= Gemini ================= */
async function apiErrText(r){
  let j = null; try { j = await r.json(); } catch(_){}
  const m = j?.error?.message || r.statusText;
  if (r.status === 429) return "The free Gemini limit has been reached for now. Wait a minute and try again (or try tomorrow if it keeps happening).";
  if (r.status === 503 || r.status === 500) return "Google's free AI is very busy right now. Wait a few minutes and try again.";
  if (r.status === 400 && /API key/i.test(m)) return "The Gemini API key isn't valid. Check it in Settings.";
  if (r.status === 403) return "Google refused the request. If you restricted the key, check that this web address is allowed (setup guide, step 5). Details: " + m;
  return `Gemini error ${r.status}: ${m}`;
}
async function listModels(key){
  const r = await fetch(`${GEMINI}/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`);
  if (!r.ok) throw new Error(await apiErrText(r));
  const names = ((await r.json()).models||[]).filter(m => (m.supportedGenerationMethods||[]).includes("generateContent"))
    .map(m => m.name.replace("models/","")).filter(n => /^gemini-[\d.]+-flash/.test(n) && !/(image|tts|live|audio|thinking-exp)/.test(n));
  const ver = (n) => parseFloat(n.split("-")[1]) || 0;
  names.sort((a,b) => (/lite/.test(a) - /lite/.test(b)) || (ver(b) - ver(a)));
  return names;
}
/* Ask Gemini. If a model is busy (503/500) it retries once, then moves on to the next free Flash model. */
async function generate(parts, signal, onStatus){
  const key = S.settings.geminiKey;
  // Keep "thinking" short so answers come back quickly.
  const bodyFor = (m, plain) => {
    const gc = { responseMimeType:"application/json", temperature:0.2 };
    if (!plain && /^gemini-3/.test(m)) gc.thinkingConfig = { thinkingLevel:"low" };
    else if (!plain && /^gemini-2\.5-flash/.test(m)) gc.thinkingConfig = { thinkingBudget:1024 };
    return JSON.stringify({ contents:[{role:"user", parts}], generationConfig:gc });
  };
  // Each try gives up after 2 minutes and moves on, so the app never hangs.
  const call = async (m, plain) => {
    const ctl = new AbortController(); const stop = () => ctl.abort();
    signal.addEventListener("abort", stop);
    const timer = setTimeout(stop, 120000);
    try { return await fetch(`${GEMINI}/v1beta/models/${m}:generateContent?key=${encodeURIComponent(key)}`, {method:"POST", headers:{"Content-Type":"application/json"}, body: bodyFor(m, plain), signal: ctl.signal}); }
    catch(e){ if (signal.aborted) throw {name:"AbortError"}; return {ok:false, status:504, timedOut:true}; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", stop); }
  };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const models = [S.settings.model || DEFAULT_MODEL];
  let listed = false, lastBusy = false;
  for (let i = 0; i < models.length || !listed; i++){
    if (i >= models.length){
      listed = true;
      try { (await listModels(key)).forEach(m => { if (!models.includes(m) && models.length < 5) models.push(m); }); } catch(_){}
      if (i >= models.length) break;
    }
    const model = models[i];
    let plain = false;
    for (let attempt = 0; attempt < 2; attempt++){
      if (signal.aborted) throw {name:"AbortError"};
      const r = await call(model, plain);
      if (r.status === 400 && !plain){
        const t = await r.clone().text().catch(() => "");
        if (/thinking/i.test(t)){ plain = true; attempt--; continue; }
      }
      if (r.ok){
        const j = await r.json();
        const cand = j.candidates?.[0];
        if (!cand) throw new Error(j.promptFeedback?.blockReason ? "Gemini declined to analyse this clip. Try a different section." : "Gemini returned no answer. Try again.");
        const text = (cand.content?.parts||[]).filter(p => !p.thought && p.text).map(p => p.text).join("");
        return {json: parseJSON(text), model};
      }
      if (r.status === 404) break;                                   // model not available: try the next one
      if (r.status === 429){ lastBusy = true; break; }               // this model's free limit is used up: try the next one
      if (r.status === 500 || r.status === 503 || r.status === 504){ // busy: wait, retry once, then move on
        lastBusy = true;
        onStatus?.(r.timedOut ? "That took too long. Trying a backup AI model\u2026" : attempt === 0 ? "Google's AI is busy. Trying again in a few seconds\u2026" : "Still busy. Trying a backup AI model\u2026");
        if (r.timedOut) break;
        if (attempt === 0) await wait(5000);
        continue;
      }
      throw new Error(await apiErrText(r));
    }
  }
  throw new Error(lastBusy
    ? "Google's free AI is very busy right now. Wait a few minutes, then tap Analyse gait again."
    : "No suitable Gemini model is available on this key. Check Settings.");
}
function parseJSON(t){
  try { return JSON.parse(t); } catch(_){}
  const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch(_){} }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a,b+1)); } catch(_){} }
  throw new Error("The AI's answer came back in the wrong shape. Tap Analyse gait to try again.");
}
/* Upload a large video with Gemini's Files API (resumable upload). */
async function uploadVideo(file, mime, signal, onProg){
  const key = encodeURIComponent(S.settings.geminiKey);
  const start = await fetch(`${GEMINI}/upload/v1beta/files?key=${key}`, { method:"POST", signal, headers:{
    "X-Goog-Upload-Protocol":"resumable", "X-Goog-Upload-Command":"start",
    "X-Goog-Upload-Header-Content-Length":String(file.size), "X-Goog-Upload-Header-Content-Type":mime, "Content-Type":"application/json"},
    body: JSON.stringify({file:{display_name:(file.name||"clip").slice(0,100)}}) });
  if (!start.ok) throw new Error(await apiErrText(start));
  const url = start.headers.get("x-goog-upload-url");
  if (!url) throw new Error("upload-url-hidden");
  const info = await new Promise((res, rej) => {
    const x = new XMLHttpRequest(); x.open("POST", url);
    x.setRequestHeader("X-Goog-Upload-Offset","0"); x.setRequestHeader("X-Goog-Upload-Command","upload, finalize");
    x.upload.onprogress = (e) => e.lengthComputable && onProg?.(e.loaded/e.total);
    x.onload = () => { try { x.status < 300 ? res(JSON.parse(x.responseText).file) : rej(new Error("Upload failed ("+x.status+")")); } catch(e){ rej(e); } };
    x.onerror = () => rej(new Error("Upload failed. Check your connection."));
    signal.addEventListener("abort", () => { x.abort(); rej({name:"AbortError"}); });
    x.send(file);
  });
  let f = info;
  for (let i=0; i<90 && f.state === "PROCESSING"; i++){
    await new Promise(r => setTimeout(r, 2000));
    if (signal.aborted) throw {name:"AbortError"};
    const r = await fetch(`${GEMINI}/v1beta/${f.name}?key=${key}`, {signal});
    if (!r.ok) throw new Error(await apiErrText(r));
    f = await r.json();
  }
  if (f.state !== "ACTIVE") throw new Error("Google couldn't process this video. Try a shorter or smaller clip.");
  return f;
}
const dropUploaded = (f) => { if (f?.name) fetch(`${GEMINI}/v1beta/${f.name}?key=${encodeURIComponent(S.settings.geminiKey)}`, {method:"DELETE"}).catch(()=>{}); };

/* ================= prompt ================= */
function buildPrompt(horse, mode, win, nFrames){
  const footage = $("footage").value, pace = $("pace").value, dir = $("lungeDir").value, surf = $("surface").value;
  const notes = $("notes").value.trim();
  const prev = S.checks.filter(c => c.horseId===horse.id).slice(0,2).map(c =>
    `- ${c.createdAt?.slice(0,10)} (${FOOTAGE[c.footage]||c.footage}): ${c.result?.verdict}, grade ${c.result?.grade ?? "n/a"}; ` +
    (c.result?.limbs||[]).filter(l=>l.level!=="none").map(l=>`${l.limb} ${l.level}`).join(", ") + `. ${c.result?.summary||""}`).join("\n");
  const since = new Date(Date.now() - 3*864e5).toISOString();
  const hrs = S.hr.filter(r => r.horseId===horse.id && r.at >= since).slice(0,3).map(r =>
    `- ${dayOf(r.at)} ${WORK[r.work]||r.work}: ${r.bpm10 ?? "?"} bpm at 10 min, ${r.bpm20 ?? "?"} at 20 min. ${hasHr(r) ? hrFlag(r).text : ""}`).join("\n");
  const wk7 = addDays(todayStr(), -7);
  const work = S.diary.filter(e => e.horseId===horse.id && e.date >= wk7).slice(0,10).map(e =>
    `- ${e.date} ${DTYPE[e.type]||e.type}${e.distance ? ": " + e.distance : ""}${e.fullTime ? "; full time " + e.fullTime : ""}${e.time800 ? "; 800 m " + e.time800 : ""}${e.times ? "; " + e.times : ""}${e.type==="farrier" ? `; ${SHOEWORK[e.shoeWork]||""} ${e.shoeType||""}` : ""}${e.notes ? "; " + e.notes : ""}`).join("\n");
  const gaitNote = horse.gait === "trotter"
    ? "This horse is a TROTTER (diagonal gait: LF+RH land together, RF+LH land together)."
    : "This horse is a PACER (lateral gait: LF+LH land together, RF+RH land together). In the pace the classic head nod is harder to read because a fore and hind on the SAME side bear weight together; lean more on hip/pelvic movement, stride length, fetlock drop, and head/neck movement relative to each lateral pair. Also note if the horse breaks gait.";
  const media = mode === "frames"
    ? `You are given ${nFrames} still frames evenly spaced from ${win.start.toFixed(2)}s to ${(win.start+win.len).toFixed(2)}s of the video (about ${(win.len/Math.max(nFrames-1,1)).toFixed(2)}s apart). Each frame has its number and timestamp printed in its top-left corner. Stills lose timing, so be cautious. In "observations", set "when" to frame numbers like "F3–F6".`
    : `You are given the video, limited to the section from ${win.start.toFixed(1)}s to ${(win.start+win.len).toFixed(1)}s. Watch the movement through several strides. In "observations", set "when" to timestamps within the video like "0:12–0:14".`;
  return `You are an experienced equine veterinarian specialising in lameness in Standardbred harness racing horses. Assess this horse for lameness from phone footage.

HORSE: race name ${horse.name}${horse.stableName ? ` (stable name ${horse.stableName})` : ""}. ${gaitNote}${horse.notes ? " Owner notes about the horse: " + horse.notes : ""}
CAMERA VIEW: ${FOOTAGE[footage]}. PACE: ${pace}.${dir ? " LUNGING ON THE " + dir.toUpperCase() + " REIN." : ""} SURFACE: ${surf}.
FOOTAGE: ${media}
${notes ? "OWNER'S OBSERVATIONS TODAY: " + notes : "No owner observations given."}
${prev ? "PREVIOUS CHECKS ON THIS HORSE (for comparison; do not assume they are still true):\n" + prev : ""}
${work ? "WORK DIARY, LAST 7 DAYS (context only):\n" + work : ""}
${hrs ? "HEART RATE AND TEMPERATURE IN THE LAST 3 DAYS (context only; mention it if a slow recovery or a raised temperature supports or adds to concern):\n" + hrs : ""}

How to assess:
1. Work out which limbs are in stance (weight-bearing) at each moment, and identify the gait actually shown.
2. Forelimbs: the head/poll rises when the lame fore bears weight and drops when the sound fore lands ("down on sound"). Compare head movement across equivalent stance phases of left vs right.
3. Hindlimbs: look for hip hike / pelvic asymmetry (the tuber coxae on the lame side travels further up and down), a shorter cranial phase of stride, and reduced fetlock extension on the lame hind.
4. Also look at fetlock drop, stride length, foot placement and flight (winging, plaiting, interference), toe-dragging, and uneven loading.
5. Use the horse's own left and right, not the viewer's. When the horse moves away from the camera, its left is on the viewer's left; when it comes towards the camera, its left is on the viewer's right. Side-on: identify which side of the horse faces the camera before naming limbs.
6. Be honest about uncertainty. If the footage cannot support a judgement (blurry, too far away, legs cut off, horse turning, handler blocking, inconsistent pace), say "unclear" rather than guess.
7. Grade using the AAEP 0–5 scale (0 sound; 1 hard to see, inconsistent; 2 hard to see at a walk/straight line but consistent in some circumstances; 3 consistently seen at the trot; 4 obvious at the walk; 5 minimal weight bearing). Use null if unclear.
8. Write for a horse owner/trainer in plain New Zealand English. Next steps should be practical things the stable can do (feel for heat and digital pulse, hoof testers, check shoes, re-film a specific view), and say when to call the vet. Any grade of 3 or more, or signs of severe pain, means recommend calling the vet promptly.

Reply with ONLY a JSON object in exactly this shape:
{"verdict":"sound|possible|lame|unclear","grade":0-5 or null,"confidence":"low|medium|high","gait_seen":"walk|trot|pace|gallop|mixed|unclear","summary":"2-3 plain sentences","limbs":[{"limb":"LF","level":"none|watch|suspect|likely","reason":"short evidence"},{"limb":"RF","level":"...","reason":"..."},{"limb":"LH","level":"...","reason":"..."},{"limb":"RH","level":"...","reason":"..."}],"observations":[{"when":"...","note":"what you saw"}],"footage":{"rating":"good|fair|poor","issues":["..."]},"next_steps":["..."],"refilm_tips":["..."]}
Always include all four limbs. Keep observations to at most 6 items.`;
}

/* ================= analyse ================= */
async function analyse(){
  const horse = S.horses.find(h => h.id === $("horseSel").value);
  if (!horse || !S.file || !S.settings.geminiKey) return;
  alertBox("checkError",""); $("reportOut").innerHTML = ""; $("stripBox").hidden = true;
  $("analyseBtn").disabled = true; $("status").hidden = false; $("progBar").hidden = true;
  const t0 = Date.now(); let stage = "";
  const showStatus = () => { $("statusText").textContent = `${stage} (${Math.round((Date.now()-t0)/1000)}s)`; };
  const setStatus = (t) => { stage = t; showStatus(); };
  const ticker = setInterval(showStatus, 1000);
  const setProg = (p) => { $("progBar").hidden = p === null; $("progFill").style.width = Math.round((p||0)*100) + "%"; };
  S.ctl = new AbortController(); const signal = S.ctl.signal;
  const win = segWindow(); const mime = videoMime(S.file);
  let uploaded = null;
  try{
    setStatus("Taking snapshots for the record…");
    const snaps = await grabFrames(4, 480, false);
    const thumbs = snaps.map(s => thumb(s.c));
    const vm = { startOffset: win.start.toFixed(2)+"s", endOffset: (win.start+win.len).toFixed(2)+"s", fps: win.len <= 6 ? 6 : win.len <= 10 ? 4 : 2 };
    let mode = "video", parts, nFrames = 0;
    if (S.file.size <= INLINE_MAX){
      setStatus("Preparing the video…");
      parts = [{ inlineData:{ mimeType:mime, data: await b64(S.file) }, videoMetadata: vm }];
    } else {
      try{
        setStatus(`Uploading the video (${(S.file.size/1048576).toFixed(0)} MB)…`); setProg(0);
        uploaded = await uploadVideo(S.file, mime, signal, (p) => { setProg(p); if (p >= 1) setStatus("Google is processing the video…"); });
        setProg(null);
        parts = [{ fileData:{ mimeType: uploaded.mimeType || mime, fileUri: uploaded.uri }, videoMetadata: vm }];
      }catch(err){
        if (err?.name === "AbortError") throw err;
        mode = "frames"; setProg(null);   // fall back to still frames
      }
    }
    if (mode === "frames"){
      nFrames = 16;
      const frames = await grabFrames(nFrames, 1024, true, (i,n) => setStatus(`Pulling frames from the video… ${i}/${n}`));
      $("strip").innerHTML = frames.map(f => `<img src="${thumb(f.c,200)}" alt="Frame ${f.n}">`).join("");
      $("stripLabel").textContent = "Frames sent for analysis"; $("stripBox").hidden = false;
      parts = [];
      for (const f of frames) parts.push({ inlineData:{ mimeType:"image/jpeg", data: await b64(await toBlob(f.c, 0.85)) } });
    }
    if (signal.aborted) throw {name:"AbortError"};
    parts.push({ text: buildPrompt(horse, mode, win, nFrames) });
    setStatus("The AI is watching the horse move\u2026 usually 20\u201360 seconds");
    const {json, model} = await generate(parts, signal, setStatus);
    const check = {
      horseId: horse.id, horseName: horse.name, horseGait: horse.gait,
      footage: $("footage").value, pace: $("pace").value, lungeDir: $("lungeDir").value, surface: $("surface").value,
      notes: $("notes").value.trim(), clipName: (S.file.name||"").slice(0,120),
      window: {start:+win.start.toFixed(2), len:+win.len.toFixed(2)}, mode, frameCount: nFrames, model,
      createdAt: new Date().toISOString(), result: normalise(json), thumbs,
    };
    $("reportOut").innerHTML = reportHTML(check);
    try{ await save("checks", uid("c"), check); addSaved(`Saved to ${hShort(horse)}'s history.`); }
    catch(err){ addSaved(saveErrMsg(err)); }
    $("notes").value = "";
    $("reportOut").scrollIntoView({behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block:"start"});
  }catch(e){
    if (e?.name !== "AbortError") alertBox("checkError", e?.message || "Something went wrong. Tap Analyse gait to try again.");
  }finally{
    clearInterval(ticker);
    dropUploaded(uploaded);
    $("status").hidden = true; updateAnalyseBtn();
  }
}
function addSaved(t){ const p = document.createElement("p"); p.className="small muted"; p.style.margin="0"; p.textContent=t; $("reportOut").querySelector(".report")?.prepend(p); }
function normalise(r){
  r = (r && typeof r === "object") ? r : {};
  const lv = (x) => ["none","watch","suspect","likely"].includes(x) ? x : "none";
  const byLimb = {}; (Array.isArray(r.limbs)?r.limbs:[]).forEach(l => { if (l && LIMBS[l.limb]) byLimb[l.limb] = {limb:l.limb, level:lv(l.level), reason:String(l.reason||"").slice(0,400)}; });
  const g = Number(r.grade);
  const arr = (a, n, len) => (Array.isArray(a)?a:[]).slice(0,n).map(s=>String(s).slice(0,len));
  return {
    verdict: ["sound","possible","lame","unclear"].includes(r.verdict) ? r.verdict : "unclear",
    grade: r.grade === null || r.grade === undefined || r.grade === "" || isNaN(g) ? null : Math.max(0, Math.min(5, Math.round(g))),
    confidence: ["low","medium","high"].includes(r.confidence) ? r.confidence : "low",
    gait_seen: String(r.gait_seen||"unclear").slice(0,20),
    summary: String(r.summary||"").slice(0,1200),
    limbs: Object.keys(LIMBS).map(k => byLimb[k] || {limb:k, level:"none", reason:""}),
    observations: (Array.isArray(r.observations)?r.observations:[]).slice(0,8).map(o => ({when:String(o?.when||o?.frames||"").slice(0,30), note:String(o?.note||"").slice(0,500)})),
    footage: {rating: ["good","fair","poor"].includes(r.footage?.rating) ? r.footage.rating : "fair", issues: arr(r.footage?.issues,6,300)},
    next_steps: arr(r.next_steps,8,400), refilm_tips: arr(r.refilm_tips,6,300)
  };
}

/* ================= report ================= */
const EXAMPLE = {
  horseName:"Example horse", footage:"inhand_straight", createdAt:"2026-09-20T08:30:00Z", example:true, mode:"video", window:{start:4,len:6},
  result:{ verdict:"possible", grade:2, confidence:"medium", gait_seen:"trot",
    summary:"A mild, consistent head lift as the right fore lands, most visible jogging towards the camera. The left fore and both hinds look even across the strides seen.",
    limbs:[ {limb:"LF",level:"none",reason:"Head drops normally as this leg lands."},
      {limb:"RF",level:"suspect",reason:"Head rises as this leg bears weight in most strides; slightly shorter stride."},
      {limb:"LH",level:"none",reason:"Hip travel looks even."},
      {limb:"RH",level:"watch",reason:"Possible small hip hike on two strides, but could be the turn."} ],
    observations:[ {when:"0:05–0:07",note:"Head is highest when the right fore is on the ground; lowest when the left fore lands."},
      {when:"0:08",note:"Right fore stride looks a little shorter than the left."} ],
    footage:{rating:"fair",issues:["Horse drifts left of the camera line on the way back."]},
    next_steps:["Check the right fore foot for heat and a digital pulse, and hoof-test it.","Re-film on a hard surface tomorrow; call the vet if the head lift is still there."],
    refilm_tips:["Stand directly in line with the horse's path."] }
};
function fmtDate(iso){ try{ return new Date(iso).toLocaleString("en-NZ",{day:"numeric",month:"short",year:"numeric",hour:"numeric",minute:"2-digit"}); }catch(_){ return iso; } }
function limbCell(l){ return `<div class="limb l-${l.level}"><span class="code">${l.limb}</span><span class="lvl">${LEVEL[l.level]}</span>${l.reason?`<span class="why">${esc(l.reason)}</span>`:""}</div>`; }
function reportHTML(c, opts={}){
  const r = c.result; const L = Object.fromEntries(r.limbs.map(l=>[l.limb,l]));
  const src = c.mode === "frames" ? `${c.frameCount} still frames` : c.mode === "measure" ? `measured · ${c.frameCount} frames` : "AI opinion";
  const win = c.window ? ` · ${c.window.start}s–${(c.window.start+c.window.len).toFixed(1)}s` : "";
  return `<div class="report card${c.example?" is-example":""}">
    ${c.example ? `<div><span class="pill p-example">Example report</span> <span class="small muted">What a result looks like. Not one of your horses.</span></div>` : ""}
    <div><h2>${esc(c.horseId ? hName(c.horseId, c.horseName) : c.horseName)}</h2>
      <div class="meta"><span>${fmtDate(c.createdAt)}</span><span>${esc(FOOTAGE[c.footage]||c.footage)}</span><span class="mono">${src}${win}</span></div></div>
    <div class="verdict v-${r.verdict}">
      <span class="big">${VERDICT[r.verdict]}</span>
      <span>${esc(r.summary)}</span>
      <span class="small muted">Confidence: ${esc(r.confidence)} · Gait seen: ${esc(r.gait_seen)} · Footage: ${esc(r.footage.rating)}</span>
    </div>
    ${c.mode === "measure" ? "" : `<div><p class="small muted" style="margin:0 0 6px">AAEP lameness grade${r.grade===null?": not enough to grade":""}</p>
      <div class="scale">${[0,1,2,3,4,5].map(n=>`<div class="${r.grade===n?"on":""}">${n}</div>`).join("")}</div></div>`}
    <div><p class="small muted" style="margin:0 0 6px">Legs, from the horse's point of view</p>
      <div class="limbs"><span></span><span class="hd">Left</span><span class="hd">Right</span>
        <span class="rh">Front</span>${limbCell(L.LF)}${limbCell(L.RF)}
        <span class="rh">Hind</span>${limbCell(L.LH)}${limbCell(L.RH)}</div></div>
    ${c.mode === "measure" ? metricsHTML(c.metrics) : ""}
    ${r.observations.length && c.mode !== "measure" ?`<div><h3 style="margin-bottom:8px">What the AI saw</h3><ul class="obs">${r.observations.map(o=>`<li><span class="fr">${esc(o.when)}</span><span>${esc(o.note)}</span></li>`).join("")}</ul></div>`:""}
    ${r.next_steps.length?`<div><h3 style="margin-bottom:8px">Next steps</h3><ul class="plain">${r.next_steps.map(s=>`<li>${esc(s)}</li>`).join("")}</ul></div>`:""}
    ${(r.footage.issues.length||r.refilm_tips.length)?`<div><h3 style="margin-bottom:8px">Better footage next time</h3><ul class="plain">${[...r.footage.issues,...r.refilm_tips].map(s=>`<li>${esc(s)}</li>`).join("")}</ul></div>`:""}
    ${c.notes?`<p class="note" style="margin:0">Your notes: ${esc(c.notes)}</p>`:""}
    ${c.thumbs?.length?`<div class="strip">${c.thumbs.map(u=>`<img src="${esc(u)}" alt="">`).join("")}</div>`:""}
    <p class="disclaimer">${c.mode === "measure" ? "Measured with a free, general animal-tracking model. It is not a validated lameness system, and mild lameness can still be missed." : "An AI opinion from phone footage, not a diagnosis."} If you're worried, call your vet.</p>
    ${opts.deletable?`<div class="confirm" id="delWrap"><button class="link" type="button" data-del="${esc(c.id)}">Delete this check</button></div>`:""}
  </div>`;
}
function renderLatestOrExample(){
  const out = $("reportOut");
  if (!S.checks.length && !out.innerHTML.trim()) out.innerHTML = reportHTML(EXAMPLE);
  else if (S.checks.length && out.querySelector(".is-example")) out.innerHTML = "";
}

/* ================= work diary + races/trials ================= */
function setDiaryMode(m){
  S.diaryMode = m;
  $("dModeWork").setAttribute("aria-pressed", String(m === "work")); $("dModeStart").setAttribute("aria-pressed", String(m === "start"));
  $("dForm").hidden = m !== "work"; $("sForm").hidden = m !== "start"; msg("dMsg","",true);
}
function resetDiaryForm(){
  ["dDistance","dFull","d800","dNotes"].forEach(i => $(i).value = ""); $("dDate").value = todayStr();
  ["sVenue","sPlace","sTime","sNotes"].forEach(i => $(i).value = ""); $("sDate").value = todayStr();
}
async function saveDiary(e){
  e.preventDefault();
  const horse = horseById($("dHorse").value);
  if (!horse){ msg("dMsg","Choose a horse first.", false); return; }
  const type = $("dType").value;
  const rec = { horseId: horse.id, horseName: horse.name, date: $("dDate").value || todayStr(), type,
    distance: $("dDistance").value.trim(), fullTime: $("dFull").value.trim(), time800: $("d800").value.trim(), notes: $("dNotes").value.trim(),
    createdAt: new Date().toISOString() };
  try{ await save("diary", uid("d"), rec); }catch(err){ msg("dMsg", saveErrMsg(err), false); return; }
  msg("dMsg", `Saved ${DTYPE[type].toLowerCase()} for ${hShort(horse)} on ${fmtDay(rec.date)}. Add the heart rate on the entry below when you take it.`, true);
  resetDiaryForm();
}
async function saveStart(e){
  e.preventDefault();
  const horse = horseById($("dHorse").value);
  if (!horse){ msg("dMsg","Choose a horse first.", false); return; }
  const venue = $("sVenue").value.trim(); if (!venue){ msg("dMsg","Enter where it was.", false); return; }
  const rec = { horseId: horse.id, horseName: horse.name, kind: $("sKind").value, date: $("sDate").value || todayStr(), venue,
    placing: $("sPlace").value.trim(), time: $("sTime").value.trim(), notes: $("sNotes").value.trim(), createdAt: new Date().toISOString() };
  try{ await save("starts", uid("s"), rec); }catch(err){ msg("dMsg", saveErrMsg(err), false); return; }
  msg("dMsg", `Saved ${rec.kind} at ${venue} for ${hShort(horse)} on ${fmtDay(rec.date)}.`, true);
  resetDiaryForm();
}
function diaryDetail(e){
  if (e.type === "farrier") return [SHOEWORK[e.shoeWork], e.shoeType, e.farrier ? `by ${e.farrier}` : ""].filter(Boolean).join(" · ");
  return [e.distance, e.fullTime ? `full time ${e.fullTime}` : "", e.time800 ? `800 m ${e.time800}` : "", e.times].filter(Boolean).join(" · ");
}
function diaryRow(e, showHorse, delKey){
  const det = diaryDetail(e), hrBlock = e.type === "farrier" ? "" : diaryHrHTML(e);
  return `<div class="hrrow">
    <div><span class="d mono">${esc(fmtDay(e.date))}</span>${showHorse ? ` · <b>${esc(hName(e.horseId, e.horseName))}</b>` : ""} <span class="pill ${e.type==="heats" ? "p-possible" : e.type==="fast" ? "p-lame" : "p-sound"}">${esc(DTYPE[e.type]||e.type)}</span></div>
    ${det ? `<div class="mono small">${esc(det)}</div>` : ""}
    ${hrBlock}
    ${e.notes ? `<div class="small muted">${esc(e.notes)}</div>` : ""}
    ${delKey ? delBtn("diary", e.id, delKey) : ""}
  </div>`;
}
/* heart rate on a saved diary entry: enter 10 min, save, come back for 20 min */
function diaryHrHTML(e){
  const hr = S.hr.find(r => r.diaryId === e.id), f = hr && hasHr(hr) ? hrFlag(hr) : null;
  const cell = (m) => {
    const v = hr ? hr["bpm" + m] : null, key = e.id + "_" + m, editing = S.hrEdit === key;
    if (v != null && !editing) return `<span class="hrcell"><i>${m} min</i><b class="mono">${esc(v)}</b><button class="link small" type="button" data-hredit="${esc(key)}">Change</button></span>`;
    return `<span class="hrcell"><i>${m} min</i><input type="number" inputmode="numeric" min="20" max="260" placeholder="bpm" data-hrin="${esc(key)}" value="${v != null ? esc(v) : ""}" aria-label="Heart rate at ${m} minutes"><button class="btn small" type="button" data-hrsave="${esc(key)}">Save</button></span>`;
  };
  return `<div class="hrline"><span class="small"><b>HR</b></span>${cell(10)}${cell(20)}${f?.level === "slow" ? `<span class="pill p-possible">Slow recovery</span>` : ""}</div>`;
}
function bindDiaryHr(root){
  root.querySelectorAll("[data-hredit]").forEach(b => b.onclick = () => { S.hrEdit = b.dataset.hredit; rerenderDiaryViews(); const i = document.querySelector(`[data-hrin="${S.hrEdit}"]`); i && i.focus(); });
  const go = async (key) => {
    const inp = root.querySelector(`[data-hrin="${key}"]`); if (!inp) return;
    const [id, m] = key.split("_"), e = S.diary.find(x => x.id === id); if (!e) return;
    const v = inp.value.trim(), bpm = v === "" ? null : Math.round(+v);
    if (v !== "" && (isNaN(bpm) || bpm < 20 || bpm > 260)){ inp.setCustomValidity("Enter beats per minute, e.g. 92"); inp.reportValidity(); return; }
    const hr = S.hr.find(r => r.diaryId === id);
    if (S.hrEdit === key) S.hrEdit = null;
    try{
      if (hr) await patch("hr", hr.id, { ["bpm" + m]: bpm });
      else if (bpm !== null) await save("hr", uid("r"), { horseId: e.horseId, horseName: e.horseName, at: dayAt(e.date), work: e.type, bpm10: m === "10" ? bpm : null, bpm20: m === "20" ? bpm : null, diaryId: id, createdAt: new Date().toISOString() });
      rerenderDiaryViews();
    }catch(err){ alertBox("storeNote", saveErrMsg(err)); }
  };
  root.querySelectorAll("[data-hrsave]").forEach(b => b.onclick = () => go(b.dataset.hrsave));
  root.querySelectorAll("[data-hrin]").forEach(i => i.onkeydown = (ev) => { if (ev.key === "Enter"){ ev.preventDefault(); go(i.dataset.hrin); } });
}
function rerenderDiaryViews(){ renderDiaryRecent(); if (S.openHorse && !$("horseDetail").hidden) renderHorseDetail(); }
function startRow(s, showHorse, delKey){
  const det = [s.placing ? `placed ${s.placing}` : "", s.time ? `time ${s.time}` : ""].filter(Boolean).join(" · ");
  return `<div class="hrrow">
    <div><span class="d mono">${esc(fmtDay(s.date))}</span>${showHorse ? ` · <b>${esc(hName(s.horseId, s.horseName))}</b>` : ""} <span class="pill p-example">${s.kind === "race" ? "Race" : "Trial"}</span></div>
    <div><b>${esc(s.venue)}</b>${det ? ` <span class="mono small">· ${esc(det)}</span>` : ""}</div>
    ${s.notes ? `<div class="small muted">${esc(s.notes)}</div>` : ""}
    ${delKey ? delBtn("starts", s.id, delKey) : ""}
  </div>`;
}
function renderDiaryRecent(){
  const box = $("dRecent"); if (!box) return;
  const since = addDays(todayStr(), -14);
  const items = [...S.diary.filter(e => e.date >= since && e.type !== "farrier").map(e => ({k: "d", date: e.date, e})),
                 ...S.starts.filter(s => s.date >= since).map(s => ({k: "s", date: s.date, e: s}))]
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 60);
  if (!items.length){ box.innerHTML = `<p class="muted small" style="margin:0">Nothing in the last two weeks yet. Entries you save show here and on each horse's page.</p>`; }
  else {
    let html = "", day = "";
    for (const it of items){
      if (it.date !== day){ day = it.date; html += `<h3 style="margin:10px 0 0;font-size:16px">${esc(fmtDay(day))}${day===todayStr()?" · Today":""}</h3>`; }
      html += it.k === "d" ? diaryRow(it.e, true, "r") : startRow(it.e, true, "r");
    }
    box.innerHTML = html;
    bindDeletes(box, "r", renderDiaryRecent); bindDiaryHr(box);
  }
  renderDueBanner();
}
function lastWorked(horseId){ return S.diary.find(e => e.horseId === horseId && ["jog","canter","fast","heats","track"].includes(e.type)); }

/* ================= shoeing + worming (care) ================= */
const CARE = { shoe: { name: "Shoeing", verb: "shod", weeks: 6 }, worm: { name: "Worming", verb: "wormed", weeks: 12 } };
function careRecords(horseId, kind){
  const recs = S.care.filter(c => c.kind === kind && (!horseId || c.horseId === horseId)).map(c => ({...c, _col: "care"}));
  if (kind === "shoe") S.diary.filter(e => e.type === "farrier" && (!horseId || e.horseId === horseId))
    .forEach(e => recs.push({ id: e.id, _col: "diary", horseId: e.horseId, horseName: e.horseName, kind: "shoe", date: e.date, detail: [SHOEWORK[e.shoeWork], e.shoeType, e.farrier].filter(Boolean).join(" · "), nextDue: e.nextDue, invoiced: !!e.invoiced }));
  return recs.sort((a, b) => (b.date||"").localeCompare(a.date||""));
}
function careStatus(horseId, kind){
  const last = careRecords(horseId, kind)[0]; if (!last) return null;
  const t = todayStr(), due = last.nextDue || addDays(last.date, CARE[kind].weeks * 7);
  return { last, due, level: due < t ? "overdue" : due <= addDays(t, 7) ? "soon" : "ok" };
}
function careRow(c, showHorse, key){
  return `<div class="hrrow">
    <div><span class="d mono">${esc(fmtDay(c.date))}</span>${showHorse ? ` · <b>${esc(hName(c.horseId, c.horseName))}</b>` : ""} ${c.invoiced ? `<span class="pill p-sound">Invoiced</span>` : `<span class="pill p-possible">Not invoiced</span>`}</div>
    ${c.detail ? `<div class="small">${esc(c.detail)}</div>` : ""}
    ${c.nextDue ? `<div class="small muted">Next due ${esc(fmtDay(c.nextDue))}</div>` : ""}
    <div class="confirm" data-delwrap="${esc(key)}_${esc(c._col)}_${esc(c.id)}">
      <button class="link small" type="button" data-inv="${esc(c.id)}" data-invcol="${esc(c._col)}" data-invval="${c.invoiced ? "0" : "1"}">${c.invoiced ? "Mark not invoiced" : "Mark invoiced"}</button>
      ${c._col === "care" ? `<button class="link small" type="button" data-delcol="care" data-delid="${esc(c.id)}" data-delkey="${esc(key)}">Delete</button>` : ""}
    </div>
  </div>`;
}
function bindInvoice(root){
  root.querySelectorAll("[data-inv]").forEach(b => b.onclick = async () => {
    const on = b.dataset.invval === "1";
    try{ await patch(b.dataset.invcol, b.dataset.inv, { invoiced: on, invoicedAt: on ? new Date().toISOString() : "" }); }
    catch(err){ alertBox("storeNote", saveErrMsg(err)); }
  });
}
function careForm(kind, h){
  const t = todayStr();
  return `<form class="seg" id="cf_${kind}" hidden>
    <div class="row">
      <div class="field"><label for="cDate_${kind}">Date ${CARE[kind].verb}</label><input id="cDate_${kind}" type="date" required value="${t}"></div>
      <div class="field"><label for="cDue_${kind}">Next due</label><input id="cDue_${kind}" type="date" value="${addDays(t, CARE[kind].weeks*7)}"></div>
    </div>
    ${kind === "shoe" ? `<div class="row">
      <div class="field"><label for="cWork_shoe">Work done</label><select id="cWork_shoe"><option value="full">Full set</option><option value="fronts">Fronts only</option><option value="hinds">Hinds only</option><option value="reset">Reset</option><option value="trim">Trim only</option><option value="lost">Lost shoe replaced</option></select></div>
      <div class="field"><label for="cDetail_shoe">Farrier / shoes (optional)</label><input id="cDetail_shoe" type="text" placeholder="e.g. Dave, alloy fronts"></div></div>`
    : `<div class="field"><label for="cDetail_worm">Wormer used (optional)</label><input id="cDetail_worm" type="text" placeholder="e.g. Equest Plus Tape"></div>`}
    <label class="small" style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="cInv_${kind}"> Already invoiced</label>
    <div class="row"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" id="cCancel_${kind}">Cancel</button></div>
    <div class="small" id="cMsg_${kind}" hidden></div>
  </form>`;
}
function bindCareForm(kind, h){
  const f = $("cf_" + kind); if (!f) return;
  $("cAdd_" + kind).onclick = () => { f.hidden = !f.hidden; };
  $("cCancel_" + kind).onclick = () => { f.hidden = true; };
  $("cDate_" + kind).onchange = () => { $("cDue_" + kind).value = addDays($("cDate_" + kind).value || todayStr(), CARE[kind].weeks * 7); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const detail = kind === "shoe" ? [SHOEWORK[$("cWork_shoe").value], $("cDetail_shoe").value.trim()].filter(Boolean).join(" · ") : $("cDetail_worm").value.trim();
    const rec = { horseId: h.id, horseName: h.name, kind, date: $("cDate_" + kind).value || todayStr(), nextDue: $("cDue_" + kind).value || "",
      detail, invoiced: $("cInv_" + kind).checked, invoicedAt: $("cInv_" + kind).checked ? new Date().toISOString() : "", createdAt: new Date().toISOString() };
    try{ await save("care", uid("c"), rec); }catch(err){ msg("cMsg_" + kind, saveErrMsg(err), false); }
  };
}
function careCard(kind, h){
  const st = careStatus(h.id, kind), recs = careRecords(h.id, kind);
  const pill = !st ? "" : st.level === "overdue" ? `<span class="pill p-lame">Overdue</span>` : st.level === "soon" ? `<span class="pill p-possible">Due soon</span>` : `<span class="pill p-sound">Up to date</span>`;
  return `<div class="card"><div class="topline"><h3>${CARE[kind].name} ${pill}</h3><button class="link" type="button" id="cAdd_${kind}">+ Record ${CARE[kind].name.toLowerCase()}</button></div>
    ${careForm(kind, h)}
    ${st ? `<div class="kv"><dt>Last ${CARE[kind].verb}</dt><dd>${esc(fmtDay(st.last.date))}</dd><dt>Next due</dt><dd>${esc(fmtDay(st.due))}</dd></div>
      <details ${recs.length <= 3 ? "open" : ""}><summary class="small">History (${recs.length})</summary><div class="history" style="margin-top:8px">${recs.map(c => careRow(c, false, "c" + kind)).join("")}</div></details>`
      : `<p class="muted small" style="margin:0">Nothing recorded yet.</p>`}
  </div>`;
}
/* due alarms across all horses */
function dueList(){
  const out = [];
  for (const h of S.horses) for (const kind of ["shoe", "worm"]){
    const st = careStatus(h.id, kind); if (st && st.level !== "ok") out.push({ h, kind, ...st });
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}
function renderDueBanner(){
  const box = $("dueBanner"); if (!box) return;
  const due = dueList();
  if (!due.length){ box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<b>Due:</b> ${due.map(d => `<button class="link" type="button" data-openh="${esc(d.h.id)}">${esc(hShort(d.h))}</button> ${CARE[d.kind].name.toLowerCase()} ${d.level === "overdue" ? `<b class="err-text">overdue</b> (was ${esc(fmtDay(d.due))})` : `due ${esc(fmtDay(d.due))}`}`).join(" · ")}`;
  box.querySelectorAll("[data-openh]").forEach(b => b.onclick = () => { S.openHorse = b.dataset.openh; S.openCheck = null; showTab("horses"); renderHorses(); });
}
function renderCareOverview(){
  const box = $("careOverview"); if (!box) return;
  const due = dueList();
  const month = S.invMonth || todayStr().slice(0,7);
  const uninv = [...careRecords(null, "shoe"), ...careRecords(null, "worm")].filter(c => !c.invoiced && (month === "all" || (c.date||"").slice(0,7) === month))
    .sort((a, b) => (a.date||"").localeCompare(b.date||""));
  const months = [...new Set([...careRecords(null, "shoe"), ...careRecords(null, "worm")].map(c => (c.date||"").slice(0,7)).filter(Boolean))].sort().reverse();
  if (!months.includes(month) && month !== "all") months.unshift(month);
  box.innerHTML = `<div class="card">
    <h3>Shoeing &amp; worming due</h3>
    ${due.length ? `<div class="history">${due.map(d => `<div class="hrrow"><div><b><button class="link" type="button" data-openh="${esc(d.h.id)}">${esc(hShort(d.h))}</button></b> · ${CARE[d.kind].name} ${d.level === "overdue" ? `<span class="pill p-lame">Overdue</span>` : `<span class="pill p-possible">Due soon</span>`}</div><div class="small">Due ${esc(fmtDay(d.due))} · last ${CARE[d.kind].verb} ${esc(fmtDay(d.last.date))}</div></div>`).join("")}</div>`
      : `<p class="muted small" style="margin:0">Nothing due in the next week.</p>`}
    <div class="topline" style="margin-top:6px"><h3>Not yet invoiced</h3>
      <select id="invMonth" style="width:auto">${[["all","All months"], ...months.map(m => [m, new Date(m + "-15").toLocaleDateString("en-NZ",{month:"long", year:"numeric"})])].map(([v, l]) => `<option value="${v}"${v === month ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
    ${uninv.length ? `<div class="history">${uninv.map(c => careRow({...c, detail: `${CARE[c.kind].name}${c.detail ? " · " + c.detail : ""}`}, true, "inv")).join("")}</div>` : `<p class="muted small" style="margin:0">Everything for this month is invoiced.</p>`}
  </div>`;
  $("invMonth").onchange = () => { S.invMonth = $("invMonth").value; renderCareOverview(); };
  box.querySelectorAll("[data-openh]").forEach(b => b.onclick = () => { S.openHorse = b.dataset.openh; S.openCheck = null; renderHorses(); window.scrollTo(0,0); });
  bindInvoice(box); bindDeletes(box, "inv");
}

/* ================= supplements ================= */
// settings/supplements: { list:[names], details:{ name:{ cost:<$ per unit>, unit:"scoop" } } }
// horse: supplements:[names ticked], suppQty:{ name: <units per day> }
function supList(){ return (S.supps || []).slice().sort((a, b) => a.localeCompare(b)); }
const suppInfo = (n) => ({ unit: "scoop", cost: null, ...((S.suppDetails || {})[n] || {}) });
const money = (v) => "$" + (Math.round(v * 100) / 100).toFixed(2);
const plural = (u, q) => q === 1 || !u || /s$|ml$|g$|kg$|l$/i.test(u) ? u : u + "s";
function horseSuppCost(h){
  const on = (h.supplements || []).filter(n => (S.supps || []).includes(n));
  let total = 0, missing = 0;
  for (const n of on){ const c = suppInfo(n).cost, q = (h.suppQty || {})[n]; if (c != null && q != null) total += c * q; else missing++; }
  return { on, total, missing };
}
async function saveSupps(list, details){ await save("settings", "supplements", { list, details }); }
function renderSuppSettings(){
  const box = $("suppList"); if (!box) return;
  const list = supList();
  box.innerHTML = list.length ? `<div class="supptable">
      <div class="sh"><span>Supplement</span><span>Cost ($)</span><span>per</span><span></span></div>
      ${list.map(n => { const d = suppInfo(n); return `<div class="sr">
        <span class="nm">${esc(n)}</span>
        <input type="text" inputmode="decimal" autocomplete="off" data-scost="${esc(n)}" value="${d.cost != null ? esc(d.cost) : ""}" placeholder="0.00" aria-label="Cost per ${esc(d.unit)} of ${esc(n)}">
        <input type="text" autocomplete="off" data-sunit="${esc(n)}" value="${esc(d.unit)}" aria-label="Unit for ${esc(n)}">
        <button class="link small" type="button" data-rmsupp="${esc(n)}" aria-label="Remove ${esc(n)}">×</button></div>`; }).join("")}
    </div>` : `<span class="muted small">No supplements yet. Add them above.</span>`;
  const details = () => ({ ...(S.suppDetails || {}) });
  box.querySelectorAll("[data-scost]").forEach(inp => inp.onchange = async () => {
    const n = inp.dataset.scost, v = inp.value.trim().replace("$", "").replace(",", "."), d = details();
    const cost = v === "" ? null : Math.round(parseFloat(v) * 100) / 100;
    if (v !== "" && (isNaN(cost) || cost < 0)){ msg("suppMsg", "Enter the cost as a number, e.g. 1.50", false); return; }
    d[n] = { ...suppInfo(n), cost };
    try{ await saveSupps(S.supps, d); msg("suppMsg", `Saved ${n}.`, true); }catch(err){ msg("suppMsg", saveErrMsg(err), false); }
  });
  box.querySelectorAll("[data-sunit]").forEach(inp => inp.onchange = async () => {
    const n = inp.dataset.sunit, d = details(); d[n] = { ...suppInfo(n), unit: inp.value.trim() || "scoop" };
    try{ await saveSupps(S.supps, d); msg("suppMsg", `Saved ${n}.`, true); }catch(err){ msg("suppMsg", saveErrMsg(err), false); }
  });
  box.querySelectorAll("[data-rmsupp]").forEach(b => b.onclick = async () => {
    const d = details(); delete d[b.dataset.rmsupp];
    try{ await saveSupps((S.supps||[]).filter(x => x !== b.dataset.rmsupp), d); }catch(err){ msg("suppMsg", saveErrMsg(err), false); }
  });
  renderSuppTotals();
}
function renderSuppTotals(){
  const box = $("suppTotals"); if (!box) return;
  const rows = S.horses.map(h => ({ h, ...horseSuppCost(h) })).filter(r => r.on.length);
  if (!rows.length){ box.innerHTML = ""; return; }
  const all = rows.reduce((a, r) => a + r.total, 0);
  box.innerHTML = `<h3 style="margin:6px 0 0">Cost per horse</h3>
    <div class="supptable costs">
      <div class="sh"><span>Horse</span><span>Per day</span><span>Per week</span><span>Per month</span></div>
      ${rows.map(r => `<div class="sr"><span class="nm">${esc(hShort(r.h))}${r.missing ? ` <span class="muted small">(${r.missing} not priced)</span>` : ""}</span><span class="mono">${money(r.total)}</span><span class="mono">${money(r.total*7)}</span><span class="mono">${money(r.total*30)}</span></div>`).join("")}
      <div class="sr tot"><span class="nm">All horses</span><span class="mono">${money(all)}</span><span class="mono">${money(all*7)}</span><span class="mono">${money(all*30)}</span></div>
    </div>
    <p class="small muted" style="margin:0">A month is counted as 30 days.</p>`;
}
async function addSupp(e){
  e.preventDefault();
  const names = $("suppNew").value.split(",").map(s => s.trim()).filter(Boolean);
  if (!names.length) return;
  const list = [...new Set([...(S.supps||[]), ...names])];
  try{ await saveSupps(list, S.suppDetails || {}); $("suppNew").value = ""; msg("suppMsg", `Added ${names.length}. Now enter the cost for each.`, true); }catch(err){ msg("suppMsg", saveErrMsg(err), false); }
}
function suppCard(h){
  const list = supList(), on = new Set(h.supplements || []), qty = h.suppQty || {}, cost = horseSuppCost(h);
  return `<div class="card"><div class="topline"><h3>Supplements</h3><button class="link" type="button" id="goSupp">Edit the list &amp; costs</button></div>
    ${list.length ? `<div class="supplist">${list.map(n => { const d = suppInfo(n), q = qty[n], has = on.has(n);
        return `<div class="supprow${has ? " on" : ""}">
          <label class="supp"><input type="checkbox" data-supp="${esc(n)}" ${has ? "checked" : ""}> ${esc(n)}</label>
          ${has ? `<span class="qty"><input type="text" inputmode="decimal" autocomplete="off" data-sqty="${esc(n)}" value="${q != null ? esc(q) : ""}" placeholder="0" aria-label="${esc(d.unit)} of ${esc(n)} per day"> <span class="small">${esc(plural(d.unit, q))} a day</span>
            <b class="mono small">${d.cost != null && q != null ? money(d.cost * q) : d.cost == null ? `<span class="muted">no price</span>` : ""}</b></span>` : ""}
        </div>`; }).join("")}</div>
      ${cost.on.length ? `<div class="kv"><dt>Per day</dt><dd class="mono"><b>${money(cost.total)}</b></dd><dt>Per week</dt><dd class="mono">${money(cost.total*7)}</dd><dt>Per month</dt><dd class="mono">${money(cost.total*30)}</dd></div>
        ${cost.missing ? `<p class="small muted" style="margin:0">${cost.missing} supplement${cost.missing>1?"s":""} still need an amount or a price.</p>` : ""}` : `<p class="small muted" style="margin:0">Not on any supplements.</p>`}`
      : `<p class="muted small" style="margin:0">Add your supplements and their costs in Settings first, then tick the ones ${esc(hShort(h))} is on.</p>`}
  </div>`;
}

/* ================= AI training summary ================= */
async function analyseHorse(h){
  const out = $("aiOut"), btn = $("aiBtn");
  if (!S.settings.geminiKey){ out.innerHTML = `<p class="err-text small">Add the Gemini API key in Settings first.</p>`; return; }
  btn.disabled = true; out.innerHTML = `<div class="status"><span class="spinner"></span><span>Reading ${esc(hShort(h))}'s records…</span></div>`;
  const since = addDays(todayStr(), -60);
  const lines = [];
  S.diary.filter(e => e.horseId === h.id && e.date >= since && e.type !== "farrier").slice(0, 60).forEach(e => lines.push(`${e.date} WORK ${DTYPE[e.type]||e.type}: ${[e.distance, e.fullTime && "full time " + e.fullTime, e.time800 && "800m " + e.time800, e.times, e.notes].filter(Boolean).join("; ")}`));
  S.starts.filter(s => s.horseId === h.id && s.date >= addDays(todayStr(), -180)).forEach(s => lines.push(`${s.date} ${s.kind.toUpperCase()} at ${s.venue}${s.placing ? ", placed " + s.placing : ""}${s.time ? ", time " + s.time : ""}${s.notes ? "; " + s.notes : ""}`));
  S.hr.filter(r => r.horseId === h.id && r.at >= since && hasHr(r)).slice(0, 30).forEach(r => lines.push(`${dayOf(r.at)} HEART RATE after ${WORK[r.work]||r.work}: ${r.bpm10 ?? "?"} bpm at 10 min, ${r.bpm20 ?? "?"} at 20 min`));
  allTemps().filter(t => t.horseId === h.id && t.at >= since).slice(0, 30).forEach(t => lines.push(`${dayOf(t.at)} TEMPERATURE ${t.temp}°C`));
  S.checks.filter(c => c.horseId === h.id && (c.createdAt||"") >= since).slice(0, 6).forEach(c => lines.push(`${(c.createdAt||"").slice(0,10)} GAIT CHECK (${c.mode === "measure" ? "measured" : "AI opinion"}): ${c.result?.verdict}; ${(c.result?.limbs||[]).filter(l => l.level !== "none").map(l => l.limb + " " + l.level).join(", ") || "no leg flagged"}`));
  for (const kind of ["shoe", "worm"]){ const st = careStatus(h.id, kind); if (st) lines.push(`${CARE[kind].name}: last ${st.last.date}, next due ${st.due}${st.level !== "ok" ? " (" + st.level + ")" : ""}`); }
  if ((h.supplements||[]).length) lines.push(`Supplements: ${h.supplements.map(n => { const q = (h.suppQty||{})[n]; return q != null ? `${n} (${q} ${suppInfo(n).unit}/day)` : n; }).join(", ")}`);
  const prompt = `You are an experienced New Zealand harness racing trainer's assistant. Review this ${h.gait === "trotter" ? "trotter" : "pacer"}'s recent records and write a short, practical training summary for the stable. Today is ${todayStr()}.
Horse: race name ${h.name}${h.stableName ? ", stable name " + h.stableName : ""}.${h.notes ? " Notes: " + h.notes : ""}
RECORDS (newest first within each type):
${lines.join("\n") || "No records yet."}

Look for: workload pattern (how often jogged / cantered / fast work / heats, rest gaps), whether full and 800 m times are improving or slowing, heart-rate recovery trends, any raised temperatures, gait check flags, and shoeing/worming due. Only comment on what the data shows; say when there isn't enough data. Plain NZ English, no fluff. Don't diagnose; suggest checking with the vet where appropriate.
Reply with ONLY JSON: {"headline":"one sentence","points":["3-6 short observations"],"watch":["0-4 things to keep an eye on or do next"]}`;
  try{
    S.ctl = new AbortController();
    const { json } = await generate([{ text: prompt }], S.ctl.signal, () => {});
    const r = { headline: String(json.headline||""), points: (json.points||[]).map(String).slice(0,8), watch: (json.watch||[]).map(String).slice(0,6), at: new Date().toISOString() };
    try{ await patch("horses", h.id, { aiSummary: r }); }catch(_){}
    out.innerHTML = aiSummaryHTML(r);
  }catch(err){ out.innerHTML = `<p class="err-text small">${esc(err.message || "Couldn't get a summary. Try again.")}</p>`; }
  finally{ btn.disabled = false; }
}
function aiSummaryHTML(r){
  if (!r) return "";
  return `<p style="margin:0"><b>${esc(r.headline)}</b></p>
    ${r.points?.length ? `<ul class="plain">${r.points.map(p => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
    ${r.watch?.length ? `<p class="small" style="margin:6px 0 2px"><b>Keep an eye on</b></p><ul class="plain">${r.watch.map(p => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
    <p class="small muted" style="margin:4px 0 0">AI summary from ${esc(fmtDate(r.at))}. Check anything important with your vet.</p>`;
}

/* ================= horses ================= */
function renderHorses(){
  const box = $("horsesList"), top = [$("horsesTop"), $("hAddHorseSlot"), $("careOverview")];
  if (S.openHorse){ box.hidden = true; top.forEach(e=>e && (e.hidden=true)); renderHorseDetail(); return; }
  box.hidden = false; top.forEach(e=>e && (e.hidden=false)); $("horseDetail").hidden = true;
  renderCareOverview();
  if (!S.horses.length){
    box.innerHTML = `<div class="card"><h3>No horses yet</h3><p class="muted" style="margin:0">Tap <b>+ Add horse</b> to start.</p></div>`;
    return;
  }
  const q = $("horseSearch").value.trim().toLowerCase();
  const list = q ? S.horses.filter(h => String(h.name||"").toLowerCase().includes(q) || String(h.stableName||"").toLowerCase().includes(q)) : S.horses;
  if (!list.length){ box.innerHTML = `<p class="muted">No horse matches “${esc(q)}”.</p>`; return; }
  box.innerHTML = `<div class="horse-list">${list.map(h => {
    const hc = S.checks.filter(c=>c.horseId===h.id), last = hc[0];
    const lastHr = S.hr.find(r => r.horseId===h.id && hasHr(r)), lastT = allTemps().find(t => t.horseId === h.id);
    const slow = lastHr && hrFlag(lastHr).level==="slow", hot = lastT && tempFlag(lastT.temp)?.level === "high";
    const lw = lastWorked(h.id), shoe = careStatus(h.id, "shoe"), worm = careStatus(h.id, "worm");
    const sub = [h.stableName && h.stableName.toLowerCase() !== String(h.name).toLowerCase() ? h.name : "", h.gait==="trotter"?"Trotter":"Pacer",
      lw ? `last worked ${fmtDay(lw.date)}` : ""].filter(Boolean).join(" · ");
    const pills = [
      shoe?.level === "overdue" ? `<span class="pill p-lame">Shoeing overdue</span>` : shoe?.level === "soon" ? `<span class="pill p-possible">Shoeing due</span>` : "",
      worm?.level === "overdue" ? `<span class="pill p-lame">Worming overdue</span>` : worm?.level === "soon" ? `<span class="pill p-possible">Worming due</span>` : "",
      slow ? `<span class="pill p-possible">Slow HR recovery</span>` : "", hot ? `<span class="pill p-lame">High temp</span>` : ""].filter(Boolean).join(" ");
    return `<button class="horse" type="button" data-horse="${esc(h.id)}">
      <span class="nm">${esc(hShort(h))}</span>
      ${last?`<span class="pill p-${last.result.verdict}">${VERDICT[last.result.verdict]}</span>`:"<span></span>"}
      <span class="sm">${esc(sub)}</span>
      <span>${pills}</span>
    </button>`;}).join("")}</div>`;
  box.querySelectorAll("[data-horse]").forEach(b => b.onclick = () => { S.openHorse = b.dataset.horse; S.openCheck = null; S.editHorse = false; S.showAllDiary = false; renderHorses(); window.scrollTo(0,0); });
}
function openDiaryFor(h, mode){ $("dHorse").value = h.id; setDiaryMode(mode || "work"); showTab("diary"); }
function renderHorseDetail(){
  const d = $("horseDetail"); d.hidden = false;
  const h = horseById(S.openHorse);
  if (!h){ S.openHorse = null; renderHorses(); return; }
  const hc = S.checks.filter(c=>c.horseId===h.id), hh = S.hr.filter(r=>r.horseId===h.id && hasHr(r)), ht = allTemps().filter(t => t.horseId === h.id);
  const hd = S.diary.filter(e=>e.horseId===h.id && e.type !== "farrier"), hs = S.starts.filter(s => s.horseId === h.id);
  if (S.openCheck){
    const c = hc.find(x=>x.id===S.openCheck);
    if (c){
      d.innerHTML = `<button class="link" type="button" id="backH">← ${esc(hShort(h))}</button>` + reportHTML(c,{deletable:true});
      $("backH").onclick = () => { S.openCheck = null; renderHorseDetail(); };
      d.querySelector("[data-del]").onclick = () => confirmIn($("delWrap"), "Delete this check for good?", async () => {
        try{ await remove("checks", c.id); S.openCheck = null; renderHorseDetail(); }catch(err){ alertBox("storeNote", saveErrMsg(err)); }
      });
      return;
    }
    S.openCheck = null;
  }
  const shown = S.showAllDiary ? hd : hd.slice(0, 15);
  const showRace = h.stableName && h.stableName.toLowerCase() !== String(h.name).toLowerCase();
  const tempPts = ht.slice(0, 40).map(t => ({ d: t.at, v: t.temp }));
  const hr10 = hh.slice(0, 30).filter(r => r.bpm10 != null).map(r => ({ d: r.at, v: r.bpm10 })), hr20 = hh.slice(0, 30).filter(r => r.bpm20 != null).map(r => ({ d: r.at, v: r.bpm20 }));
  d.innerHTML = `<button class="link" type="button" id="backAll">← All horses</button>
    <div class="card">
      <div><span class="eyebrow">${h.gait==="trotter"?"Trotter":"Pacer"}</span><h2>${esc(hShort(h))}</h2>
        ${showRace?`<p class="small" style="margin:4px 0 0">Race name: <b>${esc(h.name)}</b></p>`:""}
        ${h.notes?`<p class="muted small" style="margin:4px 0 0">${esc(h.notes)}</p>`:""}</div>
      <div class="row">
        <button class="btn primary" type="button" id="diaryThis">+ Work</button>
        <button class="btn" type="button" id="startThis">+ Race / trial</button>
        <button class="btn" type="button" id="tempThis">+ Temp</button>
        <button class="btn" type="button" id="checkThis">Gait check</button>
        <button class="btn" type="button" id="editThis">Edit horse</button>
      </div>
      <form class="seg" id="editForm" ${S.editHorse?"":"hidden"}>
        <div class="row">
          <div class="field"><label for="eName">Race name</label><input id="eName" type="text" required value="${esc(h.name)}"></div>
          <div class="field"><label for="eStable">Stable name</label><input id="eStable" type="text" value="${esc(h.stableName||"")}" placeholder="What you call them"></div>
        </div>
        <div class="row"><div class="field"><label for="eGait">Gait</label><select id="eGait"><option value="pacer"${h.gait!=="trotter"?" selected":""}>Pacer</option><option value="trotter"${h.gait==="trotter"?" selected":""}>Trotter</option></select></div></div>
        <div class="field"><label for="eNotes">Notes</label><input id="eNotes" type="text" value="${esc(h.notes||"")}" placeholder="Age, known issues…"></div>
        <div class="row"><button class="btn primary" type="submit">Save changes</button><button class="btn" type="button" id="eCancel">Cancel</button></div>
        <div class="small" id="eMsg" hidden></div>
        <div class="confirm" id="delHWrap" style="margin-top:6px"><button class="link" type="button" id="delHorse">Delete ${esc(hShort(h))} and all their records</button></div>
      </form>
    </div>

    <div class="card"><div class="topline"><h3>Training summary</h3><button class="btn" type="button" id="aiBtn">Analyse ${esc(hShort(h))}</button></div>
      <div id="aiOut">${h.aiSummary ? aiSummaryHTML(h.aiSummary) : `<p class="muted small" style="margin:0">Tap Analyse for an AI summary of recent work, times, heart rate, temperature and gait checks.</p>`}</div>
    </div>

    ${careCard("shoe", h)}
    ${careCard("worm", h)}
    ${suppCard(h)}

    <div class="card"><div class="topline"><h3>Work diary</h3><button class="link" type="button" id="diaryThis2">+ Add work</button></div>
      ${hd.length ? `<div class="history">${shown.map(e=>diaryRow(e,false,"w")).join("")}</div>
        ${hd.length>15?`<button class="link" type="button" id="diaryMore">${S.showAllDiary?"Show fewer":`Show all ${hd.length} entries`}</button>`:""}`
        : `<p class="muted small" style="margin:0">No work recorded yet.</p>`}
    </div>

    <div class="card"><div class="topline"><h3>Races &amp; trials</h3><button class="link" type="button" id="startThis2">+ Add</button></div>
      ${hs.length ? `<div class="history">${hs.slice(0, 20).map(s => startRow(s, false, "s")).join("")}</div>` : `<p class="muted small" style="margin:0">No races or trials recorded yet.</p>`}
    </div>

    <div class="card"><h3>Temperature</h3>
      ${tempPts.length >= 2 ? timeChart([tempPts], { band: [37.5, 38.5], unit: "°C" }) + `<p class="small muted" style="margin:0">°C · green band is the normal range, 37.5–38.5°C</p>` : ""}
      ${ht.length ? `<div class="history">${ht.slice(0, 8).map(t => tempRow(t, false, "t")).join("")}</div>` : `<p class="muted small" style="margin:0">No temperatures logged yet.</p>`}
    </div>

    <div class="card"><h3>Heart rate recovery</h3>
      ${hr10.length + hr20.length >= 2 ? timeChart([hr10, hr20], { unit: " bpm", names: ["10 min", "20 min"] }) : ""}
      ${hh.length ? `<div class="history">${hh.slice(0, 8).map(r => hrRow(r, false, "h")).join("")}</div>` : `<p class="muted small" style="margin:0">No heart rates logged yet.</p>`}
    </div>

    <h3>Gait check history</h3>
    <div class="history">${hc.length ? hc.map(c=>`<button class="hist" type="button" data-check="${esc(c.id)}">
        ${c.thumbs?.[1]?`<img src="${esc(c.thumbs[1])}" alt="">`:`<img alt="">`}
        <span><span class="d">${esc(fmtDate(c.createdAt))}</span><br><span class="t">${esc(FOOTAGE[c.footage]||c.footage)} · <span class="pill p-${c.result.verdict}">${VERDICT[c.result.verdict]}</span></span></span>
        <span class="minilimbs" aria-label="Legs">${["LF","RF","LH","RH"].map(k=>`<span class="${c.result.limbs.find(l=>l.limb===k)?.level||"none"}"></span>`).join("")}</span>
      </button>`).join("") : `<p class="muted">No gait checks yet for ${esc(hShort(h))}.</p>`}</div>`;
  const rerender = () => renderHorseDetail();
  $("backAll").onclick = () => { S.openHorse = null; S.editHorse = false; renderHorses(); };
  $("diaryThis").onclick = $("diaryThis2").onclick = () => openDiaryFor(h, "work");
  $("startThis").onclick = $("startThis2").onclick = () => openDiaryFor(h, "start");
  $("checkThis").onclick = () => { $("horseSel").value = h.id; updateAnalyseBtn(); showTab("check"); };
  $("tempThis").onclick = () => { $("tHorse").value = h.id; msg("tMsg","",true); showTab("temp"); };
  $("aiBtn").onclick = () => analyseHorse(h);
  $("goSupp").onclick = () => showTab("settings");
  d.querySelectorAll("[data-sqty]").forEach(inp => inp.onchange = async () => {
    const v = inp.value.trim().replace(",", "."), q = v === "" ? null : parseFloat(v);
    if (v !== "" && (isNaN(q) || q < 0)) return;
    try{ await patch("horses", h.id, { suppQty: { ...(h.suppQty || {}), [inp.dataset.sqty]: q } }); }catch(err){ alertBox("storeNote", saveErrMsg(err)); }
  });
  d.querySelectorAll("[data-supp]").forEach(cb => cb.onchange = async () => {
    const set = new Set(h.supplements || []); cb.checked ? set.add(cb.dataset.supp) : set.delete(cb.dataset.supp);
    try{ await patch("horses", h.id, { supplements: [...set] }); }catch(err){ alertBox("storeNote", saveErrMsg(err)); }
  });
  bindCareForm("shoe", h); bindCareForm("worm", h);
  $("editThis").onclick = () => { S.editHorse = !S.editHorse; $("editForm").hidden = !S.editHorse; if (S.editHorse) $("eName").focus(); };
  $("eCancel").onclick = () => { S.editHorse = false; rerender(); };
  $("editForm").onsubmit = async (e) => {
    e.preventDefault();
    const name = $("eName").value.trim(); if (!name) return;
    if (S.horses.some(x => x.id !== h.id && String(x.name).toLowerCase() === name.toLowerCase())){ msg("eMsg", `${name} is already in the list.`, false); return; }
    try{ await patch("horses", h.id, { name, stableName:$("eStable").value.trim(), gait:$("eGait").value, notes:$("eNotes").value.trim(), updatedAt:new Date().toISOString() }); S.editHorse = false; }
    catch(err){ msg("eMsg", saveErrMsg(err), false); }
  };
  if ($("diaryMore")) $("diaryMore").onclick = () => { S.showAllDiary = !S.showAllDiary; rerender(); };
  ["w","s","t","h","cshoe","cworm"].forEach(k => bindDeletes(d, k, rerender)); bindDiaryHr(d);
  bindInvoice(d);
  d.querySelectorAll("[data-check]").forEach(b => b.onclick = () => { S.openCheck = b.dataset.check; rerender(); window.scrollTo(0,0); });
  $("delHorse").onclick = () => confirmIn($("delHWrap"), `Delete ${hShort(h)} and all their records? This can't be undone.`, async () => {
    try{
      const jobs = [...hc.map(c => ["checks", c.id]), ...S.hr.filter(r => r.horseId===h.id).map(r => ["hr", r.id]), ...S.temps.filter(t => t.horseId===h.id).map(t => ["temps", t.id]),
        ...S.diary.filter(e => e.horseId===h.id).map(e => ["diary", e.id]), ...hs.map(s => ["starts", s.id]), ...S.care.filter(c => c.horseId===h.id).map(c => ["care", c.id])];
      for (const [c, id] of jobs) await remove(c, id);
      await remove("horses", h.id);
      S.openHorse = null; S.editHorse = false; renderHorses();
    }catch(err){ alertBox("storeNote", saveErrMsg(err)); }
  });
}

function confirmIn(wrap, q, yes, onCancel){
  wrap.innerHTML = `<span>${esc(q)}</span><button class="btn primary" type="button">Yes, delete</button><button class="btn" type="button">Cancel</button>`;
  const [y,n] = wrap.querySelectorAll("button"); y.onclick = yes; n.onclick = onCancel || (() => renderHorseDetail());
}

boot();
