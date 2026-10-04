/* Palermo Gait Check — movement measurement (markerless)
   Tracks the horse's head, pelvis and hooves frame by frame with an open-source
   animal pose model (RTMPose-m, AP-10K keypoints), then measures left/right
   asymmetry of vertical head and pelvis movement per stride (MinDiff / MaxDiff),
   the same measures objective lameness systems report.  Runs entirely in the browser. */
(() => {
  const MODEL_URL = "https://huggingface.co/hr16/UnJIT-DWPose/resolve/main/rtmpose-m_ap10k_256.onnx";
  const ORT_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
  const K = { L_eye:0, R_eye:1, nose:2, neck:3, tail:4, L_sh:5, L_el:6, L_fp:7, R_sh:8, R_el:9, R_fp:10, L_hip:11, L_kn:12, L_bp:13, R_hip:14, R_kn:15, R_bp:16 };
  const EDGES = [[0,2],[1,2],[0,3],[1,3],[3,5],[5,6],[6,7],[3,8],[8,9],[9,10],[3,4],[4,11],[11,12],[12,13],[4,14],[14,15],[15,16]];
  const THRESH = { head: 6, pelvis: 3, hip: 3 };   // mm, commonly used asymmetry thresholds
  const CROUP_MM = 1550, HEAD_MM = 1750;          // approximate scale references for a Standardbred

  let sessP = null;
  async function getSession(onStatus){
    if (sessP) return sessP;
    sessP = (async () => {
      if (!window.ort) throw new Error("The tracking engine didn't load. Check your internet connection and reload the page.");
      ort.env.wasm.wasmPaths = ORT_BASE;
      let buf = null;
      try {
        const cache = await caches.open("gc-models-v1");
        let r = await cache.match(MODEL_URL);
        if (!r){
          r = await download(MODEL_URL, onStatus);
          try { await cache.put(MODEL_URL, r.clone()); } catch(_){}
        }
        buf = await r.arrayBuffer();
      } catch(e){
        if (!buf) buf = await (await download(MODEL_URL, onStatus)).arrayBuffer();
      }
      onStatus?.("Starting the tracking model…");
      const eps = navigator.gpu ? [["webgpu"], ["wasm"]] : [["wasm"]];
      for (const ep of eps){
        try { const s = await ort.InferenceSession.create(buf, { executionProviders: ep }); s._ep = ep[0]; return s; } catch(_){}
      }
      throw new Error("The tracking model couldn't start on this device. Try Chrome on a computer.");
    })();
    sessP.catch(() => { sessP = null; });
    return sessP;
  }
  async function download(url, onStatus){
    const r = await fetch(url);
    if (!r.ok) throw new Error("Couldn't download the tracking model (" + r.status + ").");
    const total = +r.headers.get("content-length") || 55e6;
    const reader = r.body.getReader(); const chunks = []; let got = 0;
    for (;;){
      const {done, value} = await reader.read(); if (done) break;
      chunks.push(value); got += value.length;
      onStatus?.(`Downloading the horse-tracking model, first time only… ${Math.round(got/1e6)} of ${Math.round(total/1e6)} MB`, got/total);
    }
    return new Response(new Blob(chunks), { headers: { "content-type": "application/octet-stream" } });
  }

  /* ---------- pose on one frame ---------- */
  const S = 256, MEAN = [123.675,116.28,103.53], STD = [58.395,57.12,57.375];
  let cropC = null;
  async function pose(sess, src, box, mask = true){
    const cx = box.x + box.w/2, cy = box.y + box.h/2, side = Math.max(box.w, box.h) * 1.1;
    cropC = cropC || document.createElement("canvas"); cropC.width = S; cropC.height = S;
    const g = cropC.getContext("2d", { willReadFrequently: true });
    g.fillStyle = "#000"; g.fillRect(0,0,S,S);
    g.drawImage(src, cx - side/2, cy - side/2, side, side, 0, 0, S, S);
    // black out everything outside the horse's box, so a handler walking or running
    // beside the horse isn't in the picture the pose model sees
    const sc = S / side, mp = 0.15;
    const mx0 = (box.x - box.w*mp - (cx - side/2)) * sc, mx1 = (box.x + box.w*(1+mp) - (cx - side/2)) * sc;
    const my0 = (box.y - box.h*mp - (cy - side/2)) * sc, my1 = (box.y + box.h*(1+mp) - (cy - side/2)) * sc;
    g.fillStyle = "#000";
    if (mask && mx0 > 0) g.fillRect(0, 0, mx0, S);
    if (mask && mx1 < S) g.fillRect(mx1, 0, S - mx1, S);
    if (mask && my0 > 0) g.fillRect(0, 0, S, my0);
    if (mask && my1 < S) g.fillRect(0, my1, S, S - my1);
    const d = g.getImageData(0,0,S,S).data, f = new Float32Array(3*S*S);
    for (let i = 0; i < S*S; i++){
      f[i] = (d[i*4]-MEAN[0])/STD[0]; f[S*S+i] = (d[i*4+1]-MEAN[1])/STD[1]; f[2*S*S+i] = (d[i*4+2]-MEAN[2])/STD[2];
    }
    const o = await sess.run({ [sess.inputNames[0]]: new ort.Tensor("float32", f, [1,3,S,S]) });
    const X = o[sess.outputNames[0]].data, Y = o[sess.outputNames[1]].data, L = X.length/17;
    const refine = (A, off, b) => { if (b <= 0 || b >= L-1) return b; const l = A[off+b-1], c = A[off+b], r = A[off+b+1], den = l - 2*c + r; return den < 0 ? b + 0.5*(l - r)/den : b; };
    const kp = [];
    for (let k = 0; k < 17; k++){
      let bx = 0, vx = -1e9, by = 0, vy = -1e9;
      for (let i = 0; i < L; i++){ const a = X[k*L+i], b = Y[k*L+i]; if (a > vx){ vx = a; bx = i; } if (b > vy){ vy = b; by = i; } }
      const px = refine(X, k*L, bx) / (L/S), py = refine(Y, k*L, by) / (L/S);
      kp.push({ x: cx - side/2 + px*side/S, y: cy - side/2 + py*side/S, s: Math.max(0, Math.min(1, Math.min(vx, vy))) });
    }
    return kp;
  }

  const seekTo = (v, t) => new Promise(res => { let done = false; const fin = () => { if (!done){ done = true; res(); } };
    v.addEventListener("seeked", fin, { once: true }); setTimeout(fin, 3000); v.currentTime = Math.max(0, t); });
  /* Step forward through the video by playing it a frame at a time, rather than jumping
     (seeking) to every frame. Phone videos (especially iPhone .mov) are slow to seek because
     each jump re-decodes from the last keyframe; playing forward decodes each frame once. */
  const canStep = typeof HTMLVideoElement !== "undefined" && "requestVideoFrameCallback" in HTMLVideoElement.prototype;
  function stepTo(v, t){
    return new Promise(res => {
      let done = false, handle = 0;
      const fin = (ok) => { if (done) return; done = true; try { v.pause(); } catch(_){} if (handle) try { v.cancelVideoFrameCallback(handle); } catch(_){} res(ok); };
      const tick = (_now, meta) => { if (meta.mediaTime >= t - 0.004) fin(true); else handle = v.requestVideoFrameCallback(tick); };
      handle = v.requestVideoFrameCallback(tick);
      setTimeout(() => fin(false), 2500);
      v.play().catch(() => fin(false));
    });
  }

  /* ---------- track through the clip ---------- */
  async function track({ video, start, end, box, fps = 25, onStatus, onFrame, signal, poseFn }){
    const sess = await getSession(onStatus);
    const P = poseFn || ((src, bx, mask) => pose(sess, src, bx, mask));
    try { await video.play(); video.pause(); } catch(_){}
    const n = Math.max(1, Math.floor((end - start) * fps));
    const frames = []; let b = { ...box }, lost = 0, prev = null, stepping = canStep && !poseFn; const t0 = performance.now();
    const rate0 = video.playbackRate; video.playbackRate = 1;
    const grow = (bx, m) => ({ x: bx.x - bx.w*m, y: bx.y - bx.h*m, w: bx.w*(1+2*m), h: bx.h*(1+2*m) });
    const keepIn = (kp, bx, m) => { const x0 = bx.x - bx.w*m, x1 = bx.x + bx.w*(1+m), y0 = bx.y - bx.h*m, y1 = bx.y + bx.h*(1+m);
      kp.forEach(p => { if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) p.s = 0; }); return kp; };
    const score = (kp) => ({ good: kp.filter(p => p.s > 0.3).length, conf: kp.reduce((a, p) => a + p.s, 0) / 17 });
    for (let i = 0; i < n; i++){
      if (signal?.aborted){ video.playbackRate = rate0; throw { name: "AbortError" }; }
      const t = start + i / fps;
      if (i === 0 || !stepping) await seekTo(video, t);
      else if (video.currentTime < t - 0.004 && !(await stepTo(video, t))){ stepping = false; await seekTo(video, t); }
      // Look only inside the horse's box (everything else is blacked out, so the handler,
      // posts and rails aren't seen). If the horse has slipped out of the box, look in a
      // slightly bigger box — never the whole picture.
      let kp = keepIn(await P(video, b, true), b, 0.15), sc = score(kp);
      if (sc.good < 8 || sc.conf < 0.35){
        const big = grow(b, 0.35), kp2 = keepIn(await P(video, big, true), big, 0.05), sc2 = score(kp2);
        if (sc2.conf > sc.conf + 0.05){ kp = kp2; sc = sc2; }
      }
      // A body point can't jump across the picture in 1/25 of a second: drop any point that
      // leaps further than ~35% of the horse's height from where it was (that's a post or the track).
      if (prev){
        const lim = 0.35 * b.h;
        kp.forEach((p, k) => { const q = prev[k]; if (p.s > 0.3 && q && q.s > 0.3 && Math.hypot(p.x - q.x, p.y - q.y) > lim) p.s = 0; });
      }
      // Drop stragglers far from the rest of the horse.
      { const g = kp.filter(p => p.s > 0.3);
        if (g.length >= 5){
          const mx = g.map(p => p.x).sort((a, c) => a - c)[g.length >> 1], my = g.map(p => p.y).sort((a, c) => a - c)[g.length >> 1];
          const r = 0.75 * Math.max(b.w, b.h);
          kp.forEach(p => { if (p.s > 0.3 && Math.hypot(p.x - mx, p.y - my) > r) p.s = 0; });
        } }
      sc = score(kp);
      const conf = sc.conf;
      frames.push({ t, kp, box: { ...b }, conf, vh: video.videoHeight || 0 });
      // remember each point's last good position (for the jump check), forgetting it after a few frames
      prev = kp.map((p, k) => p.s > 0.3 ? { ...p, age: 0 } : (prev && prev[k] && prev[k].age < 4 ? { ...prev[k], age: prev[k].age + 1 } : null));
      const good = kp.filter(p => p.s > 0.3);
      if (good.length >= 8 && conf > 0.35){
        lost = 0;
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const p of good){ x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
        const w = x1 - x0, h = y1 - y0, pad = 0.18;
        const nb = { x: x0 - w*pad, y: y0 - h*pad, w: w*(1+2*pad), h: h*(1+2*pad) };
        // limit how fast the box can change so one bad frame can't drag it off the horse
        const lim = (a, bb, r) => Math.max(a*(1-r), Math.min(a*(1+r), bb));
        nb.w = lim(b.w, nb.w, 0.12); nb.h = lim(b.h, nb.h, 0.12);
        let ncx = nb.x + nb.w/2, ncy = nb.y + nb.h/2; const ocx = b.x + b.w/2, ocy = b.y + b.h/2;
        ncx = Math.max(ocx - b.w*0.15, Math.min(ocx + b.w*0.15, ncx)); ncy = Math.max(ocy - b.h*0.15, Math.min(ocy + b.h*0.15, ncy));
        const k = 0.6, cx = ocx + (ncx - ocx)*k, cy = ocy + (ncy - ocy)*k, w2 = b.w + (nb.w - b.w)*k, h2 = b.h + (nb.h - b.h)*k;
        b = { x: cx - w2/2, y: cy - h2/2, w: w2, h: h2 };
      } else if (++lost > 12) break;   // horse not clearly seen: keep the box where it was rather than chase it
      const per = (performance.now() - t0) / (i + 1);
      onFrame?.({ i: i + 1, n, kp, box: b, t, eta: Math.round(per * (n - i - 1) / 1000), ep: sess._ep });
    }
    video.playbackRate = rate0;
    return frames;
  }

  /* ---------- signal helpers ---------- */
  const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const median = a => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length/2)] : NaN; };
  function interp(a){ // fill NaN gaps linearly (short gaps only)
    const out = a.slice(); let last = -1;
    for (let i = 0; i < out.length; i++){
      if (Number.isFinite(out[i])){
        if (last >= 0 && i - last > 1 && i - last <= 6) for (let j = last + 1; j < i; j++) out[j] = out[last] + (out[i] - out[last]) * (j - last) / (i - last);
        last = i;
      }
    }
    return out;
  }
  function movAvg(a, w){ const h = Math.max(1, Math.floor(w/2)), out = new Array(a.length).fill(NaN);
    for (let i = 0; i < a.length; i++){ let s = 0, c = 0; for (let j = i - h; j <= i + h; j++) if (j >= 0 && j < a.length && Number.isFinite(a[j])){ s += a[j]; c++; } out[i] = c ? s/c : NaN; } return out; }
  function medFilt(a, w){ const h = Math.floor(w/2); return a.map((_, i) => median(a.slice(Math.max(0, i-h), i+h+1))); }
  function stepPeriod(sig, fps){ // autocorrelation in 0.22–0.55 s (one step = half a stride)
    const x = sig.map(v => Number.isFinite(v) ? v : 0), m = mean(x), y = x.map(v => v - m);
    let best = 0, bestLag = Math.round(0.35 * fps);
    for (let lag = Math.round(0.22*fps); lag <= Math.round(0.55*fps); lag++){
      let s = 0, c = 0; for (let i = 0; i + lag < y.length; i++){ if (Number.isFinite(sig[i]) && Number.isFinite(sig[i+lag])){ s += y[i]*y[i+lag]; c++; } }
      const r = c ? s / c : 0; if (r > best){ best = r; bestLag = lag; }
    }
    return bestLag;
  }
  function extrema(sig, per, kind){ // local minima (kind=-1) or maxima (kind=1)
    const w = Math.max(2, Math.round(per * 0.4)), out = [];
    for (let i = w; i < sig.length - w; i++){
      const v = sig[i]; if (!Number.isFinite(v)) continue;
      let ok = true;
      for (let j = i - w; j <= i + w; j++){ if (j === i || !Number.isFinite(sig[j])) continue; if (kind < 0 ? sig[j] < v : sig[j] > v){ ok = false; break; } }
      if (ok && (!out.length || i - out[out.length-1] >= w)) out.push(i);
    }
    return out;
  }

  /* ---------- analysis ---------- */
  function analyse(frames, { fps = 25, direction = "auto" } = {}){
    const n = frames.length;
    const kpv = (k, i) => { const p = frames[i].kp[k]; return p.s > 0.3 ? p : null; };
    // scale references per frame
    const hindScale = frames.map((f, i) => { const t = kpv(K.tail, i), a = kpv(K.L_bp, i), b = kpv(K.R_bp, i); const paw = [a, b].filter(Boolean); return t && paw.length ? Math.max(...paw.map(p => p.y)) - t.y : NaN; });
    const foreScale = frames.map((f, i) => { const e = [kpv(K.L_eye, i), kpv(K.R_eye, i), kpv(K.nose, i)].filter(Boolean), paw = [kpv(K.L_fp, i), kpv(K.R_fp, i)].filter(Boolean); return e.length && paw.length ? Math.max(...paw.map(p => p.y)) - mean(e.map(p => p.y)) : NaN; });
    const size = medFilt(frames.map(f => f.box.h), 11);
    // direction per frame from change in apparent size
    const logS = size.map(Math.log), win = Math.round(fps * 0.8);
    const dir = frames.map((_, i) => {
      if (direction === "away" || direction === "towards") return direction;
      const a = logS[Math.max(0, i - win)], b = logS[Math.min(n - 1, i + win)], dt = (Math.min(n-1, i+win) - Math.max(0, i-win)) / fps;
      const slope = (b - a) / (dt || 1);
      return slope < -0.04 ? "away" : slope > 0.04 ? "towards" : "turn";
    });
    const faceVis = frames.map((_, i) => [K.L_eye, K.R_eye, K.nose].some(k => frames[i].kp[k].s > 0.45));
    // Only measure while the horse is big enough in the picture: once it's far away (less than
    // about an eighth of the picture height) a few pixels of tracking wobble swamp the real movement.
    const bigEnough = frames.map(f => !f.vh || f.box.h >= f.vh * 0.12);

    const parts = {};
    // ---- pelvis (from behind: horse moving away) ----
    // Pelvis height = tail-head point, backed up by the two hip points when the tail isn't picked up
    // (each hip is shifted onto the tail's level first, so switching between them doesn't add a jump).
    const offOf = (k) => median(frames.map((_, i) => { const t = kpv(K.tail, i), p = kpv(k, i); return t && p ? p.y - t.y : NaN; }));
    const offL = offOf(K.L_hip), offR = offOf(K.R_hip);
    const pelvisY = i => {
      const t = kpv(K.tail, i); if (t) return t.y;
      const v = []; const l = kpv(K.L_hip, i), r = kpv(K.R_hip, i);
      if (l && Number.isFinite(offL)) v.push(l.y - offL); if (r && Number.isFinite(offR)) v.push(r.y - offR);
      return v.length ? mean(v) : NaN;
    };
    parts.pelvis = measurePart({
      frames, fps, use: i => dir[i] === "away" && bigEnough[i],
      yOf: pelvisY,
      scaleOf: i => hindScale[i], scaleMm: CROUP_MM,
      pawsOf: i => { const a = kpv(K.L_bp, i), b = kpv(K.R_bp, i); if (!a || !b) return null; const [l, r] = a.x < b.x ? [a, b] : [b, a]; return { left: l, right: r }; }, // away: image-left = horse's left
      thr: THRESH.pelvis, noiseMax: 35
    });
    // hip hike from behind: vertical travel of each hip point
    parts.hips = hipHike(frames, fps, i => dir[i] === "away" && bigEnough[i], hindScale);
    // ---- head (from the front: horse coming towards) ----
    parts.head = measurePart({
      frames, fps, use: i => dir[i] === "towards" && faceVis[i] && bigEnough[i],
      yOf: i => { const e = [kpv(K.L_eye, i), kpv(K.R_eye, i), kpv(K.nose, i)].filter(Boolean); return e.length ? mean(e.map(p => p.y)) : NaN; },
      scaleOf: i => foreScale[i], scaleMm: HEAD_MM,
      pawsOf: i => { const a = kpv(K.L_fp, i), b = kpv(K.R_fp, i); if (!a || !b) return null; const [l, r] = a.x > b.x ? [a, b] : [b, a]; return { left: l, right: r }; }, // towards: image-right = horse's left
      thr: THRESH.head, noiseMax: 50
    });
    const counts = { away: dir.filter(d => d === "away").length / fps, towards: dir.filter(d => d === "towards").length / fps,
      awayClose: dir.filter((d, i) => d === "away" && bigEnough[i]).length / fps, towardsClose: dir.filter((d, i) => d === "towards" && bigEnough[i]).length / fps };
    return { parts, counts, meanConf: mean(frames.map(f => f.conf)), fps, frames: n };
  }

  function measurePart({ frames, fps, use, yOf, scaleOf, scaleMm, pawsOf, thr, noiseMax }){
    const n = frames.length;
    const scaleMed = median(frames.map((_, i) => use(i) ? scaleOf(i) : NaN));
    const raw = frames.map((_, i) => { if (!use(i)) return NaN; const y = yOf(i), s = medianNear(scaleOf, i, n); return Number.isFinite(y) && s > 0 ? -y / s * scaleMm : NaN; });
    const sig0 = interp(raw);
    const avail = sig0.filter(Number.isFinite).length / fps;
    if (!Number.isFinite(scaleMed) || avail < 2) return { ok: false, reason: "not enough footage from this angle", seconds: +avail.toFixed(1) };
    const per0 = stepPeriod(movAvg(sig0, 3), fps);
    const trend = movAvg(sig0, per0 * 2 + 1);
    const sig = movAvg(sig0.map((v, i) => v - trend[i]), Math.max(3, Math.round(per0 * 0.35) | 1));   // detrended, smoothed, mm (up = +)
    const around = (i) => mean([sig[i-1], sig[i], sig[i+1]].filter(Number.isFinite));
    const mins = extrema(sig, per0, -1), maxs = extrema(sig, per0, 1);
    // side of each minimum: the lower (stance) paw at that moment
    const votes = mins.map(i => {
      let s = 0;
      for (let j = i - 1; j <= i + 1; j++){ if (j < 0 || j >= n) continue; const p = pawsOf(j); if (!p) continue; s += Math.sign(p.left.y - p.right.y); } // + => left paw lower (on ground)
      return s > 0 ? 1 : s < 0 ? -1 : 0;
    });
    // split into runs of evenly spaced steps, enforce left/right alternation within each run
    const runs = []; let cur = [];
    mins.forEach((m, k) => { if (cur.length && (m - mins[cur[cur.length-1]]) > per0 * 1.6){ runs.push(cur); cur = []; } cur.push(k); });
    if (cur.length) runs.push(cur);
    const steps = []; let agreeVotes = 0, totalVotes = 0;
    for (const run of runs){
      if (run.length < 3) continue;
      let score = 0; run.forEach((k, j) => { score += votes[k] * (j % 2 === 0 ? 1 : -1); });
      const firstLeft = score >= 0;
      run.forEach((k, j) => {
        const side = ((j % 2 === 0) === firstLeft) ? "L" : "R";
        if (votes[k]){ totalVotes++; if ((votes[k] > 0) === (side === "L")) agreeVotes++; }
        const i = mins[k], nextMin = run[j+1] !== undefined ? mins[run[j+1]] : i + per0;
        const mx = maxs.filter(q => q > i && q < nextMin).sort((a, b) => sig[b] - sig[a])[0];
        steps.push({ i, side, min: around(i), max: mx !== undefined ? around(mx) : NaN, run: runs.indexOf(run) });
      });
    }
    // stride pairs: consecutive L & R steps in the same run
    const pairs = [];
    for (let k = 0; k + 1 < steps.length; k += 1){
      const a = steps[k], b = steps[k+1];
      if (a.run !== b.run || a.side === b.side) continue;
      const L = a.side === "L" ? a : b, R = a.side === "L" ? b : a;
      pairs.push({ minDiff: L.min - R.min, maxDiff: (Number.isFinite(L.max) && Number.isFinite(R.max)) ? L.max - R.max : NaN });
      k++; // non-overlapping pairs
    }
    const md = pairs.map(p => p.minDiff), xd = pairs.map(p => p.maxDiff).filter(Number.isFinite);
    const stat = a => { if (!a.length) return { mean: NaN, sd: NaN, agree: 0 }; const m = a.length >= 4 ? median(a) : mean(a), sd = Math.sqrt(mean(a.map(x => (x - m)**2))); return { mean: m, sd, agree: a.filter(x => Math.sign(x) === Math.sign(m)).length / a.length }; };
    const amp = median(steps.map(s => Number.isFinite(s.max) ? s.max - s.min : NaN));
    const sdMin = stat(md).sd, noisy = pairs.length >= 3 && Number.isFinite(sdMin) && sdMin > (noiseMax || 40);
    return {
      ok: pairs.length >= 3 && !noisy, reason: pairs.length < 3 ? "too few clear strides" : noisy ? "the movement couldn't be read steadily (the horse was too far away or too small in the picture, or the camera moved)" : "",
      seconds: +avail.toFixed(1), strides: pairs.length, stepMs: Math.round(per0 / fps * 1000), amplitude: amp,
      minDiff: stat(md), maxDiff: stat(xd), sideCheck: totalVotes ? agreeVotes / totalVotes : 0, thr,
      trace: sig.map(v => Number.isFinite(v) ? Math.round(v * 10) / 10 : null), steps: steps.map(s => ({ i: s.i, side: s.side }))
    };
  }
  function medianNear(f, i, n){ const a = []; for (let j = Math.max(0, i - 6); j <= Math.min(n - 1, i + 6); j++) a.push(f(j)); return median(a); }
  function hipHike(frames, fps, use, scaleArr){
    const L = [], R = [];
    frames.forEach((f, i) => {
      if (!use(i)) return; const a = f.kp[K.L_hip], b = f.kp[K.R_hip], s = scaleArr[i];
      if (a.s < 0.3 || b.s < 0.3 || !(s > 0)) { L.push(NaN); R.push(NaN); return; }
      const [l, r] = a.x < b.x ? [a, b] : [b, a];
      L.push(-l.y / s * CROUP_MM); R.push(-r.y / s * CROUP_MM);
    });
    if (L.filter(Number.isFinite).length < fps * 2) return { ok: false };
    const per = stepPeriod(movAvg(interp(L), 3), fps);
    const range = arr => { const x = interp(arr), tr = movAvg(x, per*2+1), d = x.map((v, i) => v - tr[i]); const w = per * 2, out = [];
      for (let i = 0; i + w < d.length; i += w){ const seg = d.slice(i, i + w).filter(Number.isFinite); if (seg.length > w * 0.7) out.push(Math.max(...seg) - Math.min(...seg)); } return out; };
    const rl = range(L), rr = range(R), k = Math.min(rl.length, rr.length);
    if (k < 2) return { ok: false };
    const diffs = rl.slice(0, k).map((v, i) => v - rr[i]), m = mean(diffs), sd = Math.sqrt(mean(diffs.map(x => (x - m) ** 2)));
    if (sd > 35) return { ok: false, noisy: true };
    return { ok: true, diff: m, agree: diffs.filter(x => Math.sign(x) === Math.sign(m)).length / diffs.length, strides: k, thr: THRESH.hip };
  }

  /* ---------- turn numbers into a report ---------- */
  // Level from size (vs threshold), consistency across strides, and how clearly it stands out from stride-to-stride noise.
  function levelFor(value, agree, strides, thr, sd){
    if (!Number.isFinite(value) || strides < 3) return "none";
    const r = Math.abs(value) / thr, t = Number.isFinite(sd) && sd > 0 ? Math.abs(value) / (sd / Math.sqrt(strides)) : 10;
    if (r >= 2 && agree >= 0.75 && strides >= 6 && t >= 3) return "likely";
    if (r >= 1.3 && agree >= 0.7 && strides >= 5 && t >= 2.5) return "suspect";
    if (r >= 1 && agree >= 0.65 && strides >= 4 && t >= 2) return "watch";
    return "none";
  }
  const rank = { none: 0, watch: 1, suspect: 2, likely: 3 };
  function report(a, gait){
    const f = n => Number.isFinite(n) ? (n > 0 ? "+" : "") + n.toFixed(1) : "–";
    const P = a.parts.pelvis, Hd = a.parts.head, Hp = a.parts.hips;
    const limbs = { LF: { limb: "LF", level: "none", reason: "" }, RF: { limb: "RF", level: "none", reason: "" }, LH: { limb: "LH", level: "none", reason: "" }, RH: { limb: "RH", level: "none", reason: "" } };
    const bump = (limb, level, reason) => { if (rank[level] > rank[limbs[limb].level]) limbs[limb].level = level; if (reason) limbs[limb].reason = (limbs[limb].reason ? limbs[limb].reason + " " : "") + reason; };
    const obs = [];
    // Forelimbs from head: head stays higher (less drop) while the lame fore bears weight => higher minimum on the lame side
    // Use the stronger of MinDiff / MaxDiff; only add the other if it points to the same leg.
    // MinDiff (impact) leads. MaxDiff (push-off) only adds weight when it agrees, or stands alone (capped) when MinDiff is quiet.
    const pick2 = (p, minMsg, maxMsg, L, R) => {
      const a = { lv: levelFor(p.minDiff.mean, p.minDiff.agree, p.strides, p.thr, p.minDiff.sd), side: p.minDiff.mean > 0 ? L : R, r: Math.abs(p.minDiff.mean)/p.thr, msg: minMsg };
      const b = { lv: levelFor(p.maxDiff.mean, p.maxDiff.agree, p.strides, p.thr, p.maxDiff.sd), side: p.maxDiff.mean < 0 ? L : R, r: Math.abs(p.maxDiff.mean)/p.thr, msg: maxMsg };
      if (a.lv !== "none"){ bump(a.side, a.lv, a.msg); if (b.lv !== "none" && b.side === a.side) bump(b.side, b.lv, b.msg); }
      else if (b.lv !== "none" && a.r < 0.6) bump(b.side, b.lv === "likely" ? "suspect" : b.lv, b.msg);
    };
    if (Hd.ok){
      pick2(Hd, `Head drops ${Math.abs(Hd.minDiff.mean).toFixed(0)} mm less when this leg lands (${Math.round(Hd.minDiff.agree*100)}% of strides).`,
        `Head lifts ${Math.abs(Hd.maxDiff.mean).toFixed(0)} mm less after this leg pushes off.`, "LF", "RF");
      obs.push({ when: "Head", note: `MinDiff ${f(Hd.minDiff.mean)} mm, MaxDiff ${f(Hd.maxDiff.mean)} mm over ${Hd.strides} strides (+ = left side higher). Threshold about ${Hd.thr} mm.` });
    }
    // Hindlimbs from pelvis: less drop during lame hind stance (MinDiff), less rise after its push-off (MaxDiff)
    if (P.ok){
      pick2(P, `Pelvis drops ${Math.abs(P.minDiff.mean).toFixed(0)} mm less when this leg lands (${Math.round(P.minDiff.agree*100)}% of strides).`,
        `Pelvis rises ${Math.abs(P.maxDiff.mean).toFixed(0)} mm less after this leg pushes off (${Math.round(P.maxDiff.agree*100)}% of strides).`, "LH", "RH");
      obs.push({ when: "Pelvis", note: `MinDiff ${f(P.minDiff.mean)} mm, MaxDiff ${f(P.maxDiff.mean)} mm over ${P.strides} strides (+ = left side higher). Threshold about ${P.thr} mm.` });
    }
    if (Hp.ok){
      const lv = levelFor(Hp.diff, Hp.agree, Hp.strides + 3, Hp.thr);
      if (lv !== "none") bump(Hp.diff > 0 ? "LH" : "RH", lv === "likely" ? "suspect" : lv, `This hip travels ${Math.abs(Hp.diff).toFixed(0)} mm further up and down (hip hike).`);
      obs.push({ when: "Hips", note: `Left hip travels ${f(Hp.diff)} mm more than the right on average.` });
    }
    const top = Object.values(limbs).reduce((m, l) => Math.max(m, rank[l.level]), 0);
    const haveHead = Hd.ok, havePel = P.ok, haveHips = !P.ok && Hp.ok && Hp.strides >= 3;
    let verdict = "unclear";
    if (haveHead || havePel) verdict = top >= 3 ? "lame" : top >= 1 ? "possible" : "sound";
    else if (haveHips && top >= 1) verdict = "possible";   // hips only: can raise a flag, but can't clear the horse
    const flagged = Object.values(limbs).filter(l => l.level !== "none").sort((a, b) => rank[b.level] - rank[a.level]);
    const LN = { LF: "left fore", RF: "right fore", LH: "left hind", RH: "right hind" };
    let summary;
    if (verdict === "unclear") summary = "Not enough clear strides could be measured. Check the filming tips and try again.";
    else if (!flagged.length) summary = `Movement measured as even on the ${[haveHead && "front", havePel && "hind"].filter(Boolean).join(" and ")} end.`;
    else summary = `Asymmetry measured, pointing to the ${flagged.map(l => LN[l.limb]).join(" and ")}. ${flagged[0].reason}`;
    const missing = [];
    if (!haveHead) missing.push(`Front legs not measured: ${Hd.reason || "no footage"} (needs the horse jogging towards the camera, head free).`);
    if (!havePel && haveHips) missing.push(`Hind legs: only the hip movement could be read, not the full pelvis, so treat this as a rough guide.`);
    else if (!havePel) missing.push(`Hind legs not measured: ${P.reason || "no footage"} (needs the horse jogging away from the camera).`);
    if (missing.length) summary += " " + missing.join(" ");
    const strides = (haveHead ? Hd.strides : 0) + (havePel ? P.strides : 0);
    const confidence = strides >= 16 && a.meanConf > 0.55 ? "medium" : "low";
    const next = [];
    if (verdict === "lame") next.push("Check that leg for heat, swelling and a digital pulse, and hoof-test it. Call your vet if it doesn't settle.");
    if (verdict === "possible") next.push("Re-film tomorrow the same way and compare. Consistent results on the same leg are more meaningful than one clip.");
    next.push("These are measurements from our free tracking model, not a validated system. Use them to spot changes over time for each horse.");
    const tips = [];
    if (a.meanConf < 0.5) tips.push("The tracking wasn't confident. Film closer, in good light, with a plain background.");
    const secs = (x) => `${x.toFixed(1)} s`, C = a.counts;
    if (!haveHead) tips.push(C.towards < 2
      ? "Front legs are measured from the head nod, which needs the horse jogging straight back TOWARDS you for 6 to 8 strides (about 5 seconds). Film the jog away, the turn and the jog back in one clip."
      : C.towardsClose < 2
        ? `The jog back towards you was there (${secs(C.towards)}), but the horse was too far away for most of it. Start the jog back no more than 20 to 25 m from the camera.`
        : `The jog back towards you was there (${secs(C.towards)}), but the head and front hooves weren't picked up clearly enough to count steps. Keep the phone still, the horse's head free and both front hooves in view.`);
    if (!havePel) tips.push(C.away < 2
      ? "Hind legs are measured from the pelvis, which needs the horse jogging straight away from you for 6 to 8 strides (about 5 seconds)."
      : C.awayClose < 2
        ? `The jog away was there (${secs(C.away)}), but the horse got too small in the picture too quickly. Jog only 20 to 25 m away before turning, so the horse stays at least an eighth of the picture height. Standing closer, or zooming in a little (2×), also helps.`
        : `The jog away was there (${secs(C.away)}), but the tail, hips and hind hooves weren't picked up steadily enough to count steps. Keep the phone still and the whole back end in view, and keep the handler out to the side.`);
    if ((haveHead && Hd.sideCheck < 0.6) || (havePel && P.sideCheck < 0.6)) tips.push("Keep all four hooves in view the whole time, so left and right steps can be told apart.");
    return {
      verdict, grade: null, confidence, gait_seen: gait === "trotter" ? "trot" : "pace",
      summary, limbs: Object.values(limbs), observations: obs,
      footage: { rating: a.meanConf > 0.6 ? "good" : a.meanConf > 0.45 ? "fair" : "poor", issues: [] },
      next_steps: next, refilm_tips: tips
    };
  }

  function draw(g, kp, box){
    g.lineWidth = 3; g.strokeStyle = "rgba(255,255,255,.8)";
    for (const [a, b] of EDGES){ if (kp[a].s > 0.3 && kp[b].s > 0.3){ g.beginPath(); g.moveTo(kp[a].x, kp[a].y); g.lineTo(kp[b].x, kp[b].y); g.stroke(); } }
    kp.forEach((p, i) => { if (p.s < 0.3) return; g.fillStyle = i <= 2 ? "#ffd400" : i === 4 ? "#00e5ff" : [11,14].includes(i) ? "#ff4fd8" : [7,10,13,16].includes(i) ? "#7CFC00" : "#ffffff"; g.beginPath(); g.arc(p.x, p.y, Math.max(4, box.h/90), 0, 7); g.fill(); });
    if (box){ g.strokeStyle = "rgba(0,229,255,.7)"; g.lineWidth = 2; g.strokeRect(box.x, box.y, box.w, box.h); }
  }

  window.Measure = { getSession, track, analyse, report, draw, THRESH };
})();
