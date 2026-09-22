/* game-01 "Fill the Band": one button. Hold (or tap-start / tap-stop) to fill a
 * gauge; release inside the target band to win the level. Three levels, the
 * band shrinks and the fill speeds up (levels.json = content, this file = engine).
 * Telemetry: primitives only, through ../shared/telemetry.js (ADR-001).
 *
 * Flag-conditioned content (issue #5b): levels.json carries `variants`
 * { "<flag>": { "<level n>": { overrides } } }. A player whose active flags
 * (bucketed by user_hash in telemetry.js, sent on every event as ctx.f) include
 * the flag plays that level with the overrides merged over the base row. An
 * increment that only changes numbers ships as a variant plus a flag in
 * spoke.json -- no engine change, no new tag needed for the content itself.
 *
 * Support doors (2026-09-22): spoke.json `support.kofi`. Two surfaces -- a small
 * persistent link under the game and a prompt after the last win -- both hidden
 * while the value is empty, both emitting one `purchase` (value null) per click.
 */
function applyVariants(base, variants, flags) {
  let out = base;
  for (const flag of flags || []) {
    const v = variants && variants[flag] && variants[flag][String(base.n)];
    if (v) out = Object.assign({}, out, v);
  }
  return out;
}

/* The Ko-fi door, from spoke.json `support.kofi`. Empty or absent = "" and every
 * support surface stays hidden, so the slot ships long before the page does.
 * Ko-fi's free tier has no callback: the click is all this side ever learns, so
 * the `purchase` it emits carries value null -- a door opened, never a sale.
 * (DEFERRED 2026-09-22: a Stripe-backed shop is what would carry an amount.) */
function supportUrl(manifest) {
  const u = (manifest && manifest.support && manifest.support.kofi) || "";
  return /^https:\/\/ko-fi\.com\/[A-Za-z0-9_-]+\/?$/.test(u) ? u : "";
}
if (typeof module === "object" && module.exports) module.exports = { applyVariants, supportUrl };

if (typeof document !== "undefined") (async function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const manifest = await (await fetch("spoke.json")).json();
  const content = await (await fetch("levels.json")).json();
  const T = await Telemetry.init(manifest);

  const levels = content.levels;
  const variants = content.variants || {};
  const kofi = supportUrl(manifest);              // "" until the Ko-fi page is set in spoke.json
  let li = 0, attempt = 0, fill = 0, filling = false, raf = 0, startedAt = 0, lastPress = 0, done = false;
  // fill is a function of wall-clock hold time, never of frames: a throttled or
  // hidden tab must not change how much the gauge filled (found 09-21 in a background tab)
  const held = () => Math.min(1, (performance.now() - startedAt) / 1000 * level().fill_per_s);

  function level() { return applyVariants(levels[li], variants, T.flags()); }
  function band() {
    const L = level();
    return [L.band_center - L.band_width / 2, L.band_center + L.band_width / 2];
  }
  function draw() {
    const [lo, hi] = band();
    $("band").style.bottom = (lo * 100) + "%";
    $("band").style.height = ((hi - lo) * 100) + "%";
    $("fill").style.height = (fill * 100) + "%";
  }
  function say(text) { $("status").textContent = text; }

  function start() {
    if (done || filling) return;
    filling = true; fill = 0; startedAt = performance.now();
    $("fill").classList.remove("bad");
    raf = requestAnimationFrame(tick);
  }
  function tick() {
    if (!filling) return;
    fill = held(); draw();
    if (fill >= 1) stop(); else raf = requestAnimationFrame(tick);
  }
  function stop() {
    if (!filling) return;
    filling = false; cancelAnimationFrame(raf);
    fill = held(); draw();
    const [lo, hi] = band();
    attempt += 1;
    if (fill >= lo && fill <= hi) {
      T.event("level_win", attempt, { level: level().n });
      if (li === levels.length - 1) {
        done = true;
        say("You filled all three bands. Nice.");
        $("hold").disabled = true;
        $("after").classList.remove("hidden");
        if (kofi) $("tip").classList.remove("hidden");
      } else {
        li += 1; attempt = 0; fill = 0;
        say("Level " + level().n + " of " + levels.length + " — band shrinks");
        draw();
      }
    } else {
      $("fill").classList.add("bad");
      T.event("level_fail", attempt, { level: level().n });
      say((fill > hi ? "Too much" : "Not enough") + " — level " + level().n + ", try " + (attempt + 1));
    }
    refreshDev();
  }

  // hold: pointerdown starts, pointerup stops (if held > 150 ms); a short tap toggles start/stop
  const btn = $("hold");
  btn.addEventListener("pointerdown", e => { e.preventDefault(); btn.setPointerCapture(e.pointerId); lastPress = performance.now(); if (filling) stop(); else start(); });
  btn.addEventListener("pointerup", e => { e.preventDefault(); if (filling && performance.now() - lastPress > 150) stop(); });
  btn.addEventListener("pointercancel", () => { if (filling) stop(); });
  btn.addEventListener("keydown", e => { if (e.code === "Space" && !e.repeat) { e.preventDefault(); if (!filling) start(); } });
  btn.addEventListener("keyup", e => { if (e.code === "Space") { e.preventDefault(); if (filling) stop(); } });

  // support doors: the persistent small one under the game, the prompt after the
  // last win. Both open a new tab so the session lives on (its pagehide beacon is
  // the backup route); the event is flushed first so a single click lands without
  // waiting for the batch to fill.
  if (kofi) {
    for (const [wrap, link, where] of [["support", "support-link", "footer"], ["tip", "tip-link", "win"]]) {
      $(link).href = kofi;
      $(wrap).classList.remove("hidden");
      $(link).addEventListener("click", () => {
        T.event("purchase", null, { level: level().n, via: "kofi", where });
        T.flush();
        refreshDev();
      });
    }
    $("tip").classList.add("hidden");            // the win prompt waits for the last win
  }

  $("up").addEventListener("click", () => { T.event("thumbs", 1, { level: 3 }); $("up").disabled = $("down").disabled = true; refreshDev(); });
  $("down").addEventListener("click", () => { T.event("thumbs", -1, { level: 3 }); $("up").disabled = $("down").disabled = true; refreshDev(); });
  $("again").addEventListener("click", () => { li = 0; attempt = 0; fill = 0; done = false; $("hold").disabled = false; $("after").classList.add("hidden"); $("tip").classList.add("hidden"); $("up").disabled = $("down").disabled = false; say("Level 1 of 3"); draw(); });
  $("report").addEventListener("click", () => {
    const reason = (prompt("What went wrong? (one line, no personal details)") || "").trim().slice(0, 140);
    if (reason) { T.event("report", null, { level: level().n, reason }); say("Thanks — noted."); refreshDev(); }
  });

  // dev overlay: ?dev=1
  function refreshDev() {
    if (!T.dev) return;
    $("count").textContent = String(T.count()) + (T.unsent() ? " · unsent " + T.unsent() : "");
    $("uid").textContent = T.userHash;
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
    $("reset").addEventListener("click", () => { T.resetPlayer(); location.reload(); });
    refreshDev();
  }
  draw();
})();
