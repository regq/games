/* long-walk "The Long Walk" — you walk, it only gets further.
 *
 * THE LOOP. Hold to sprint (2x distance/s), release to walk. Hazards telegraph a fixed
 * number of SECONDS ahead, so sprinting does not shorten the warning in time — it doubles
 * the metres it costs you to react and raises what a missed one costs. A hit while
 * sprinting ends the run; a hit while walking only takes the tokens in your hand. At each
 * checkpoint you may Bank — end the run and keep the tokens — or walk on and risk them.
 * That is the whole decision, made every 40 to 150 seconds.
 *
 * CONTENT IS levels.json, ENGINE IS THIS FILE (issue #5b). Distances, hazard rates, walk
 * speeds, telegraph seconds and every meta cost live there, with a `variants` map keyed by
 * flag, so an INCREMENT that only changes numbers ships as a flag and needs no engine
 * change and no new tag.
 *
 * RUNS ARE SEEDED. Every run draws a seed, records it as `ctx.seed`, and generates its
 * hazards from a mulberry32 PRNG — so a run is reproducible from its seed alone, and two
 * players on the same seed meet the same hazards. `ctx.run` counts runs within the session
 * on every level_* event, which is what the hub divides by to get runs/session.
 *
 * WALL CLOCK, NEVER FRAMES. Distance is a function of elapsed time (the same rule game-01
 * learned in a throttled background tab), and dt is clamped so a tab that was hidden for a
 * minute does not teleport the walker through the hazards it never saw.
 *
 * WHAT IT EMITS (the GDD's mapping):
 *   level_win   a checkpoint reached          ctx.level = the segment just finished
 *   level_fail  the run ENDS in that segment  — a hazard hit only; Banking is not a fail
 *   thumbs      the end-of-run prompt
 *   report      the end-of-run "something was wrong" path
 *   purchase    the Ko-fi door, after a personal best only, value null
 * Banking deliberately emits no event: it is how a good run ends, and counting it as a
 * fail would put the best runs in the fail cliff.
 */

// --- pure helpers, exported for the node tests -------------------------------------

function applyVariants(base, variants, flags) {
  let out = base;
  for (const flag of flags || []) {
    const v = variants && variants[flag] && variants[flag][String(base.n)];
    if (v) out = Object.assign({}, out, v);
  }
  return out;
}

function supportUrl(manifest) {
  const u = (manifest && manifest.support && manifest.support.kofi) || "";
  return /^https:\/\/ko-fi\.com\/[A-Za-z0-9_-]+\/?$/.test(u) ? u : "";
}

/** mulberry32: 32 bits of state, uniform in [0,1). Small, fast, and identical in every
 *  browser — which is the only property that matters when a seed has to reproduce a run. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The segment a distance falls in: its index, or levels.length-1 once past the last
 *  checkpoint — the walk does not stop, it just stops handing out checkpoints. */
function segmentAt(levels, metres) {
  for (let i = 0; i < levels.length; i++) if (metres < levels[i].ends_at_m) return i;
  return levels.length - 1;
}

/** Metres per second right now. Boots stack multiplicatively per step; sprint doubles. */
function speedOf(level, meta, sprinting, cfg) {
  const boots = 1 + (meta.boots || 0) * (cfg.boots_speed_step || 0);
  return level.walk_m_s * boots * (sprinting ? (cfg.sprint_multiplier || 2) : 1);
}

/** The hazard chance per 10 m after the pack upgrades, clamped into (0, 1). */
function hazardRate(level, meta, cfg) {
  const p = level.hazard_per_10m * Math.pow(1 - (cfg.pack_hazard_step || 0), meta.pack || 0);
  return Math.min(0.9, Math.max(0.0001, p));
}

/** Distance to the next hazard, in metres: a geometric draw in 10 m units. A rate of p per
 *  10 m means each 10 m is an independent trial, so the gap is geometric — drawn once per
 *  hazard rather than rolled every step, which keeps a run reproducible whatever the frame
 *  rate does. */
