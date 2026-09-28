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
const WORK = {jog:"Jog", fast:"Fast work", trial:"Trial / workout", race:"Race", other:"Other"};

const S = { fs:null, auth:null, me:null, horses:[], checks:[], hr:[], settings:{}, unsubs:[],
  file:null, segStart:0, ctl:null, openHorse:null, openCheck:null, prevTab:"check" };

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
    S.horses = snap.docs.map(d => ({id:d.id, ...d.data()})).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
    renderHorseSelect(); renderHorses();
  }, denied));
  S.unsubs.push(onSnapshot(query(collection(S.fs,"checks"), orderBy("createdAt","desc"), limit(500)), snap => {
    S.checks = snap.docs.map(d => ({id:d.id, ...d.data()}));
    renderHorses(); renderLatestOrExample();
  }, denied));
  S.unsubs.push(onSnapshot(query(collection(S.fs,"hr"), orderBy("at","desc"), limit(1000)), snap => {
    S.hr = snap.docs.map(d => ({id:d.id, ...d.data()}));
    renderHrRecent(); renderHorses();
  }, denied));
  S.unsubs.push(onSnapshot(doc(S.fs,"settings","app"), snap => {
    S.settings = snap.exists() ? snap.data() : {};
    $("setKey").value = S.settings.geminiKey || ""; $("setModel").value = S.settings.model || "";
    keyNote(); updateAnalyseBtn();
  }, () => {}));
  renderHorseSelect(); renderHorses(); renderLatestOrExample(); renderHrRecent();
}
function keyNote(){
  const n = $("storeNote");
  if (!S.settings.geminiKey){ n.innerHTML = `Add the Gemini API key in <button class="link" type="button" id="goSettings">Settings</button> before analysing videos.`; n.hidden = false; $("goSettings").onclick = () => showTab("settings"); }
  else if (n.querySelector("#goSettings")) n.hidden = true;
}
const save = (col, id, data) => setDoc(doc(S.fs, col, id), data);
const remove = (col, id) => deleteDoc(doc(S.fs, col, id));
function saveErrMsg(err){
  if (err?.code === "permission-denied") return "You don't have permission to save. Ask for your email to be added to the team list.";
  return "Couldn't save just now. Check your connection and try again.";
}

