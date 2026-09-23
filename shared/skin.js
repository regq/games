/* skin.js — the skin loader every spoke game uses. No dependencies.
 *
 * A skin is DATA (ADR-001 amendment 10). `skin.json` carries:
 *   palette  slot -> "#rgb" | "#rrggbb"
 *   sprites  slot -> a PNG data URI, <= SPRITE_MAX bytes, at most SPRITE_SLOTS of them
 *   sfx      slot -> a WAV or OGG data URI, <= SFX_MAX bytes
 *   engine   ">=X.Y.Z" — the engine version this skin needs
 *
 * WHY THE GATE IS HERE AND NOT IN levels.json. `levels.json` carried an `engine: ">=0.1.2"`
 * that nothing read, and nothing could usefully: content and engine ship in the same commit
 * under one tag, so they cannot diverge. A skin is the file that can — it is the one a
 * stranger will eventually supply through `ugc_publish`, arriving long after the engine it
 * was made for. So the gate lives here and is enforced on every load.
 *
 * SVG IS EXCLUDED, deliberately and until a sanitizer exists: it is a document format that
 * can carry <script>, external references and CSS, and `img.src = <svg data uri>` is not the
 * safe boundary people assume when the file came from a stranger. PNG cannot execute.
 *
 * REFUSED, NEVER REPAIRED. One bad slot fails the whole skin and the game keeps its built-in
 * look: a half-applied skin is a bug report nobody can read, and silently dropping the slot
 * that was too big teaches an author that the limit is advisory. `validate()` returns every
 * reason it found, not just the first, so one round trip fixes the file.
 *
 * Pure and node-testable: no fetch, no DOM. `load()` is the only thing that touches the
 * network and it hands whatever it got straight to `validate()`.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Skin = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SPRITE_SLOTS = 12, SPRITE_MAX = 32 * 1024, SFX_MAX = 64 * 1024;
  const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  const SLOT = /^[a-z0-9_]{1,32}$/;
  const PNG = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/;
  const SOUND = /^data:audio\/(?:wav|x-wav|ogg);base64,([A-Za-z0-9+/=]+)$/;
  const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
  const RANGE = /^>=\s*(\d+\.\d+\.\d+)$/;

  /** bytes a base64 payload decodes to, without decoding it */
  function b64bytes(b64) {
    const pad = (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
    return Math.floor(b64.length * 3 / 4) - pad;
  }

  function cmp(a, b) {
    const x = SEMVER.exec(a), y = SEMVER.exec(b);
    if (!x || !y) return null;
    for (let i = 1; i <= 3; i++) { const d = (+x[i]) - (+y[i]); if (d) return d < 0 ? -1 : 1; }
    return 0;
  }

  /** Does `version` satisfy the skin's `engine` range? Unparseable either side = false. */
  function satisfies(version, range) {
    const m = RANGE.exec(String(range || "").trim());
    if (!m) return false;
    const c = cmp(String(version || "").trim(), m[1]);
    return c !== null && c >= 0;
  }

  function section(out, skin, name, test, max, label) {
    const obj = skin[name];
    if (obj === undefined) return {};
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) { out.push(name + " must be an object"); return {}; }
    const keys = Object.keys(obj);
    if (name === "sprites" && keys.length > SPRITE_SLOTS) out.push("sprites: " + keys.length + " slots, at most " + SPRITE_SLOTS);
    for (const k of keys) {
      const v = obj[k];
      if (!SLOT.test(k)) { out.push(name + "." + k + ": slot names are [a-z0-9_] up to 32 chars"); continue; }
      if (typeof v !== "string") { out.push(name + "." + k + ": must be a string"); continue; }
      const m = test.exec(v.trim());
      if (!m) { out.push(name + "." + k + ": " + label); continue; }
      if (max) {
        const n = b64bytes(m[1]);
        if (n > max) out.push(name + "." + k + ": " + n + " bytes, over the " + max + " limit");
      }
    }
    return obj;
  }

  /** {ok, errors[], skin} — every reason, not the first. `version` is the game's own. */
  function validate(skin, version) {
    const errors = [];
    if (skin === null || typeof skin !== "object" || Array.isArray(skin)) return { ok: false, errors: ["skin.json is not an object"], skin: null };
    if (skin.engine !== undefined && !satisfies(version, skin.engine)) {
      errors.push("engine " + JSON.stringify(skin.engine) + " is not satisfied by this game at " + version);
    }
    const pal = skin.palette;
    if (pal !== undefined) {
      if (pal === null || typeof pal !== "object" || Array.isArray(pal)) errors.push("palette must be an object");
      else for (const k of Object.keys(pal)) {
        if (!SLOT.test(k)) errors.push("palette." + k + ": slot names are [a-z0-9_] up to 32 chars");
        else if (typeof pal[k] !== "string" || !HEX.test(pal[k].trim())) errors.push("palette." + k + ": must be #rgb or #rrggbb");
      }
    }
    section(errors, skin, "sprites", PNG, SPRITE_MAX, "must be a PNG data URI (SVG is excluded until a sanitizer exists)");
    section(errors, skin, "sfx", SOUND, SFX_MAX, "must be a WAV or OGG data URI");
    for (const k of Object.keys(skin)) {
      if (["palette", "sprites", "sfx", "engine", "name"].indexOf(k) < 0) errors.push("unknown key " + JSON.stringify(k));
    }
    return { ok: errors.length === 0, errors: errors, skin: errors.length ? null : skin };
  }

  /** The built-in merged with a validated skin. A refused skin never reaches this. */
  function merge(builtin, skin) {
    const out = { palette: Object.assign({}, builtin.palette), sprites: Object.assign({}, builtin.sprites), sfx: Object.assign({}, builtin.sfx) };
    if (!skin) return out;
    for (const part of ["palette", "sprites", "sfx"]) Object.assign(out[part], skin[part] || {});
    return out;
  }

  /** Fetch `url`, validate, and fall back to the built-in with one line on the console.
   *  Never throws and never blocks the game: a skin is decoration, the loop is not. */
  async function load(url, builtin, version) {
    let raw = null;
    try {
      const r = await fetch(url, { cache: "no-cache" });
      if (r.ok) raw = await r.json();
    } catch (e) { raw = null; }
    if (raw === null) return { applied: merge(builtin, null), errors: [], used: "built-in" };
    const v = validate(raw, version);
    if (!v.ok) {
      console.warn("skin refused, using the built-in:\n  " + v.errors.join("\n  "));
      return { applied: merge(builtin, null), errors: v.errors, used: "built-in" };
    }
    return { applied: merge(builtin, v.skin), errors: [], used: raw.name || url };
  }

  /** Write a palette onto an element as CSS custom properties: --skin-<slot>. */
  function applyPalette(palette, el) {
    const target = el || (typeof document !== "undefined" ? document.documentElement : null);
    if (!target || !target.style) return;
    for (const k of Object.keys(palette || {})) target.style.setProperty("--skin-" + k, palette[k]);
  }

  return { SPRITE_SLOTS, SPRITE_MAX, SFX_MAX, b64bytes, cmp, satisfies, validate, merge, load, applyPalette };
}));