function nextHazardGap(rate, u) {
  const gap = Math.ceil(Math.log(1 - Math.min(0.999999, u)) / Math.log(1 - rate));
  return Math.max(1, gap) * 10;
}

/** How many metres ahead the telegraph lights: a FIXED number of seconds, so the warning
 *  is the same length in time at any speed and twice as long in metres at a sprint. */
function telegraphMetres(level, speed) {
  return speed * (level.telegraph_s || 0);
}

const BUILTIN_SKIN = {
  palette: { bg: "#14100c", ink: "#f1e6d3", dim: "#a8977f", far: "#2a2119", mid: "#3a2d23", near: "#57432f",
             walker: "#d9a441", hazard: "#c8472b", telegraph: "#d9a441", checkpoint: "#5f9c5f" },
  sprites: {}, sfx: {},
};

const META_KEY = "long-walk:meta";
const META0 = { tokens: 0, boots: 0, pack: 0, best: 0 };

function readMeta(store) {
  try {
    const raw = store && store.getItem(META_KEY);
    const m = raw ? JSON.parse(raw) : {};
    return { tokens: Math.max(0, m.tokens | 0), boots: Math.max(0, m.boots | 0), pack: Math.max(0, m.pack | 0), best: Math.max(0, +m.best || 0) };
  } catch (e) { return Object.assign({}, META0); }
}

function writeMeta(store, meta) {
  try { store && store.setItem(META_KEY, JSON.stringify(meta)); } catch (e) { /* storage blocked: the run still plays */ }
}

/** Can this upgrade be bought, and what would it cost? Pure, so the tests can pin the
 *  economy without a DOM. */
function upgrade(meta, cfg, which) {
  const cost = which === "boots" ? (cfg.boots_cost_tokens || 0) : (cfg.pack_cost_tokens || 0);
  const max = which === "boots" ? (cfg.boots_max_stacks || 0) : (cfg.pack_max_stacks || 0);
  const have = meta[which] || 0;
  return { cost, max, have, can: have < max && (meta.tokens || 0) >= cost };
}

function buy(meta, cfg, which) {
  const u = upgrade(meta, cfg, which);
  if (!u.can) return meta;
  return Object.assign({}, meta, { tokens: meta.tokens - u.cost, [which]: u.have + 1 });
}

if (typeof module === "object" && module.exports) {
  module.exports = { applyVariants, supportUrl, mulberry32, segmentAt, speedOf, hazardRate,
                     nextHazardGap, telegraphMetres, readMeta, writeMeta, upgrade, buy, BUILTIN_SKIN, META_KEY, META0 };
}

// --- the game ----------------------------------------------------------------------

