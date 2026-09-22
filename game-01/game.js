/* game-01 "Fill the Band": one button. Hold (or tap-start / tap-stop) to fill a
 * gauge; release inside the target band to win the level. Three levels, the
 * band shrinks and the fill speeds up (levels.json = content, this file = engine).
 * Telemetry: primitives only, through ../shared/telemetry.js (ADR-001).
 */
(async function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const manifest = await (await fetch("spoke.json")).json();
  const content = await (await fetch("levels.json")).json();
  const T = await Telemetry.init(manifest);

  const levels = content.levels;
  let li = 0, attempt = 0, fill = 0, filling = false, raf = 0, startedAt = 0, lastPress = 0, done = false;
  // fill is a function of wall-clock hold time, never of frames: a throttled or
  // hidden tab must not change how much the gauge filled (found 09-21 in a background tab)
  const held = () => Math.min(1, (performance.now() - startedAt) / 1000 * level().fill_per_s);

  function level() { return levels[li]; }
  function band() {
    const L = level();
    let w = L.band_width;
    if (li === 2 && T.flagOn("wide_l3")) w *= 1.5;          // an example flag the hub can canary; off until spoke.json says otherwise
    return [L.band_center - w / 2, L.band_center + w / 2];
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

  $("up").addEventListener("click", () => { T.event("thumbs", 1, { level: 3 }); $("up").disabled = $("down").disabled = true; refreshDev(); });
  $("down").addEventListener("click", () => { T.event("thumbs", -1, { level: 3 }); $("up").disabled = $("down").disabled = true; refreshDev(); });
  $("again").addEventListener("click", () => { li = 0; attempt = 0; fill = 0; done = false; $("hold").disabled = false; $("after").classList.add("hidden"); $("up").disabled = $("down").disabled = false; say("Level 1 of 3"); draw(); });
  $("report").addEventListener("click", () => {
    const reason = (prompt("What went wrong? (one line, no personal details)") || "").trim().slice(0, 140);
    if (reason) { T.event("report", null, { level: level().n, reason }); say("Thanks — noted."); refreshDev(); }
  });

  // dev overlay: ?dev=1
  function refreshDev() {
    if (!T.dev) return;
    $("count").textContent = String(T.count());
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