/* ================= tabs & UI ================= */
function showTab(t){
  if (t === "settings"){ const cur = document.querySelector('nav.tabs [aria-selected="true"]'); S.prevTab = cur?.dataset.tab || "check"; }
  document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab===t)));
  ["check","hr","horses","guide","settings"].forEach(p => $("panel-"+p).hidden = p!==t);
  window.scrollTo(0,0);
}
function bindUI(){
  $("signInBtn").onclick = doSignIn;
  $("signOutBtn").onclick = () => signOut(S.auth);
  $("settingsBtn").onclick = () => showTab("settings");
  $("settingsBack").onclick = () => showTab(S.prevTab);
  document.querySelectorAll("nav.tabs button").forEach(b => b.onclick = () => showTab(b.dataset.tab));
  mountAddForm("add", "addHorseBtn", "addHorseSlot", "horseSel");
  mountAddForm("hra", "hrAddHorseBtn", "hrAddHorseSlot", "hrHorse");
  mountAddForm("hha", "hAddHorseBtn", "hAddHorseSlot", null);
  $("horseSel").onchange = updateAnalyseBtn;
  $("horseSearch").oninput = renderHorses;
  $("hrForm").onsubmit = saveHr;
  resetHrWhen();
  $("videoIn").onchange = (e) => { const f = e.target.files[0]; if (f) loadVideo(f); };
  const drop = $("drop");
  drop.ondragover = (e) => e.preventDefault();
  drop.ondrop = (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith("video")) loadVideo(f); };
  $("setStart").onclick = () => { S.segStart = $("video").currentTime || 0; updateSegInfo(); };
  $("segLen").onchange = updateSegInfo;
  $("analyseBtn").onclick = analyse;
  $("stopBtn").onclick = () => S.ctl?.abort();
  $("settingsForm").onsubmit = async (e) => {
    e.preventDefault();
    try{
      await save("settings","app",{geminiKey:$("setKey").value.trim(), model:$("setModel").value.trim(), updatedBy:S.me?.email||"", updatedAt:new Date().toISOString()});
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
function updateAnalyseBtn(){ $("analyseBtn").disabled = !($("horseSel").value && S.file && S.settings.geminiKey); }

function mountAddForm(p, btnId, slotId, selectId){
  $(slotId).innerHTML = `<form class="seg" id="${p}Form" hidden>
    <div class="row">
      <div class="field"><label for="${p}Name">Name</label><input id="${p}Name" type="text" required placeholder="e.g. Palermo Star"></div>
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
    try{ await save("horses", id, {name, gait:$(p+"Gait").value, notes:$(p+"Notes").value.trim(), createdAt:new Date().toISOString(), createdBy:S.me?.email||""}); }
    catch(err){ msg(p+"Msg", saveErrMsg(err), false); return; }
    form.reset(); form.hidden = true; msg(p+"Msg","",true);
    if (selectId) setTimeout(()=>{ $(selectId).value = id; updateAnalyseBtn(); }, 300);
  };
}
function renderHorseSelect(){
  ["horseSel","hrHorse"].forEach(id => {
    const sel = $(id); const cur = sel.value;
    sel.innerHTML = S.horses.length
      ? `<option value="">Choose a horse…</option>` + S.horses.map(h => `<option value="${esc(h.id)}">${esc(h.name)} · ${h.gait==="trotter"?"Trotter":"Pacer"}</option>`).join("")
      : `<option value="">Add your first horse →</option>`;
    if (S.horses.some(h=>h.id===cur)) sel.value = cur;
  });
  updateAnalyseBtn();
}

/* ================= heart rate ================= */
function resetHrWhen(){ const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); $("hrWhen").value = d.toISOString().slice(0,16); }
async function saveHr(e){
  e.preventDefault();
  const horse = S.horses.find(h => h.id === $("hrHorse").value);
  if (!horse){ msg("hrMsg","Choose a horse first.", false); return; }
  const num = (id) => { const v = $(id).value.trim(); return v === "" ? null : Math.round(+v); };
  const rec = {horseId:horse.id, horseName:horse.name, at:new Date($("hrWhen").value).toISOString(), work:$("hrWork").value,
    bpm0:num("hr0"), bpm10:num("hr10"), bpm20:num("hr20"), notes:$("hrNotes").value.trim(),
    createdAt:new Date().toISOString(), by:S.me?.displayName || S.me?.email || ""};
  if (rec.bpm0 === null){ msg("hrMsg","Enter the heart rate taken straight after work.", false); return; }
  const id = uid("r");
  try{ await save("hr", id, rec); }catch(err){ msg("hrMsg", saveErrMsg(err), false); return; }
  ["hr0","hr10","hr20","hrNotes"].forEach(i => $(i).value = ""); resetHrWhen();
  msg("hrMsg", `Saved for ${horse.name}. ${hrFlag({id, ...rec}).text}`, true);
}
function hrFlag(r){
  const prior = S.hr.filter(x => x.horseId===r.horseId && x.id!==r.id && x.work===r.work && x.at < r.at);
  const avg = (k) => { const v = prior.map(x=>x[k]).filter(n=>n!==null && n!==undefined); return v.length>=2 ? v.reduce((a,b)=>a+b,0)/v.length : null; };
  const a10 = avg("bpm10"), a20 = avg("bpm20");
  const slow = (v,a) => v!==null && v!==undefined && a!==null && v > a*1.15 && v - a >= 6;
  const wk = (WORK[r.work]||r.work).toLowerCase();
  if (slow(r.bpm20,a20) || slow(r.bpm10,a10))
    return {level:"slow", text:`Recovering slower than ${r.horseName}'s usual for ${wk} (average ${a10!==null?Math.round(a10):"–"} at 10 min, ${a20!==null?Math.round(a20):"–"} at 20 min).`};
  if (a10===null && a20===null) return {level:"new", text:`Log a few more ${wk} sessions to see ${r.horseName}'s normal recovery.`};
  return {level:"ok", text:`In line with ${r.horseName}'s usual recovery.`};
}
function hrRow(r, showHorse){
  const f = hrFlag(r);
  const pill = f.level==="slow" ? `<span class="pill p-possible">Slow recovery</span>` : f.level==="ok" ? `<span class="pill p-sound">Normal</span>` : "";
  return `<div class="hrrow">
    <div><span class="d mono">${esc(fmtDate(r.at))}</span>${showHorse?` · <b>${esc(r.horseName)}</b>`:""} · ${esc(WORK[r.work]||r.work)} ${pill}</div>
    <div class="bpm mono"><span><b>${r.bpm0 ?? "–"}</b><i>after</i></span><span><b>${r.bpm10 ?? "–"}</b><i>10 min</i></span><span><b>${r.bpm20 ?? "–"}</b><i>20 min</i></span></div>
    ${r.notes?`<div class="small muted">${esc(r.notes)}</div>`:""}
    ${r.by?`<div class="small muted">Entered by ${esc(r.by)}</div>`:""}
  </div>`;
}
function renderHrRecent(){
  $("hrRecent").innerHTML = S.hr.length ? S.hr.slice(0,8).map(r=>hrRow(r,true)).join("")
    : `<p class="muted small" style="margin:0">No readings yet. Saved readings show here and on each horse's page.</p>`;
}
function hrChart(list){
  const rows = list.slice(0,6).reverse(); if (!rows.length) return "";
  const W=320, H=150, pl=34, pr=10, pt=14, pb=24;
  const vals = rows.flatMap(r=>[r.bpm0,r.bpm10,r.bpm20]).filter(v=>v!==null && v!==undefined);
  const max = Math.ceil(Math.max(...vals, 60)/20)*20, min = Math.max(0, Math.floor(Math.min(...vals, 40)/20)*20);
  const step = Math.max(20, Math.ceil((max-min)/4/20)*20);
  const x = (i) => pl + i*(W-pl-pr)/2, y = (v) => pt + (max-v)*(H-pt-pb)/(max-min);
  const ticks = []; for (let v=min; v<=max; v+=step) ticks.push(v);
  const lines = rows.map((r,i) => {
    const pts = [[0,r.bpm0],[1,r.bpm10],[2,r.bpm20]].filter(p=>p[1]!==null && p[1]!==undefined);
    const last = i===rows.length-1, col = last ? "var(--accent)" : "var(--muted)";
    return `<polyline fill="none" stroke="${col}" stroke-width="${last?2.5:1.2}" stroke-opacity="${last?1:.45}" points="${pts.map(p=>`${x(p[0])},${y(p[1])}`).join(" ")}"/>` +
      (last ? pts.map(p=>`<circle cx="${x(p[0])}" cy="${y(p[1])}" r="3.5" fill="var(--accent)"/><text x="${x(p[0])+(p[0]===2?-6:6)}" y="${y(p[1])-7}" text-anchor="${p[0]===2?"end":"start"}" font-size="11" fill="var(--ink)" font-family="IBM Plex Mono, monospace">${p[1]}</text>`).join("") : "");
  }).join("");
  return `<div style="overflow-x:auto"><svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:480px" role="img" aria-label="Heart rate recovery curves">
    ${ticks.map(v=>`<line x1="${pl}" x2="${W-pr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pl-6}" y="${y(v)+4}" text-anchor="end" font-size="10" fill="var(--muted)" font-family="IBM Plex Mono, monospace">${v}</text>`).join("")}
    ${["After","10 min","20 min"].map((l,i)=>`<text x="${x(i)}" y="${H-6}" text-anchor="${i===0?"start":i===2?"end":"middle"}" font-size="11" fill="var(--muted)">${l}</text>`).join("")}
    ${lines}</svg></div><p class="small muted" style="margin:0">bpm · latest session in red, up to 5 earlier sessions in grey</p>`;
}

/* ================= video ================= */
function clipDuration(){ const d = $("video").duration; return isFinite(d) ? d : 0; }
function segWindow(){
  const dur = clipDuration(), lenSel = $("segLen").value;
  if (lenSel === "all" || !dur) return {start:0, len:dur};
  const len = Math.min(+lenSel, dur);
  return {start:Math.min(S.segStart, Math.max(0, dur - len)), len};
}
function updateSegInfo(){
  const {start,len} = segWindow(), d = clipDuration();
  $("segInfo").innerHTML = d
    ? `Analysing <span class="mono">${start.toFixed(1)}s – ${(start+len).toFixed(1)}s</span> of a <span class="mono">${d.toFixed(1)}s</span> clip · <span class="mono">${(S.file.size/1048576).toFixed(0)} MB</span>`
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
    if (d > 12) S.segStart = Math.max(0, d/2 - 3);
    if (d && d <= 8) $("segLen").value = "all";
    updateSegInfo(); updateAnalyseBtn();
  };
  v.onerror = () => {
    S.file = null; updateAnalyseBtn(); $("videoBox").hidden = true;
    alertBox("videoErr","This browser can't play that video. On iPhone, try Settings › Camera › Formats › Most Compatible, or open this page in Safari.");
  };
  updateSegInfo(); updateAnalyseBtn();
}
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
  const body = JSON.stringify({ contents:[{role:"user", parts}], generationConfig:{ responseMimeType:"application/json", temperature:0.2 } });
  const call = (m) => fetch(`${GEMINI}/v1beta/models/${m}:generateContent?key=${encodeURIComponent(key)}`, {method:"POST", headers:{"Content-Type":"application/json"}, body, signal});
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
    for (let attempt = 0; attempt < 2; attempt++){
      if (signal.aborted) throw {name:"AbortError"};
      const r = await call(model);
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
        onStatus?.(attempt === 0 ? "Google's AI is busy. Trying again in a few seconds\u2026" : "Still busy. Trying a backup AI model\u2026");
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
    `- ${r.at.slice(0,16).replace("T"," ")} ${WORK[r.work]||r.work}: ${r.bpm0 ?? "?"} bpm after, ${r.bpm10 ?? "?"} at 10 min, ${r.bpm20 ?? "?"} at 20 min. ${hrFlag(r).text}`).join("\n");
  const gaitNote = horse.gait === "trotter"
    ? "This horse is a TROTTER (diagonal gait: LF+RH land together, RF+LH land together)."
    : "This horse is a PACER (lateral gait: LF+LH land together, RF+RH land together). In the pace the classic head nod is harder to read because a fore and hind on the SAME side bear weight together; lean more on hip/pelvic movement, stride length, fetlock drop, and head/neck movement relative to each lateral pair. Also note if the horse breaks gait.";
  const media = mode === "frames"
    ? `You are given ${nFrames} still frames evenly spaced from ${win.start.toFixed(2)}s to ${(win.start+win.len).toFixed(2)}s of the video (about ${(win.len/Math.max(nFrames-1,1)).toFixed(2)}s apart). Each frame has its number and timestamp printed in its top-left corner. Stills lose timing, so be cautious. In "observations", set "when" to frame numbers like "F3–F6".`
    : `You are given the video, limited to the section from ${win.start.toFixed(1)}s to ${(win.start+win.len).toFixed(1)}s. Watch the movement through several strides. In "observations", set "when" to timestamps within the video like "0:12–0:14".`;
  return `You are an experienced equine veterinarian specialising in lameness in Standardbred harness racing horses. Assess this horse for lameness from phone footage.

HORSE: ${horse.name}. ${gaitNote}${horse.notes ? " Owner notes about the horse: " + horse.notes : ""}
CAMERA VIEW: ${FOOTAGE[footage]}. PACE: ${pace}.${dir ? " LUNGING ON THE " + dir.toUpperCase() + " REIN." : ""} SURFACE: ${surf}.
FOOTAGE: ${media}
${notes ? "OWNER'S OBSERVATIONS TODAY: " + notes : "No owner observations given."}
${prev ? "PREVIOUS CHECKS ON THIS HORSE (for comparison; do not assume they are still true):\n" + prev : ""}
${hrs ? "HEART RATE RECOVERY IN THE LAST 3 DAYS (context only; mention it if a slow recovery supports or adds to concern):\n" + hrs : ""}

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
  const setStatus = (t) => $("statusText").textContent = t;
  const setProg = (p) => { $("progBar").hidden = p === null; $("progFill").style.width = Math.round((p||0)*100) + "%"; };
  S.ctl = new AbortController(); const signal = S.ctl.signal;
  const win = segWindow(); const mime = videoMime(S.file);
  let uploaded = null;
  try{
    setStatus("Taking snapshots for the record…");
    const snaps = await grabFrames(4, 480, false);
    const thumbs = snaps.map(s => thumb(s.c));
    const vm = { startOffset: win.start.toFixed(2)+"s", endOffset: (win.start+win.len).toFixed(2)+"s", fps: win.len <= 10 ? 10 : 5 };
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
    setStatus("The AI is watching the horse move… this usually takes 20–90 seconds.");
    const {json, model} = await generate(parts, signal, setStatus);
    const check = {
      horseId: horse.id, horseName: horse.name, horseGait: horse.gait,
      footage: $("footage").value, pace: $("pace").value, lungeDir: $("lungeDir").value, surface: $("surface").value,
      notes: $("notes").value.trim(), clipName: (S.file.name||"").slice(0,120),
      window: {start:+win.start.toFixed(2), len:+win.len.toFixed(2)}, mode, frameCount: nFrames, model,
      createdAt: new Date().toISOString(), result: normalise(json), thumbs,
      by: S.me?.displayName || S.me?.email || ""
    };
    $("reportOut").innerHTML = reportHTML(check);
    try{ await save("checks", uid("c"), check); addSaved(`Saved to ${horse.name}'s history.`); }
    catch(err){ addSaved(saveErrMsg(err)); }
    $("notes").value = "";
    $("reportOut").scrollIntoView({behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block:"start"});
  }catch(e){
    if (e?.name !== "AbortError") alertBox("checkError", e?.message || "Something went wrong. Tap Analyse gait to try again.");
  }finally{
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
  const src = c.mode === "frames" ? `${c.frameCount} still frames` : "video";
  const win = c.window ? ` · ${c.window.start}s–${(c.window.start+c.window.len).toFixed(1)}s` : "";
  return `<div class="report card${c.example?" is-example":""}">
    ${c.example ? `<div><span class="pill p-example">Example report</span> <span class="small muted">What a result looks like. Not one of your horses.</span></div>` : ""}
    <div><h2>${esc(c.horseName)}</h2>
      <div class="meta"><span>${fmtDate(c.createdAt)}${c.by?` · by ${esc(c.by)}`:""}</span><span>${esc(FOOTAGE[c.footage]||c.footage)}</span><span class="mono">${src}${win}</span></div></div>
    <div class="verdict v-${r.verdict}">
      <span class="big">${VERDICT[r.verdict]}</span>
      <span>${esc(r.summary)}</span>
      <span class="small muted">Confidence: ${esc(r.confidence)} · Gait seen: ${esc(r.gait_seen)} · Footage: ${esc(r.footage.rating)}</span>
    </div>
    <div><p class="small muted" style="margin:0 0 6px">AAEP lameness grade${r.grade===null?": not enough to grade":""}</p>
      <div class="scale">${[0,1,2,3,4,5].map(n=>`<div class="${r.grade===n?"on":""}">${n}</div>`).join("")}</div></div>
    <div><p class="small muted" style="margin:0 0 6px">Legs, from the horse's point of view</p>
      <div class="limbs"><span></span><span class="hd">Left</span><span class="hd">Right</span>
        <span class="rh">Front</span>${limbCell(L.LF)}${limbCell(L.RF)}
        <span class="rh">Hind</span>${limbCell(L.LH)}${limbCell(L.RH)}</div></div>
    ${r.observations.length?`<div><h3 style="margin-bottom:8px">What the AI saw</h3><ul class="obs">${r.observations.map(o=>`<li><span class="fr">${esc(o.when)}</span><span>${esc(o.note)}</span></li>`).join("")}</ul></div>`:""}
    ${r.next_steps.length?`<div><h3 style="margin-bottom:8px">Next steps</h3><ul class="plain">${r.next_steps.map(s=>`<li>${esc(s)}</li>`).join("")}</ul></div>`:""}
    ${(r.footage.issues.length||r.refilm_tips.length)?`<div><h3 style="margin-bottom:8px">Better footage next time</h3><ul class="plain">${[...r.footage.issues,...r.refilm_tips].map(s=>`<li>${esc(s)}</li>`).join("")}</ul></div>`:""}
    ${c.notes?`<p class="note" style="margin:0">Your notes: ${esc(c.notes)}</p>`:""}
    ${c.thumbs?.length?`<div class="strip">${c.thumbs.map(u=>`<img src="${esc(u)}" alt="">`).join("")}</div>`:""}
    <p class="disclaimer">A second opinion from phone footage, not a diagnosis. If you're worried, or the grade is 3 or more, call your vet.</p>
    ${opts.deletable?`<div class="confirm" id="delWrap"><button class="link" type="button" data-del="${esc(c.id)}">Delete this check</button></div>`:""}
  </div>`;
}
function renderLatestOrExample(){
  const out = $("reportOut");
  if (!S.checks.length && !out.innerHTML.trim()) out.innerHTML = reportHTML(EXAMPLE);
  else if (S.checks.length && out.querySelector(".is-example")) out.innerHTML = "";
}