if (typeof document !== "undefined") (async function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const manifest = await (await fetch("spoke.json")).json();
  const content = await (await fetch("levels.json")).json();
  const T = await Telemetry.init(manifest);

  const skin = await Skin.load("skin.json", BUILTIN_SKIN, manifest.version);
  Skin.applyPalette(skin.applied.palette);

  const cfg = content.meta || {};
  const variants = content.variants || {};
  const store = (() => { try { return window.localStorage; } catch (e) { return null; } })();
  const kofi = supportUrl(manifest);

  let meta = readMeta(store);
  let runNo = 0, seed = 0, rng = null;
  let dist = 0, seg = 0, hand = 0, sprinting = false, running = false, ended = false;
  let hazardAt = 0, raf = 0, lastT = 0, lastPress = 0, flashUntil = 0, bankable = false;
  // ONE clock. flashUntil is stamped from the frame timestamp, so it has to be compared
  // against the frame timestamp too -- reading performance.now() in draw() is the same
  // number in a browser and a different one under any harness that drives the loop, which
  // left the hit flash stuck on for the rest of the run.
  let nowT = 0;

  // --- audio: one oscillator per cue, no assets. A skin may replace these with sfx slots.
  let ac = null;
  function beep(freq, ms, gain) {
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = freq; o.type = "sine";
      g.gain.value = gain; o.connect(g); g.connect(ac.destination);
      o.start(); g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + ms / 1000);
      o.stop(ac.currentTime + ms / 1000);
    } catch (e) { /* no audio: the run is unaffected */ }
  }

  function level() { return applyVariants(content.levels[seg], variants, T.flags()); }
  function speed() { return speedOf(level(), meta, sprinting, cfg); }

  function scheduleHazard() { hazardAt = dist + nextHazardGap(hazardRate(level(), meta, cfg), rng()); }

  function startRun() {
    runNo += 1;
    seed = (Math.random() * 4294967296) >>> 0;
    rng = mulberry32(seed);
    dist = 0; seg = 0; hand = 0; sprinting = false; ended = false; bankable = false;
    scheduleHazard();
    running = true; lastT = performance.now();
    $("after").classList.add("hidden");
    $("tip").classList.add("hidden");
    $("bank").classList.add("hidden");
    $("hold").disabled = false;
    raf = requestAnimationFrame(tick);
    draw();
  }

  function ctx(extra) { return Object.assign({ level: seg + 1, run: runNo, seed: seed }, extra || {}); }

  function tick(now) {
    if (!running) return;
    const dt = Math.min(0.1, Math.max(0, (now - lastT) / 1000));   // clamped: a hidden tab must not teleport
    lastT = nowT = now;
    dist += speed() * dt;

    if (dist >= hazardAt) {
      if (sprinting) { endRun("hit"); return; }
      hand = 0;                                    // a walking hit costs the tokens in hand, never the run
      flashUntil = now + 220;
      beep(90, 160, 0.06);
      scheduleHazard();
    }
    const L = content.levels[seg];
    if (L && dist >= L.ends_at_m) {                // checkpoint
      T.event("level_win", runNo, ctx());
      hand += (cfg.token_per_checkpoint || 1);
      bankable = true;
      beep(880, 120, 0.05);
      if (seg < content.levels.length - 1) { seg += 1; scheduleHazard(); }
      else { hazardAt = Math.max(hazardAt, dist + 10); }           // past the last checkpoint the walk goes on
      $("bank").classList.remove("hidden");
    }
    draw();
    raf = requestAnimationFrame(tick);
  }

  function endRun(why) {
    if (ended) return;
    ended = true; running = false; sprinting = false;
    cancelAnimationFrame(raf);
    const best = dist > meta.best;
    if (why === "hit") {
      T.event("level_fail", runNo, ctx());
      hand = 0;
      beep(60, 300, 0.08);
    } else {                                        // banked: the run ends well, and is not a fail
      meta = Object.assign({}, meta, { tokens: meta.tokens + hand });
      hand = 0;
    }
    if (best) meta = Object.assign({}, meta, { best: Math.round(dist) });
    writeMeta(store, meta);
    $("hold").disabled = true;
    $("bank").classList.add("hidden");
    $("after").classList.remove("hidden");
    $("up").disabled = $("down").disabled = false;
    $("outcome").textContent = why === "hit"
      ? `A hazard, ${Math.round(dist)} m in${best ? " — and a personal best" : ""}.`
      : `Banked at ${Math.round(dist)} m${best ? " — a personal best" : ""}.`;
    if (kofi && best) $("tip").classList.remove("hidden");          // the door opens on a personal best only
    refresh();
    draw();     // the tokens in hand have just changed; without this the end screen still
                // shows the token a sprint hit took away, which is the game lying about a loss
  }

  // --- drawing: DOM + transforms, every colour a skin slot ---------------------------
  function draw() {
    const L = level(), sp = speed();
    const tele = Math.max(0, hazardAt - dist) <= telegraphMetres(L, sp);
    $("dist").textContent = Math.round(dist) + " m";
    $("seg").textContent = `segment ${seg + 1} of ${content.levels.length}`;
    $("hand").textContent = hand ? `${hand} token${hand === 1 ? "" : "s"} in hand` : "no tokens in hand";
    const road = $("road");
    road.classList.toggle("telegraph", tele && running);
    road.classList.toggle("flash", nowT < flashUntil);
    road.classList.toggle("sprint", sprinting);
    // parallax: three bands at different rates, all scaled by the CURRENT speed, so a
    // sprint reads as speed before any number does (A5)
    for (const [id, rate] of [["far", 0.15], ["mid", 0.4], ["near", 1.0]]) {
      $(id).style.transform = `translateX(${-((dist * rate * 6) % 200)}px)`;
    }
    $("walker").style.setProperty("--lean", sprinting ? "10deg" : "0deg");
  }

  function refresh() {
    $("best").textContent = meta.best ? `best ${meta.best} m` : "no run yet";
    $("tokens").textContent = `${meta.tokens} token${meta.tokens === 1 ? "" : "s"}`;
    for (const which of ["boots", "pack"]) {
      const u = upgrade(meta, cfg, which);
      const b = $(which);
      b.disabled = !u.can;
      b.textContent = `${which === "boots" ? "Boots" : "Pack"} ${u.have}/${u.max} · ${u.cost}`;
    }
    if (T.dev) { $("count").textContent = String(T.count()) + (T.unsent() ? " · unsent " + T.unsent() : ""); $("uid").textContent = T.userHash; }
  }

  // --- input: game-01's family. Hold to sprint; a short tap toggles it. ---------------
  const btn = $("hold");
  function down(e) {
    if (e) { e.preventDefault(); if (btn.setPointerCapture && e.pointerId !== undefined) { try { btn.setPointerCapture(e.pointerId); } catch (err) {} } }
    lastPress = performance.now();
    if (!running && ended) return;
    if (!running) { startRun(); sprinting = true; return; }
    sprinting = !sprinting ? true : sprinting;
  }
  function up(e) {
    if (e) e.preventDefault();
    if (performance.now() - lastPress > 150) sprinting = false;     // a hold ends; a tap leaves it on
  }
  btn.addEventListener("pointerdown", down);
  btn.addEventListener("pointerup", up);
  btn.addEventListener("pointercancel", () => { sprinting = false; });
  btn.addEventListener("keydown", e => { if (e.code === "Space" && !e.repeat) down(e); });
  btn.addEventListener("keyup", e => { if (e.code === "Space") up(e); });

  $("bank").addEventListener("click", () => { if (running && bankable) endRun("bank"); });
  $("again").addEventListener("click", () => startRun());
  $("up").addEventListener("click", () => { T.event("thumbs", 1, ctx()); $("up").disabled = $("down").disabled = true; refresh(); });
  $("down").addEventListener("click", () => { T.event("thumbs", -1, ctx()); $("up").disabled = $("down").disabled = true; refresh(); });
  $("report").addEventListener("click", () => {
    const reason = (prompt("What went wrong? (one line, no personal details)") || "").trim().slice(0, 140);
    if (reason) { T.event("report", null, ctx({ reason })); $("outcome").textContent = "Thanks — noted."; refresh(); }
  });
  if (kofi) {
    $("tip-link").href = kofi;
    $("tip-link").addEventListener("click", () => { T.event("purchase", null, ctx({ via: "kofi", where: "pb" })); T.flush(); refresh(); });
  }
  for (const which of ["boots", "pack"]) {
    $(which).addEventListener("click", () => { meta = buy(meta, cfg, which); writeMeta(store, meta); refresh(); });
  }

  if (T.dev) {
    $("dev").classList.add("on");
    $("export").addEventListener("click", () => {
      const text = T.exportJsonl();
      $("jsonl").value = text;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "application/x-ndjson" }));
      a.download = "spoke-" + manifest.id + "-" + new Date().toISOString().slice(0, 10) + ".jsonl";
      document.body.appendChild(a); a.click(); a.remove();
    });
    $("reset").addEventListener("click", () => {
      try { store && store.removeItem(META_KEY); } catch (e) {}    // telemetry only clears its own keys
      T.resetPlayer(); location.reload();
    });
  }

  $("status").textContent = "Hold the button to sprint. Let go to walk. A hazard while sprinting ends the run.";
  refresh();
  draw();
})();
