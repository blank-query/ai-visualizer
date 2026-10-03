/*
 * ai-visualizer: give your AI agent a face.
 * Copyright (C) 2026 Jared Rhodenizer
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* ============================================================
   ai-visualizer core — the shared plumbing every face rides on.

   A face is one self-contained page in faces/<name>/index.html.
   It includes this script, calls AV.init(opts), then reads these
   fields every animation frame after calling AV.tick(dtMs):

     AV.state      "idle" | "listening" | "thinking" | "speaking"
     AV.level      0..1 raw voice loudness (speaking only)
     AV.env        0..1 smoothed speech envelope (attack/release eased,
                   adaptively normalized — use this for motion)
     AV.samples    Float32Array(64), 0..1 normalized waveform ring
     AV.alert      bool, optional attention signal
     AV.micLevel   0..1 your microphone (only if init({mic:true}))
     AV.name       display name from config ("JARVIS" by default)
     AV.label      the dotted chip label ("J.A.R.V.I.S.")
     AV.badge      optional handle from config ("" by default)

   Modes:
     live   served by server.py — rides the real signal bus
     demo   ?demo=1, or the page opened as a plain file — a scripted
            voice-turn loop (idle, listening, thinking, speaking) with
            synthesized audio, so every face performs with no voice
            line installed
     shot   ?shot=<state>&t=ms — pins one state and runs the frame
            loop deterministically, then sets document.title to
            "ready" (screenshot/verification harness)

   The thinking sound: assets/thinking.wav plays while the state is
   "thinking", exactly like a voice line would play it. If the bus
   says the voice line is already playing its own (.voice_loading_pid),
   this player stays quiet — you never hear it twice. The speaker
   button (bottom left) toggles it; browsers may require one click on
   the page before audio is allowed.
   ============================================================ */
"use strict";

