/* Palermo Racing Diary — gait check with three motion sensors (M5StickS3).
   HEAD on the poll, PELVIS on the croup between the hip bones, R FORE on the right fore pastern.
   The method follows the published inertial-sensor approach (Keegan et al.): the head and pelvis
   go down less while the sore leg is on the ground and come up less after it pushes off.
   We measure that difference in millimetres for each stride and average it.
   Exposed as window.Sensors. */
(function(){
  "use strict";

  const SVC  = "7a1e0001-5c2b-4c7e-9d6a-50a1e2a0c0de";
  const CTRL = "7a1e0002-5c2b-4c7e-9d6a-50a1e2a0c0de";
  const EVT  = "7a1e0003-5c2b-4c7e-9d6a-50a1e2a0c0de";
  const DATA = "7a1e0004-5c2b-4c7e-9d6a-50a1e2a0c0de";
  const ROLES = { HEAD: "head", PELV: "pelvis", RFORE: "rfore" };
  const ROLE_LABEL = { head: "Head", pelvis: "Pelvis", rfore: "Right fore" };
  const FS = 100;                         // sensor sample rate (Hz)
  const ACC_LSB = 2048, GYR_LSB = 16.384; // ±16 g, ±2000 dps
  const G = 9.80665;

  const enc = new TextEncoder(), dec = new TextDecoder();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /* ======================= Bluetooth ======================= */
  const supported = () => !!(navigator.bluetooth && navigator.bluetooth.requestDevice);

  class Stick {
    constructor(device){
      this.device = device; this.name = device.name || "";
      this.role = ROLES[this.name.replace(/^PRD-/, "")] || null;
      this.status = null; this.offsetMs = null; this.rtt = null;
      this._waiters = []; this._chunks = new Map(); this._onChange = null;
    }
    async open(){
      this.server = await this.device.gatt.connect();
      const svc = await this.server.getPrimaryService(SVC);
      this.ctrl = await svc.getCharacteristic(CTRL);
      this.evt = await svc.getCharacteristic(EVT);
      this.data = await svc.getCharacteristic(DATA);
      this.evt.addEventListener("characteristicvaluechanged", (e) => this._evt(dec.decode(e.target.value)));
      this.data.addEventListener("characteristicvaluechanged", (e) => this._data(e.target.value));
      await this.evt.startNotifications();
      await this.data.startNotifications();
      this.device.addEventListener("gattserverdisconnected", () => { this.status = null; this._onChange?.(this); });
      await this.cmd("STATUS");
      await this.waitFor(m => m.startsWith("S,"), 4000).catch(() => {});
      return this;
    }
    get connected(){ return !!this.device.gatt?.connected; }
    async reconnect(){ if (!this.connected) await this.open(); }
    async cmd(text){
      const v = enc.encode(text);
      if (this.ctrl.writeValueWithoutResponse) return this.ctrl.writeValueWithoutResponse(v).catch(() => this.ctrl.writeValue(v));
      return this.ctrl.writeValue(v);
    }
    waitFor(test, ms){
      return new Promise((resolve, reject) => {
        const w = { test, resolve, t: setTimeout(() => { this._waiters = this._waiters.filter(x => x !== w); reject(new Error("timeout")); }, ms) };
        this._waiters.push(w);
      });
    }
    _evt(msg){
      const t = performance.now();
      if (msg.startsWith("S,")){
        const p = msg.split(",");
        this.status = { role: ROLES[p[1]] || null, recording: p[2] === "1", battery: +p[3], n: +p[4], t0us: +p[5], t1us: +p[6], fw: p[7], nowUs: +p[8] };
        if (this.status.role) this.role = this.status.role;
        this._onChange?.(this);
      }
      for (const w of [...this._waiters]) if (w.test(msg, t)){ clearTimeout(w.t); this._waiters = this._waiters.filter(x => x !== w); w.resolve({ msg, t }); }
    }
    _data(dv){
      const start = dv.getUint32(0, true), n = (dv.byteLength - 4) / 12;
      const arr = new Int16Array(n * 6);
      for (let i = 0; i < n * 6; i++) arr[i] = dv.getInt16(4 + i * 2, true);
      this._chunks.set(start, arr);
    }
    // Line up this stick's clock with the phone's: several quick pings, keep the fastest reply.
    async sync(tries = 10){
      let best = null;
      for (let i = 0; i < tries; i++){
        const id = String(Math.floor(Math.random() * 1e9));
        const t0 = performance.now();
        await this.cmd("PING:" + id);
        try{
          const { msg, t } = await this.waitFor(m => m.startsWith("P," + id + ","), 1500);
          const devMs = +msg.split(",")[2] / 1000, rtt = t - t0;
          const off = devMs - (t0 + rtt / 2);          // stick time minus phone time
          if (!best || rtt < best.rtt) best = { rtt, off };
        }catch(_){}
        await sleep(30);
      }
      if (!best) throw new Error(`${ROLE_LABEL[this.role] || this.name} didn't answer`);
      this.offsetMs = best.off; this.rtt = best.rtt;
      return best;
    }
    // Download the recording in windows; re-ask for anything that went missing.
    async download(onProgress){
      await this.cmd("STATUS");
      await this.waitFor(m => m.startsWith("S,"), 3000).catch(() => {});
      const st = this.status; if (!st || !st.n) throw new Error(`${ROLE_LABEL[this.role]} has no recording`);
      const N = st.n, out = new Int16Array(N * 6), have = new Uint8Array(N);
      this._chunks.clear();
      const WIN = 336;
      const absorb = () => { for (const [s, a] of this._chunks){ out.set(a.subarray(0, Math.min(a.length, (N - s) * 6)), s * 6); have.fill(1, s, Math.min(N, s + a.length / 6)); } this._chunks.clear(); };
      for (let pass = 0; pass < 4; pass++){
        let s = 0, missing = 0;
        while (s < N){
          if (have[s]){ s++; continue; }
          let e = s; while (e < N && e - s < WIN && !have[e]) e++;
          await this.cmd(`READ:${s}:${e - s}`);
          await this.waitFor(m => m.startsWith(`D,${s},`), 6000).catch(() => {});
          await sleep(30);
          absorb();
          onProgress?.(have.reduce((a, b) => a + b, 0) / N);
          s = e;
        }
        for (let i = 0; i < N; i++) if (!have[i]) missing++;
        if (!missing) break;
      }
      const got = have.reduce((a, b) => a + b, 0);
      if (got < N * 0.995) throw new Error(`${ROLE_LABEL[this.role]}: only ${Math.round(got / N * 100)}% downloaded. Bring the phone closer and try again.`);
      return { raw: out, n: N, t0us: st.t0us, t1us: st.t1us, offsetMs: this.offsetMs };
    }
    disconnect(){ try{ this.device.gatt.disconnect(); }catch(_){} }
  }

  async function connectOne(){
    if (!supported()) throw new Error("This browser can't use Bluetooth. On iPhone, open the diary in the free Bluefy app.");
    const device = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: "PRD-" }], optionalServices: [SVC] });
    const s = new Stick(device);
    await s.open();
    return s;
  }

  /* ======================= signal helpers ======================= */
  // 2nd-order Butterworth biquad, run forwards and backwards (no time shift)
  function biquad(type, fc, fs){
    const w = Math.tan(Math.PI * fc / fs), q = Math.SQRT1_2, n = 1 / (1 + w / q + w * w);
    if (type === "low"){ const b0 = w * w * n; return { b: [b0, 2 * b0, b0], a: [2 * (w * w - 1) * n, (1 - w / q + w * w) * n] }; }
    const b0 = n; return { b: [b0, -2 * b0, b0], a: [2 * (w * w - 1) * n, (1 - w / q + w * w) * n] };
  }
  function runFilter(x, f){
    const y = new Float64Array(x.length); let x1 = x[0], x2 = x[0], y1 = 0, y2 = 0;
    // start from a steady state at x[0]
    const dc = (f.b[0] + f.b[1] + f.b[2]) / (1 + f.a[0] + f.a[1]); y1 = y2 = x[0] * dc;
    for (let i = 0; i < x.length; i++){ const v = f.b[0] * x[i] + f.b[1] * x1 + f.b[2] * x2 - f.a[0] * y1 - f.a[1] * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
    return y;
  }
  function filtfilt(x, f){ const a = runFilter(x, f); a.reverse(); const b = runFilter(a, f); b.reverse(); return b; }
  const median = (a) => { const s = [...a].sort((p, q) => p - q), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; };
  const mean = (a) => a.reduce((p, q) => p + q, 0) / (a.length || 1);
  const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / Math.max(1, a.length - 1)); };

  // Orientation (Madgwick IMU filter) -> vertical acceleration in m/s² and yaw rate in deg/s
  function earthFrame(gx, gy, gz, ax, ay, az, fs){
    const N = ax.length, dt = 1 / fs, beta = 0.08;
    // gyro bias from the stillest second
    let bx = 0, by = 0, bz = 0, bestVar = Infinity;
    for (let s = 0; s + fs <= N; s += Math.round(fs / 2)){
      let m = 0, v = 0; for (let i = s; i < s + fs; i++){ const g = Math.hypot(gx[i], gy[i], gz[i]); m += g; v += g * g; }
      m /= fs; v = v / fs - m * m;
      if (v < bestVar && m < 20){ bestVar = v; bx = by = bz = 0; for (let i = s; i < s + fs; i++){ bx += gx[i]; by += gy[i]; bz += gz[i]; } bx /= fs; by /= fs; bz /= fs; }
    }
    // start level with gravity (average of the first half second)
    let mx = 0, my = 0, mz = 0; const k0 = Math.min(N, fs / 2);
    for (let i = 0; i < k0; i++){ mx += ax[i]; my += ay[i]; mz += az[i]; }
    let nrm = Math.hypot(mx, my, mz) || 1; mx /= nrm; my /= nrm; mz /= nrm;
    // quaternion that rotates the measured gravity onto +z
    let q0 = 1, q1 = 0, q2 = 0, q3 = 0;
    { const c = mz, vx = my, vy = -mx; const s = Math.sqrt(Math.max(0, (1 + c) * 2)); if (s > 1e-6){ q0 = s / 2; q1 = vx / s; q2 = vy / s; q3 = 0; } else { q0 = 0; q1 = 1; } }
    const vert = new Float64Array(N), yaw = new Float64Array(N), D = Math.PI / 180;
    for (let pass = 0; pass < 2; pass++){          // first pass settles the filter, second pass records
      for (let i = 0; i < N; i++){
        let wx = (gx[i] - bx) * D, wy = (gy[i] - by) * D, wz = (gz[i] - bz) * D;
        let x = ax[i], y = ay[i], z = az[i];
        let qd0 = 0.5 * (-q1 * wx - q2 * wy - q3 * wz), qd1 = 0.5 * (q0 * wx + q2 * wz - q3 * wy),
            qd2 = 0.5 * (q0 * wy - q1 * wz + q3 * wx), qd3 = 0.5 * (q0 * wz + q1 * wy - q2 * wx);
        const an = Math.hypot(x, y, z);
        if (an > 0.3 && an < 3){                     // only trust gravity when not in a big jolt
          x /= an; y /= an; z /= an;
          const _2q0 = 2 * q0, _2q1 = 2 * q1, _2q2 = 2 * q2, _2q3 = 2 * q3, _4q0 = 4 * q0, _4q1 = 4 * q1, _4q2 = 4 * q2,
                _8q1 = 8 * q1, _8q2 = 8 * q2, q0q0 = q0 * q0, q1q1 = q1 * q1, q2q2 = q2 * q2, q3q3 = q3 * q3;
          let s0 = _4q0 * q2q2 + _2q2 * x + _4q0 * q1q1 - _2q1 * y;
          let s1 = _4q1 * q3q3 - _2q3 * x + 4 * q0q0 * q1 - _2q0 * y - _4q1 + _8q1 * q1q1 + _8q1 * q2q2 + _4q1 * z;
          let s2 = 4 * q0q0 * q2 + _2q0 * x + _4q2 * q3q3 - _2q3 * y - _4q2 + _8q2 * q1q1 + _8q2 * q2q2 + _4q2 * z;
          let s3 = 4 * q1q1 * q3 - _2q1 * x + 4 * q2q2 * q3 - _2q2 * y;
          const sn = Math.hypot(s0, s1, s2, s3) || 1; s0 /= sn; s1 /= sn; s2 /= sn; s3 /= sn;
          qd0 -= beta * s0; qd1 -= beta * s1; qd2 -= beta * s2; qd3 -= beta * s3;
        }
        q0 += qd0 * dt; q1 += qd1 * dt; q2 += qd2 * dt; q3 += qd3 * dt;
        const qn = Math.hypot(q0, q1, q2, q3); q0 /= qn; q1 /= qn; q2 /= qn; q3 /= qn;
        if (pass === 1){
          // third row of the rotation matrix gives the vertical (earth z) part of a body vector
          const r20 = 2 * (q1 * q3 - q0 * q2), r21 = 2 * (q2 * q3 + q0 * q1), r22 = q0 * q0 - q1 * q1 - q2 * q2 + q3 * q3;
          vert[i] = (r20 * ax[i] + r21 * ay[i] + r22 * az[i] - 1) * G;
          yaw[i] = r20 * (gx[i] - bx) + r21 * (gy[i] - by) + r22 * (gz[i] - bz);
        }
      }
    }
    return { vert, yaw };
  }

  function toChannels(rec){
    const n = rec.n, ch = { gx: new Float64Array(n), gy: new Float64Array(n), gz: new Float64Array(n), ax: new Float64Array(n), ay: new Float64Array(n), az: new Float64Array(n) };
    for (let i = 0; i < n; i++){
      ch.gx[i] = rec.raw[i * 6] / GYR_LSB; ch.gy[i] = rec.raw[i * 6 + 1] / GYR_LSB; ch.gz[i] = rec.raw[i * 6 + 2] / GYR_LSB;
      ch.ax[i] = rec.raw[i * 6 + 3] / ACC_LSB; ch.ay[i] = rec.raw[i * 6 + 4] / ACC_LSB; ch.az[i] = rec.raw[i * 6 + 5] / ACC_LSB;
    }
    // each sample's time on the phone's clock (ms)
    const rate = n > 1 && rec.t1us > rec.t0us ? (n - 1) / ((rec.t1us - rec.t0us) / 1e6) : FS;
    const t0 = rec.t0us / 1000 - (rec.offsetMs || 0);
    return { ...ch, n, t0, dtMs: 1000 / rate };
  }
  // put a channel onto the shared 100 Hz time grid
  function resample(c, key, tStart, N){
    const out = new Float64Array(N), src = c[key];
    for (let i = 0; i < N; i++){
      const t = tStart + i * 10, x = (t - c.t0) / c.dtMs, j = Math.floor(x);
      if (j < 0) out[i] = src[0]; else if (j >= c.n - 1) out[i] = src[c.n - 1];
      else { const f = x - j; out[i] = src[j] * (1 - f) + src[j + 1] * f; }
    }
    return out;
  }

  /* ======================= right fore steps ======================= */
  function footStrikes(gx, gy, gz){
    const N = gx.length, w = new Float64Array(N);
    for (let i = 0; i < N; i++) w[i] = Math.hypot(gx[i], gy[i], gz[i]);
    const ws = filtfilt(w, biquad("low", 12, FS));
    const sorted = [...ws].sort((a, b) => a - b), p95 = sorted[Math.floor(N * 0.95)] || 0;
    const thr = Math.max(150, 0.45 * p95);
    // swing peaks: local maxima above thr, at least 0.35 s apart
    const peaks = [];
    for (let i = 1; i < N - 1; i++){
      if (ws[i] > thr && ws[i] >= ws[i - 1] && ws[i] > ws[i + 1]){
        if (peaks.length && i - peaks[peaks.length - 1] < 35){ if (ws[i] > ws[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i; }
        else peaks.push(i);
      }
    }
    // foot strike = where the swing ends (rotation drops below 20% of that swing's peak)
    const strikes = [];
    for (let k = 0; k < peaks.length; k++){
      const p = peaks[k], lim = Math.min(N - 1, p + 40), low = 0.2 * ws[p];
      for (let i = p; i < lim; i++) if (ws[i] < low){ strikes.push(i); break; }
    }
    return strikes;
  }

  /* ======================= per-stride vertical movement ======================= */
  function strideDisplacement(acc, i0, i1){
    // acc: vertical acceleration (m/s², already band-passed). Double-integrate over one stride,
    // assuming the movement repeats (start and end at the same height and speed).
    const n = i1 - i0, dt = 1 / FS;
    const a = new Float64Array(n); let am = 0;
    for (let i = 0; i < n; i++){ a[i] = acc[i0 + i]; am += a[i]; } am /= n;
    const v = new Float64Array(n); let s = 0;
    for (let i = 0; i < n; i++){ s += (a[i] - am) * dt; v[i] = s; }
    let vm = 0; for (let i = 0; i < n; i++){ v[i] -= v[n - 1] * (i / (n - 1)); vm += v[i]; } vm /= n;
    const p = new Float64Array(n); s = 0;
    for (let i = 0; i < n; i++){ s += (v[i] - vm) * dt; p[i] = s; }
    let pm = 0; for (let i = 0; i < n; i++){ p[i] -= p[n - 1] * (i / (n - 1)); pm += p[i]; } pm /= n;
    for (let i = 0; i < n; i++) p[i] = (p[i] - pm) * 1000;   // mm
    return p;
  }
  // differences between the two halves of a stride. half 1 starts at right fore foot strike.
  // p: one stride starting at right fore strike (for the lows).
  // q: one stride starting a quarter-stride later (so both highs sit well inside it).
  function halves(p, q){
    const n = p.length, h = n >> 1, nq = q.length, hq = nq >> 1;
    let m1 = 0, m2 = h, M1 = 0, M2 = hq;
    for (let i = 0; i < h; i++) if (p[i] < p[m1]) m1 = i;
    for (let i = h; i < n; i++) if (p[i] < p[m2]) m2 = i;
    for (let i = 0; i < hq; i++) if (q[i] > q[M1]) M1 = i;
    for (let i = hq; i < nq; i++) if (q[i] > q[M2]) M2 = i;
    let lo = Infinity, hi = -Infinity; for (let i = 0; i < n; i++){ if (p[i] < lo) lo = p[i]; if (p[i] > hi) hi = p[i]; }
    return { diffMin: p[m1] - p[m2], diffMax: q[M1] - q[M2], range: hi - lo };
  }

  /* ======================= the analysis ======================= */
  const HEAD_T = 6, HEAD_A = 8.5, PELV_T = 3;   // mm thresholds used by the Lameness Locator

  function analyse(recs, opts = {}){
    const gait = opts.gait === "trotter" ? "trotter" : "pacer";
    const need = ["head", "pelvis", "rfore"].filter(k => !recs[k]);
    if (need.length) throw new Error("Missing: " + need.map(k => ROLE_LABEL[k]).join(", "));
    const C = { head: toChannels(recs.head), pelvis: toChannels(recs.pelvis), rfore: toChannels(recs.rfore) };
    const tStart = Math.max(...Object.values(C).map(c => c.t0)), tEnd = Math.min(...Object.values(C).map(c => c.t0 + (c.n - 1) * c.dtMs));
    const N = Math.floor((tEnd - tStart) / 10);
    if (N < FS * 10) throw new Error("The three recordings overlap by less than 10 seconds. Start all three, then trot.");
    const R = {};
    for (const k of Object.keys(C)) R[k] = Object.fromEntries(["gx", "gy", "gz", "ax", "ay", "az"].map(ch => [ch, resample(C[k], ch, tStart, N)]));

    const hp = biquad("high", 0.4, FS), lp = biquad("low", 14, FS);
    const vertOf = (r) => { const e = earthFrame(r.gx, r.gy, r.gz, r.ax, r.ay, r.az, FS); return { v: filtfilt(filtfilt(e.vert, hp), lp), yaw: e.yaw }; };
    const H = vertOf(R.head), P = vertOf(R.pelvis);
    const strikes = footStrikes(R.rfore.gx, R.rfore.gy, R.rfore.gz);

    // strides between right fore strikes; keep steady, straight trotting/pacing
    let cand = [];
    for (let k = 0; k + 2 < strikes.length; k++){
      const i0 = strikes[k], i1 = strikes[k + 1], i2 = strikes[k + 2], T = (i1 - i0) / FS;
      if (Math.abs((i2 - i1) - (i1 - i0)) > 0.2 * (i1 - i0)) continue;
      if (T < 0.45 || T > 1.2) continue;
      let yawM = 0; for (let i = i0; i < i1; i++) yawM += P.yaw[i]; yawM /= (i1 - i0);
      cand.push({ i0, i1, i2, T, yaw: yawM });
    }
    const Tmed = median(cand.map(s => s.T));
    let strides = cand.filter(s => Math.abs(s.T - Tmed) / Tmed < 0.15 && Math.abs(s.yaw) < 20);
    const turning = cand.filter(s => Math.abs(s.yaw) >= 20).length;

    const rows = strides.map(s => {
      const q0 = s.i0 + Math.round((s.i1 - s.i0) / 4), q1 = s.i1 + Math.round((s.i2 - s.i1) / 4);
      const ph = strideDisplacement(H.v, s.i0, s.i1), pp = strideDisplacement(P.v, s.i0, s.i1);
      const qh = strideDisplacement(H.v, q0, q1), qp = strideDisplacement(P.v, q0, q1);
      return { ...s, head: halves(ph, qh), pelv: halves(pp, qp), ph, pp };
    });
    // drop odd strides (stumble, head toss): pelvis or head range far from the usual
    const hr = median(rows.map(r => r.head.range)), pr = median(rows.map(r => r.pelv.range));
    const good = rows.filter(r => r.head.range < hr * 2 && r.head.range > hr * 0.4 && r.pelv.range < pr * 2 && r.pelv.range > pr * 0.4);

    const sum = (key, part) => { const a = good.map(r => r[key][part]); return { mean: mean(a), sd: sd(a), median: median(a) }; };
    const head = { diffMin: sum("head", "diffMin"), diffMax: sum("head", "diffMax"), range: median(good.map(r => r.head.range)) };
    const pelv = { diffMin: sum("pelv", "diffMin"), diffMax: sum("pelv", "diffMax"), range: median(good.map(r => r.pelv.range)) };
    head.A = Math.hypot(head.diffMin.mean, head.diffMax.mean);
    pelv.A = Math.hypot(pelv.diffMin.mean, pelv.diffMax.mean);

    // average stride shapes for the picture (100 points per stride)
    const avg = (key) => { const out = new Array(100).fill(0); for (const r of good){ const p = r[key]; for (let j = 0; j < 100; j++) out[j] += p[Math.min(p.length - 1, Math.round(j / 99 * (p.length - 1)))] / good.length; } return out; };

    const res = interpret(head, pelv, gait, good.length);
    return { ...res, gait, head, pelvis: pelv, strides: good.length, totalStrides: cand.length, turning, strideTime: Tmed,
      curves: good.length ? { head: avg("ph"), pelvis: avg("pp") } : null,
      perStride: good.map(r => ({ t: +((r.i0 / FS)).toFixed(2), hMin: +r.head.diffMin.toFixed(1), hMax: +r.head.diffMax.toFixed(1), pMin: +r.pelv.diffMin.toFixed(1), pMax: +r.pelv.diffMax.toFixed(1) })) };
  }

  // turn the millimetre numbers into plain words
  function interpret(head, pelv, gait, n){
    const firstHind = gait === "trotter" ? "LH" : "RH", otherHind = firstHind === "LH" ? "RH" : "LH";
    const level = (amt, thr, consistent) => amt < thr ? "none" : !consistent ? "watch" : amt >= thr * 2 ? "likely" : "suspect";
    // fronts. diffMin > 0: head drops less while the right fore is on the ground (RF impact).
    // diffMax < 0: head rises less after the right fore pushes off (RF push-off).
    const hMin = head.diffMin, hMax = head.diffMax;
    const foreScore = hMin.mean - hMax.mean;                     // + = right fore, - = left fore
    const foreSide = foreScore >= 0 ? "RF" : "LF";
    const foreAmt = Math.max(Math.abs(hMin.mean), Math.abs(hMax.mean), head.A * HEAD_T / HEAD_A);
    const foreAgree = !(Math.abs(hMin.mean) > 3 && Math.abs(hMax.mean) > 3 && Math.sign(hMin.mean) === Math.sign(hMax.mean));
    const foreCons = Math.abs(hMin.mean) > hMin.sd * 0.5 || Math.abs(hMax.mean) > hMax.sd * 0.5;
    const foreLevel = level(foreAmt, HEAD_T, foreCons && foreAgree);
    // hinds. Half 1 of the stride is when the hind paired with the right fore is on the ground.
    const pMin = pelv.diffMin, pMax = pelv.diffMax;
    const hindScore = pMin.mean - pMax.mean;                    // + = firstHind, - = otherHind
    const hindSide = hindScore >= 0 ? firstHind : otherHind;
    const hindAmt = Math.max(Math.abs(pMin.mean), Math.abs(pMax.mean));
    const hindAgree = !(Math.abs(pMin.mean) > 1.5 && Math.abs(pMax.mean) > 1.5 && Math.sign(pMin.mean) === Math.sign(pMax.mean));
    const hindCons = Math.abs(pMin.mean) > pMin.sd * 0.5 || Math.abs(pMax.mean) > pMax.sd * 0.5;
    const hindLevel = level(hindAmt, PELV_T, hindCons && hindAgree);

    const fmt = (x) => { const v = Math.abs(x) < 0.05 ? 0 : x; return (v > 0 ? "+" : "") + v.toFixed(1) + " mm"; };
    const type = (mn, mx, sideSign) => {
      const imp = Math.abs(mn) >= 2 && Math.sign(mn) === sideSign, push = Math.abs(mx) >= 2 && Math.sign(mx) === -sideSign;
      return imp && push ? "on landing and push-off" : imp ? "mostly as the leg lands" : push ? "mostly as the leg pushes off" : "";
    };
    const limbs = ["LF", "RF", "LH", "RH"].map(l => {
      const isFore = l.endsWith("F");
      if (isFore){
        if (l !== foreSide || foreLevel === "none") return { limb: l, level: "none", reason: l === foreSide ? `Head ${fmt(hMin.mean)} / ${fmt(hMax.mean)}: within normal.` : "" };
        const t = type(hMin.mean, hMax.mean, l === "RF" ? 1 : -1);
        return { limb: l, level: foreLevel, reason: `Head moves less evenly for this leg${t ? " " + t : ""}: down difference ${fmt(hMin.mean)}, up difference ${fmt(hMax.mean)} (normal under ${HEAD_T} mm).${foreLevel === "watch" ? " Not consistent stride to stride." : ""}` };
      }
      if (l !== hindSide || hindLevel === "none") return { limb: l, level: "none", reason: l === hindSide ? `Pelvis ${fmt(pMin.mean)} / ${fmt(pMax.mean)}: within normal.` : "" };
      const t = type(pMin.mean, pMax.mean, l === firstHind ? 1 : -1);
      return { limb: l, level: hindLevel, reason: `Pelvis moves less evenly for this leg${t ? " " + t : ""}: down difference ${fmt(pMin.mean)}, up difference ${fmt(pMax.mean)} (normal under ${PELV_T} mm).${hindLevel === "watch" ? " Not consistent stride to stride." : ""}` };
    });

    const worst = limbs.reduce((a, l) => ({ none: 0, watch: 1, suspect: 2, likely: 3 })[l.level] > ({ none: 0, watch: 1, suspect: 2, likely: 3 })[a] ? l.level : a, "none");
    let verdict = worst === "none" ? "sound" : worst === "likely" ? "lame" : "possible";
    const notes = [];
    if (n < 10){ verdict = "unclear"; notes.push(`Only ${n} good strides were found. Aim for 25 or more: trot in a straight line for at least 30 m, two or three times.`); }
    else if (n < 20) notes.push(`${n} strides used. 25 or more gives a steadier answer.`);
    if (gait === "pacer") notes.push("The horse was pacing. The head and pelvis method was worked out on trotting horses, so treat front-leg results with more caution at the pace. A trot in hand gives the most reliable reading.");
    const fl = limbs.find(l => l.limb.endsWith("F") && l.level !== "none"), hl = limbs.find(l => l.limb.endsWith("H") && l.level !== "none");
    if (fl && hl && fl.limb[0] === hl.limb[0]) notes.push(`Both the ${fl.limb} and ${hl.limb} show up. A sore hind often makes the head nod as if the front on the same side is sore (and the other way round), so one of these may be compensation. Your vet can block to tell which.`);
    const summary = verdict === "sound" ? `Head and pelvis moved evenly over ${n} strides. No lameness picked up.`
      : verdict === "unclear" ? "Not enough steady strides to judge."
      : `Uneven movement found${fl ? ` in front (${fl.limb}, ${fl.level})` : ""}${fl && hl ? " and" : ""}${hl ? ` behind (${hl.limb}, ${hl.level})` : ""} over ${n} strides.`;
    return { verdict, limbs, notes, summary, grade: null, confidence: n >= 25 && worst !== "watch" ? "high" : n >= 15 ? "medium" : "low",
      numbers: { headDiffMin: +hMin.mean.toFixed(1), headDiffMax: +hMax.mean.toFixed(1), headSdMin: +hMin.sd.toFixed(1), headSdMax: +hMax.sd.toFixed(1), headA: +head.A.toFixed(1),
        pelvDiffMin: +pMin.mean.toFixed(1), pelvDiffMax: +pMax.mean.toFixed(1), pelvSdMin: +pMin.sd.toFixed(1), pelvSdMax: +pMax.sd.toFixed(1), headRange: +head.range.toFixed(0), pelvRange: +pelv.range.toFixed(0) } };
  }

  window.Sensors = { supported, connectOne, analyse, interpret, ROLE_LABEL, _test: { earthFrame, footStrikes, strideDisplacement, halves, filtfilt, biquad, interpret } };
})();