/* ================= horses ================= */
function renderHorses(){
  const box = $("horsesList"), top = [$("horsesTop"), $("hAddHorseSlot")];
  if (S.openHorse){ box.hidden = true; top.forEach(e=>e.hidden=true); renderHorseDetail(); return; }
  box.hidden = false; top.forEach(e=>e.hidden=false); $("horseDetail").hidden = true;
  if (!S.horses.length){
    box.innerHTML = `<div class="card"><h3>No horses yet</h3><p class="muted" style="margin:0">Tap <b>+ Add horse</b> to start. Gait checks and heart rates are saved to each horse so you can see how it's tracking.</p></div>`;
    return;
  }
  const q = $("horseSearch").value.trim().toLowerCase();
  const list = q ? S.horses.filter(h => h.name.toLowerCase().includes(q)) : S.horses;
  if (!list.length){ box.innerHTML = `<p class="muted">No horse matches “${esc(q)}”.</p>`; return; }
  box.innerHTML = `<div class="horse-list">${list.map(h => {
    const hc = S.checks.filter(c=>c.horseId===h.id), last = hc[0];
    const hh = S.hr.filter(r=>r.horseId===h.id), lastHr = hh[0];
    const slow = lastHr && hrFlag(lastHr).level==="slow";
    return `<button class="horse" type="button" data-horse="${esc(h.id)}">
      <span class="nm">${esc(h.name)}</span>
      ${last?`<span class="pill p-${last.result.verdict}">${VERDICT[last.result.verdict]}</span>`:`<span class="pill p-unclear">No gait checks</span>`}
      <span class="sm">${h.gait==="trotter"?"Trotter":"Pacer"} · ${hc.length} gait check${hc.length===1?"":"s"} · ${hh.length} heart rate${hh.length===1?"":"s"}${last?` · last check ${fmtDate(last.createdAt).split(",")[0]}`:""}</span>
      ${slow?`<span class="pill p-possible">Slow HR recovery</span>`:""}
    </button>`;}).join("")}</div>`;
  box.querySelectorAll("[data-horse]").forEach(b => b.onclick = () => { S.openHorse = b.dataset.horse; S.openCheck = null; renderHorses(); window.scrollTo(0,0); });
}
function renderHorseDetail(){
  const d = $("horseDetail"); d.hidden = false;
  const h = S.horses.find(x=>x.id===S.openHorse);
  if (!h){ S.openHorse = null; renderHorses(); return; }
  const hc = S.checks.filter(c=>c.horseId===h.id), hh = S.hr.filter(r=>r.horseId===h.id);
  if (S.openCheck){
    const c = hc.find(x=>x.id===S.openCheck);
    if (c){
      d.innerHTML = `<button class="link" type="button" id="backH">← ${esc(h.name)}</button>` + reportHTML(c,{deletable:true});
      $("backH").onclick = () => { S.openCheck = null; renderHorseDetail(); };
      d.querySelector("[data-del]").onclick = () => confirmIn($("delWrap"), "Delete this check for good?", async () => {
        try{ await remove("checks", c.id); S.openCheck = null; renderHorseDetail(); }catch(err){ alertBox("storeNote", saveErrMsg(err)); }
      });
      return;
    }
    S.openCheck = null;
  }
  const graded = hc.filter(c=>c.result.grade!==null).slice(0,20).reverse();
  d.innerHTML = `<button class="link" type="button" id="backAll">← All horses</button>
    <div class="card">
      <div><span class="eyebrow">${h.gait==="trotter"?"Trotter":"Pacer"}</span><h2>${esc(h.name)}</h2>${h.notes?`<p class="muted small" style="margin:4px 0 0">${esc(h.notes)}</p>`:""}</div>
      ${graded.length>1?`<div><p class="small muted" style="margin:0">Grade over the last ${graded.length} checks (oldest to newest, 0–5)</p><div class="trend">${graded.map(c=>`<span title="${esc(fmtDate(c.createdAt))}: grade ${c.result.grade}" style="height:${6+c.result.grade*8}px"></span>`).join("")}</div></div>`:""}
      <div class="row"><button class="btn primary" type="button" id="checkThis">New gait check</button><button class="btn" type="button" id="hrThis">Log heart rate</button></div>
    </div>
    <div class="card"><h3>Heart rate recovery</h3>
      ${hh.length ? hrChart(hh) + `<div class="history">${hh.slice(0,12).map(r=>hrRow(r,false) + `<div class="confirm" data-hrdelwrap="${esc(r.id)}"><button class="link small" type="button" data-hrdel="${esc(r.id)}">Delete reading</button></div>`).join("")}</div>${hh.length>12?`<p class="small muted" style="margin:0">Showing the latest 12 of ${hh.length}.</p>`:""}`
        : `<p class="muted small" style="margin:0">No heart rates logged yet.</p>`}
    </div>
    <h3>Gait check history</h3>
    <div class="history">${hc.length ? hc.map(c=>`<button class="hist" type="button" data-check="${esc(c.id)}">
        ${c.thumbs?.[1]?`<img src="${esc(c.thumbs[1])}" alt="">`:`<img alt="">`}
        <span><span class="d">${esc(fmtDate(c.createdAt))}</span><br><span class="t">${esc(FOOTAGE[c.footage]||c.footage)} · <span class="pill p-${c.result.verdict}">${VERDICT[c.result.verdict]}${c.result.grade!==null?" · "+c.result.grade+"/5":""}</span></span></span>
        <span class="minilimbs" aria-label="Legs">${["LF","RF","LH","RH"].map(k=>`<span class="${c.result.limbs.find(l=>l.limb===k)?.level||"none"}"></span>`).join("")}</span>
      </button>`).join("") : `<p class="muted">No gait checks yet for ${esc(h.name)}.</p>`}</div>
    <div class="confirm" id="delHWrap"><button class="link" type="button" id="delHorse">Remove ${esc(h.name)} and its history</button></div>`;
  $("backAll").onclick = () => { S.openHorse = null; renderHorses(); };
  $("checkThis").onclick = () => { $("horseSel").value = h.id; updateAnalyseBtn(); showTab("check"); };
  $("hrThis").onclick = () => { $("hrHorse").value = h.id; msg("hrMsg","",true); showTab("hr"); };
  d.querySelectorAll("[data-check]").forEach(b => b.onclick = () => { S.openCheck = b.dataset.check; renderHorseDetail(); window.scrollTo(0,0); });
  d.querySelectorAll("[data-hrdel]").forEach(b => b.onclick = () => {
    confirmIn(d.querySelector(`[data-hrdelwrap="${b.dataset.hrdel}"]`), "Delete this reading?", async () => {
      try{ await remove("hr", b.dataset.hrdel); }catch(err){ alertBox("storeNote", saveErrMsg(err)); }
    });
  });
  $("delHorse").onclick = () => confirmIn($("delHWrap"), `Remove ${h.name}, ${hc.length} gait checks and ${hh.length} heart rates?`, async () => {
    try{
      for (const c of hc) await remove("checks", c.id);
      for (const r of hh) await remove("hr", r.id);
      await remove("horses", h.id);
      S.openHorse = null; renderHorses();
    }catch(err){ alertBox("storeNote", saveErrMsg(err)); }
  });
}
function confirmIn(wrap, q, yes){
  wrap.innerHTML = `<span>${esc(q)}</span><button class="btn primary" type="button">Yes, delete</button><button class="btn" type="button">Cancel</button>`;
  const [y,n] = wrap.querySelectorAll("button"); y.onclick = yes; n.onclick = () => renderHorseDetail();
}

boot();