const AV = (() => {
  const Q = new URLSearchParams(location.search);
  const SHOT = Q.get("shot");
  const SHOT_T = parseInt(Q.get("t") || "4000", 10);
  const DEMO = Q.get("demo") === "1" || location.protocol === "file:" || !!SHOT;

  // where core.js lives -> where assets/ lives (works over http and file://)
  const ROOT = new URL(".", document.currentScript.src);

  const A = {
    state: "idle", level: 0, env: 0, alert: false, micLevel: 0,
    samples: new Float32Array(64),
    name: "JARVIS", label: "J.A.R.V.I.S.", badge: "",
    demo: DEMO, shot: SHOT, faces: [],
    _sndOn: true, _mic: false, _readyCbs: [], _ready: false,
    backendWs: "", recording: false,
  };

  function dotted(name) {
    const up = String(name).toUpperCase();
    if (/^[A-Z0-9]{2,10}$/.test(up)) return up.split("").join(".") + ".";
    return up;
  }

  /* -------------------------------- config -------------------------------- */
  function applyConfig(cfg) {
    if (cfg.name) { A.name = String(cfg.name); A.label = dotted(A.name); }
    A.badge = String(cfg.badge || "");
    if (cfg.thinking_sound === false) A._sndWant = false;
    A.faces = cfg.faces || [];
    A.backendWs = String(cfg.backend_ws || "");
    if (A.backendWs && !DEMO) viInit();
    A._ready = true;
    A._readyCbs.forEach(cb => cb(A));
    A._readyCbs = [];
  }

  A.ready = cb => { A._ready ? cb(A) : A._readyCbs.push(cb); };

  /* ------------------------------ bus polling ------------------------------ */
  let raw = { state: "idle", level: 0, samples: null, alert: false,
              loading: false };
  if (!DEMO) {
    setInterval(async () => {
      try {
        const r = await fetch("/state", { cache: "no-store" });
        raw = await r.json();
      } catch (e) { /* server gone: hold last state */ }
    }, 120);
  }

  /* ------------------------------ demo driver ------------------------------ */
  // A scripted voice turn: the face performs everything with no voice line.
  const SCRIPT = [["idle", 6000], ["listening", 3500], ["thinking", 4200],
                  ["speaking", 8500]];
  let demoT = 0, demoClock = 0;
  const PIN = SHOT || Q.get("state");   // ?state=speaking pins the demo
  function demoUpdate(dt) {
    demoClock += dt;
    let st = PIN || "idle";
    if (!PIN) {
      demoT = (demoT + dt) % SCRIPT.reduce((a, s) => a + s[1], 0);
      let t = demoT;
      for (const [name, len] of SCRIPT) {
        if (t < len) { st = name; break; }
        t -= len;
      }
    }
    const tt = demoClock / 1000;
    const speaking = st === "speaking";
    const cadence = speaking
      ? Math.max(0, Math.sin(tt * 2.1) * 0.6 + Math.sin(tt * 0.9) * 0.5)
      : 0;
    const samples = new Array(64);
    for (let i = 0; i < 64; i++) {
      // drifting per-sample color so the synthetic voice has a moving
      // spectrum, not a steady tone — spectrum-driven faces dance
      const m = 0.3 + 0.7 * Math.abs(Math.sin(i * 0.23 + tt * 1.7))
        * Math.abs(Math.sin(tt * 2.9 + i * 0.05));
      samples[i] = speaking
        ? (Math.sin(i * 0.55 + tt * 9) * 0.6 + Math.sin(i * 1.7 - tt * 13)
           * 0.4) * 9000 * (0.15 + 0.85 * cadence) * m
        : 0;
    }
    raw = { state: st, level: speaking ? Math.min(1, cadence) : 0,
            samples, alert: false, loading: false };
    if (st === "listening")
      A.micLevel = 0.25 + 0.55 * Math.abs(Math.sin(tt * 2.7))
        * Math.abs(Math.sin(tt * 0.61));
  }

  /* ----------------------- envelope + samples easing ----------------------- */
  let peak = 0.05, sPeak = 200;
  function tick(dt) {
    if (DEMO) demoUpdate(dt);
    A.state = raw.state || "idle";
    // Not "listening": that's while YOU'RE recording, nothing of
    // Jarvis's own to interrupt yet, and the button popping in the
    // instant you press reads as noise, not a control.
    if (VI && VI.btn)
      VI.btn.style.display =
        (A.state === "thinking" || A.state === "speaking" || VI.btnPressed)
          ? "block" : "none";
    A.alert = !!raw.alert;
    // Empty unless the voice line was told to publish usage. A face that
    // wants to draw it reads AV.rateLimits; every other face ignores it.
    A.rateLimits = raw.rate_limits || {};
    A.level = raw.level || 0;

    // adaptive envelope: normalize against a decaying peak, then ease
    // (attack 50ms, release 350ms) — motion code rides AV.env
    const dts = dt / 1000;
    peak = Math.max(A.level, 0.05, peak - 0.5 * peak * dts);
    const target = Math.min(1, A.level / peak);
    const tau = target > A.env ? 50 : 350;
    A.env += (target - A.env) * Math.min(1, dt / tau);

    // waveform ring: rectify, normalize against its own decaying peak,
    // blend toward the newest frame so the ring flows instead of flickers
    const s = raw.samples;
    A.rawSamples = s && s.length ? s : null;   // signed, int16-scale floats
    if (s && s.length) {
      let mx = 0;
      for (let i = 0; i < s.length; i++) mx = Math.max(mx, Math.abs(s[i]));
      sPeak = Math.max(mx, 200, sPeak * 0.98);
      const n = s.length;
      for (let i = 0; i < 64; i++) {
        const v = Math.abs(s[Math.min(n - 1, Math.round(i * (n - 1) / 63))])
          / sPeak;
        A.samples[i] = A.samples[i] * 0.45 + Math.min(1, v) * 0.55;
      }
    } else {
      for (let i = 0; i < 64; i++) A.samples[i] *= Math.max(0, 1 - dts * 6);
    }
    if (A.state !== "speaking" && !DEMO)
      for (let i = 0; i < 64; i++) A.samples[i] *= Math.max(0, 1 - dts * 6);

    if (A._mic && A._micAnalyser) micRead();
    soundUpdate();
  }

  /* --------------------------------- mic ---------------------------------- */
  let micPeak = 0.02;
  function micRead() {
    const an = A._micAnalyser;
    const buf = A._micBuf;
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    micPeak = Math.max(rms, 0.02, micPeak * 0.999);
    A.micLevel = Math.min(1, rms / micPeak);
  }
  async function micStart() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      A._micAnalyser = an;
      A._micBuf = new Float32Array(an.fftSize);
      A._micStream = stream;
      const kick = () => ctx.state === "suspended" && ctx.resume();
      addEventListener("click", kick); addEventListener("keydown", kick);
    } catch (e) { /* no mic permission: level stays 0, faces degrade */ }
  }

  /* ------------------------------ voice input ------------------------------
     Tap/click the face to talk: a second push-to-talk, the pointer in
     place of a key. Only active when the config names a `backend_ws`
     (backtalk's browser bridge); off by default. One persistent socket,
     opened at startup so the first tap isn't paying handshake latency.
     Mic capture is lazy (first press) and reuses whatever stream a
     face's own mic:true visualization already opened (rain, neural)
     rather than requesting a second device.

     Tap anywhere on the face = talk, in every state — while idle it's
     the only turn, while Jarvis is working it QUEUES behind the
     current one (the backend's turn-stream reader lines it up; nothing
     here stops anything). The one Interrupt button (shown only while
     working) is the sole way to actually stop a reply: it sends
     interrupt_press instead of press, and a "stop" control frame back
     from the server clears whatever audio is already scheduled here. */
  let VI = null;   // { ws, capCtx, proc, mute, playCtx, nextPlayTime, sources, btn }
  function viConnect() {
    if (VI && VI.ws && VI.ws.readyState <= 1) return;
    try {
      const ws = new WebSocket(A.backendWs);
      ws.binaryType = "arraybuffer";
      ws.onmessage = viOnMessage;
      ws.onclose = () => setTimeout(viConnect, 1500);
      ws.onerror = () => {};
      VI = VI || {};
      VI.ws = ws;
    } catch (e) { /* bad backend_ws URL: voice input just stays off */ }
  }
  function viPlayCtx() {
    if (!VI.playCtx) { VI.playCtx = new AudioContext(); VI.nextPlayTime = 0; }
    return VI.playCtx;
  }
  function viOnMessage(ev) {
    if (typeof ev.data === "string") {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "stop") viStopPlayback();
      } catch (e) { /* ignore */ }
      return;
    }
    const buf = ev.data;
    if (buf.byteLength < 4) return;
    const rate = new DataView(buf).getUint32(0, true);
    const i16 = new Int16Array(buf.slice(4));
    const ctx = viPlayCtx();
    const abuf = ctx.createBuffer(1, i16.length, rate);
    const chan = abuf.getChannelData(0);
    for (let i = 0; i < i16.length; i++) chan[i] = i16[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = abuf;
    src.connect(ctx.destination);
    const now = ctx.currentTime;
    if (VI.nextPlayTime < now + 0.02) VI.nextPlayTime = now + 0.05;
    src.start(VI.nextPlayTime);
    VI.nextPlayTime += abuf.duration;
    VI.sources = VI.sources || [];
    VI.sources.push(src);
    src.onended = () => {
      const i = VI.sources.indexOf(src);
      if (i >= 0) VI.sources.splice(i, 1);
    };
  }
  function viStopPlayback() {
    // An interrupt: every chunk already sent but not yet played gets
    // discarded, mirroring mouth.shut_up() on the server side.
    (VI.sources || []).forEach(src => { try { src.stop(); } catch (e) {} });
    VI.sources = [];
    if (VI.playCtx) VI.nextPlayTime = VI.playCtx.currentTime;
  }
  async function viEnsureCapture() {
    if (VI.proc) return true;
    try {
      const stream = A._micStream
        || await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext({ sampleRate: 16000 });
      const src = ctx.createMediaStreamSource(stream);
      // deprecated but universal; AudioWorkletNode is the future upgrade
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (e) => {
        if (!A.recording || !VI.ws || VI.ws.readyState !== 1) return;
        const input = e.inputBuffer.getChannelData(0);
        const i16 = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          i16[i] = s < 0 ? s * 32768 : s * 32767;
        }
        const frame = new Uint8Array(4 + i16.byteLength);
        new DataView(frame.buffer).setUint32(0, ctx.sampleRate, true);
        frame.set(new Uint8Array(i16.buffer), 4);
        VI.ws.send(frame.buffer);
      };
      // ScriptProcessorNode only fires once connected; a muted gain
      // keeps your own mic from coming back out of your own speakers.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      VI.capCtx = ctx; VI.proc = proc; VI.mute = mute;
      return true;
    } catch (e) { return false; }
  }
  function viPress(isInterrupt) {
    if (!VI || !VI.ws || VI.ws.readyState !== 1) return;
    viEnsureCapture().then(ok => {
      if (!ok || !VI || !VI.ws || VI.ws.readyState !== 1) return;
      A.recording = true;
      // A queued tap (not the Interrupt button) pauses playback rather
      // than touching it: the AudioContext clock freezes, so whatever
      // was scheduled just picks back up exactly where it left off on
      // release, nothing lost, nothing restarted.
      if (!isInterrupt && VI.playCtx && VI.playCtx.state === "running") {
        VI.playCtx.suspend().catch(() => {});
        VI.pausedForQueue = true;
      }
      VI.ws.send(JSON.stringify(
        { type: isInterrupt ? "interrupt_press" : "press" }));
    });
  }
  function viRelease() {
    if (!VI || !A.recording) return;
    A.recording = false;
    if (VI.pausedForQueue) {
      VI.pausedForQueue = false;
      if (VI.playCtx) VI.playCtx.resume().catch(() => {});
    }
    if (VI.ws && VI.ws.readyState === 1)
      VI.ws.send(JSON.stringify({ type: "release" }));
  }
  function viInit() {
    viConnect();
    const stage = document.getElementById("stage");
    if (!stage) return;
    // The faces hide the cursor (cursor:none in their own CSS) for a
    // clean look on a passive display. Tapping the face is a real
    // control now, so a MOUSE needs the cursor visible to aim with —
    // but only while actually moving, so the clean look returns once
    // it's been idle a bit. A touchscreen has no cursor to manage;
    // (pointer: coarse) is the PRIMARY input, so a touchscreen stays
    // cursor:none exactly as the CSS already has it.
    if (!matchMedia("(pointer: coarse)").matches) {
      let cursorHideT = null;
      const cursorShow = () => {
        document.body.style.cursor = "default";
        clearTimeout(cursorHideT);
        cursorHideT = setTimeout(() => {
          document.body.style.cursor = "none";
        }, 1500);
      };
      addEventListener("mousemove", cursorShow);
      cursorShow();
    }
    stage.style.touchAction = "none";
    stage.addEventListener("pointerdown", (e) => { e.preventDefault(); viPress(false); });
    ["pointerup", "pointercancel", "pointerleave"].forEach(evt =>
      stage.addEventListener(evt, () => viRelease()));

    // ONE Interrupt button, shown only while Jarvis is working (tick()
    // toggles it via A.state). It's a separate element appended to
    // <body>, not a child of #stage, so its taps never reach the
    // stage's tap-anywhere-queues handler above — no event plumbing
    // needed to keep them apart, they're just not in the same subtree.
    const btn = document.createElement("div");
    btn.textContent = "INTERRUPT";
    btn.style.cssText =
      "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);" +
      "z-index:60;display:none;padding:18px 36px;border-radius:40px;" +
      "font:bold 15px 'SF Mono',Menlo,Consolas,monospace;" +
      "letter-spacing:.15em;color:#fff;background:rgba(200,30,30,.85);" +
      "border:2px solid rgba(255,255,255,.4);cursor:pointer;" +
      "touch-action:none;user-select:none;" +
      "box-shadow:0 2px 16px rgba(200,30,30,.5)";
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      VI.btnPressed = true;   // held through the state flip to "listening"
      viPress(true);
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach(evt =>
      btn.addEventListener(evt, (e) => {
        e.stopPropagation();
        VI.btnPressed = false;
        viRelease();
      }));
    document.body.appendChild(btn);
    VI = VI || {};   // viConnect() may not have run if backendWs was bad
    VI.btn = btn;
  }

  /* ----------------------------- thinking sound ---------------------------- */
  let audio = null, sndBtn = null, playing = false;
  A._sndWant = true;
  function soundInit() {
    if (SHOT) return;
    try { A._sndOn = localStorage.getItem("av_sound") !== "0"; }
    catch (e) { A._sndOn = true; }
    audio = new Audio(new URL("assets/thinking.wav", ROOT).href);
    audio.volume = 0.35;
    sndBtn = document.createElement("div");
    // hidden until the mouse moves, so it never collides with a face's
    // chrome and never shows on camera or in an OBS source
    sndBtn.style.cssText =
      "position:fixed;left:64px;bottom:14px;z-index:50;cursor:pointer;" +
      "font:12px 'SF Mono',Menlo,Consolas,monospace;letter-spacing:.2em;" +
      "color:#5a6a72;opacity:0;transition:opacity .4s;user-select:none;" +
      "pointer-events:none";
    sndBtn.title = "thinking sound on/off";
    let hideT = null;
    addEventListener("mousemove", () => {
      sndBtn.style.opacity = ".65";
      sndBtn.style.pointerEvents = "auto";
      clearTimeout(hideT);
      hideT = setTimeout(() => {
        sndBtn.style.opacity = "0";
        sndBtn.style.pointerEvents = "none";
      }, 3000);
    });
    sndBtn.onclick = () => {
      A._sndOn = !A._sndOn;
      try { localStorage.setItem("av_sound", A._sndOn ? "1" : "0"); }
      catch (e) {}
      if (!A._sndOn) stopSound();
      paintBtn();
    };
    paintBtn();
    document.body.appendChild(sndBtn);
  }
  function paintBtn() {
    if (sndBtn) sndBtn.textContent = A._sndOn ? "SND ON" : "SND OFF";
  }
  function stopSound() {
    if (audio && playing) { audio.pause(); audio.currentTime = 0; }
    playing = false;
  }
  function soundUpdate() {
    if (!audio || !A._sndWant) return;
    const want = A._sndOn && A.state === "thinking" && !raw.loading;
    if (want && !playing) {
      playing = true;
      audio.currentTime = 0;
      audio.play().catch(() => { playing = false; });
    } else if (!want && playing) {
      stopSound();
    }
  }

  /* ------------------------------ shot harness ----------------------------- */
  // Runs the face's frame() deterministically (a synchronous burst of t ms).
  // A headless browser resizes the window and finishes loading images AFTER
  // the first burst, so the burst re-runs on resize and on two late timers
  // (the last one flags "ready"), then keeps painting at frame pace so the
  // late capture always sees a fresh composite.
  A.shotRun = (frame) => {
    const burst = () => { for (let t = 0; t < SHOT_T; t += 16.6) frame(16.6); };
    burst();
    addEventListener("resize", burst);
    setTimeout(burst, 450);
    setTimeout(burst, 900);
    setTimeout(() => { burst(); document.title = "ready"; }, 3000);
    // fat 100ms steps: assets that finish loading after the last burst
    // still reach their steady state within a few paints
    const loop = () => { frame(100); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  };

  /* ---------------------------------- init --------------------------------- */
  A.init = (opts = {}) => {
    A._mic = !!opts.mic;
    if (A._mic && !DEMO) micStart();
    if (opts.sound !== false) soundInit(); else A._sndWant = false;
    if (DEMO) {
      applyConfig({ name: Q.get("name") || "JARVIS" });
    } else {
      fetch("/config", { cache: "no-store" })
        .then(r => r.json()).then(applyConfig)
        .catch(() => applyConfig({}));
    }
    return A;
  };

  A.tick = tick;

  /* ----------------------------- render helpers ---------------------------- */
  const U = {};
  U.dim = (c, f) => {
    f = Math.max(0, Math.min(1, f));
    return `rgb(${c[0] * f | 0},${c[1] * f | 0},${c[2] * f | 0})`;
  };
  U.rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  // How long until a usage window resets, in the shortest honest unit.
  U.relTime = (ep) => {
    const d = ep - Date.now() / 1000;
    if (!(d > 0)) return "";
    if (d < 3600) return Math.round(d / 60) + "m";
    if (d < 86400) return Math.round(d / 3600) + "h";
    return Math.round(d / 86400) + "d";
  };

  // The plan-usage windows, formatted ONCE for every face that draws them.
  // Lives here rather than in each face because four copies of one format
  // drift apart silently, and the first symptom is two faces disagreeing
  // about the same number.
  //
  // Returns [] when the voice line publishes no usage, so a face can call
  // it unconditionally and simply draw nothing when there is nothing to say.
  // A window that is KNOWN but has no percentage yet still returns a row:
  // hiding it entirely was the original bug, and a row that says "no number
  // yet" is information where a missing row is just confusing.
  U.usageRows = () => {
    const rl = A.rateLimits || {};
    const out = [];
    for (const [label, w] of [["5H", rl.five_hour], ["7D", rl.seven_day]]) {
      if (!w) continue;
      const known = w.utilization != null;
      const pct = known ? Math.round(w.utilization * 100) : null;
      const rel = w.resets_at ? U.relTime(w.resets_at) : "";
      out.push({
        label, pct, known,
        hot: known && pct >= 80,
        text: (known ? pct + "%" : "\u2014") + (rel ? "  " + rel : "")
      });
    }
    return out;
  };
  U.mix = (c1, c2, t) => [c1[0] + (c2[0] - c1[0]) * t | 0,
                          c1[1] + (c2[1] - c1[1]) * t | 0,
                          c1[2] + (c2[2] - c1[2]) * t | 0];
  // soft additive glow sprite (canvas), cached by the caller
  U.makeGlow = (rgb, size) => {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const grd = g.createRadialGradient(size / 2, size / 2, 0,
                                       size / 2, size / 2, size / 2);
    grd.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`);
    grd.addColorStop(.25, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.55)`);
    grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    return c;
  };
  // the one-field bloom rule: draw everything luminous into one field
  // canvas, bloom the WHOLE field (two downscale taps), composite
  // additively — bloom applied per-element reads as pencil lines
  U.bloomBlit = (dst, field, w, h) => {
    if (!field._b4 || field._b4.width !== w >> 2) {
      field._b4 = document.createElement("canvas");
      field._b4.width = Math.max(1, w >> 2);
      field._b4.height = Math.max(1, h >> 2);
      field._b8 = document.createElement("canvas");
      field._b8.width = Math.max(1, w >> 3);
      field._b8.height = Math.max(1, h >> 3);
    }
    const g4 = field._b4.getContext("2d"), g8 = field._b8.getContext("2d");
    g4.clearRect(0, 0, field._b4.width, field._b4.height);
    g4.drawImage(field, 0, 0, field._b4.width, field._b4.height);
    g8.clearRect(0, 0, field._b8.width, field._b8.height);
    g8.drawImage(field, 0, 0, field._b8.width, field._b8.height);
    const prev = dst.globalCompositeOperation;
    dst.globalCompositeOperation = "lighter";
    dst.drawImage(field, 0, 0);
    dst.drawImage(field._b4, 0, 0, w, h);
    dst.drawImage(field._b8, 0, 0, w, h);
    dst.globalCompositeOperation = prev;
  };
  // text that resolves out of glyph noise, left to right
  U.Descrambler = class {
    constructor(text, perChar = 50, hold = null) {
      this.text = text; this.per = perChar; this.hold = hold;
      this.t = 0; this.done = false;
      this.chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&";
    }
    render(dt) {
      this.t += dt;
      const n = this.t / this.per | 0;
      let out = "";
      for (let i = 0; i < this.text.length; i++) {
        const ch = this.text[i];
        out += (i < n || ch === " ") ? ch
          : this.chars[Math.random() * this.chars.length | 0];
      }
      if (this.hold != null && this.t > this.per * this.text.length + this.hold)
        this.done = true;
      return out;
    }
  };
  A.util = U;

  return A;
})();
