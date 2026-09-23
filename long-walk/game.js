/* long-walk "The Long Walk" — v0.1.0 SCAFFOLD. The walk is not built yet.
 *
 * What this file does today, and why it exists before the game does: it proves the three
 * contracts a spoke has to satisfy, so that none of them is discovered to be wrong halfway
 * through building the actual loop.
 *
 *   1. content out of the engine — levels.json is read, never hard-coded (issue #5b)
 *   2. skin.json is read FROM DAY ONE through shared/skin.js, palette slots written as CSS
 *      custom properties; a refused skin falls back to the built-in and says so
 *   3. shared/telemetry.js initialises against this manifest
 *
 * `telemetry.endpoint` is deliberately "" at v0.1.0: a placeholder page that nobody can play
 * would otherwise post session_start / session_end to the Worker and put sessions with no
 * wins and no fails into the hub's PAIN reading. The endpoint flips to the Worker at v0.2.0,
 * when there is a run to measure. Route B (localStorage + Export) still works meanwhile.
 *
 * applyVariants is the same merge game-01 uses, and is exported for the shared level tests.
 */
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

const BUILTIN_SKIN = {
  palette: { bg: "#14100c", ink: "#f1e6d3", dim: "#a8977f", far: "#2a2119", mid: "#3a2d23", near: "#57432f",
             walker: "#d9a441", hazard: "#c8472b", telegraph: "#d9a441", checkpoint: "#5f9c5f" },
  sprites: {}, sfx: {},
};

if (typeof module === "object" && module.exports) module.exports = { applyVariants, supportUrl, BUILTIN_SKIN };

if (typeof document !== "undefined") (async function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const manifest = await (await fetch("spoke.json")).json();
  const content = await (await fetch("levels.json")).json();
  const T = await Telemetry.init(manifest);

  const skin = await Skin.load("skin.json", BUILTIN_SKIN, manifest.version);
  Skin.applyPalette(skin.applied.palette);
  $("skin").textContent = skin.errors.length
    ? `skin refused (${skin.errors.length} problem${skin.errors.length === 1 ? "" : "s"}), using the built-in — see the console`
    : `skin: ${skin.used}`;

  const levels = content.levels.map(L => applyVariants(L, content.variants || {}, T.flags()));
  $("rows").innerHTML = levels.map(L =>
    `<tr><td>${L.n}</td><td>${L.ends_at_m} m</td><td>${L.hazard_per_10m}</td><td>${L.walk_m_s} m/s</td><td>${L.telegraph_s} s</td></tr>`).join("");

  const last = levels[levels.length - 1].ends_at_m;                       // checkpoint flags, to scale
  for (let i = 0; i < levels.length; i++) {
    const f = $("f" + (i + 1));
    if (f) f.style.left = `calc(${(levels[i].ends_at_m / last) * 100}% - 3px)`;
  }

  const flags = T.flags();
  $("status").textContent = `${levels.length} segments read from levels.json`
    + (flags.length ? ` · flags on: ${flags.join(", ")}` : " · no flags")
    + ` · telemetry ${T.endpoint() ? "→ the Worker" : "local only (Route B)"}`;
})();
