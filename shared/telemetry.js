/* telemetry.js — the one telemetry client every spoke game loads. No dependencies.
 *
 * Contract (ADR-001): nine primitive events only —
 *   session_start, session_end, level_fail, level_win, thumbs, report, purchase, ugc_publish, ugc_play.
 * Anything else throws in dev and is dropped in production. rage_quit is NOT an event:
 * the hub derives it (session_end within 10 s of a level_fail with no win after).
 *
 * user_hash = first 16 hex of sha256(a random UUID kept in localStorage 'spoke:uid').
 * No IP, no user agent, nothing else identifying. A cleared browser is a new user.
 *
 * Route B (telemetry.endpoint === ""): events queue in localStorage 'spoke:events'
 * (cap 2000, oldest dropped) and the dev overlay exports them as JSONL.
 * Route A (endpoint set): batches of `batch` (or every `flush_s`, or on hide) go
 * out with navigator.sendBeacon as text/plain (no preflight).
 *
 * Flags: bucket(user_hash) = parseInt(first 4 hex, 16) / 65535; a flag is on when
 * bucket < rollout. Deterministic per user, recomputable by the hub.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Telemetry = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const EVENTS = ["session_start", "session_end", "level_fail", "level_win", "thumbs", "report", "purchase", "ugc_publish", "ugc_play"];
  const DERIVED = ["rage_quit"];
  const CAP = 2000;
  const KEY_UID = "spoke:uid", KEY_EVENTS = "spoke:events", KEY_DEV = "spoke:dev";

  function bucket(userHash) { return parseInt(String(userHash).slice(0, 4), 16) / 65535; }
  function flagOnFor(userHash, rollout) { return bucket(userHash) < Number(rollout || 0); }

  function uuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16); (crypto || {}).getRandomValues ? crypto.getRandomValues(b) : b.forEach((_, i) => { b[i] = Math.random() * 256 | 0; });
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }

  async function sha256hex16(text) {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, "0")).join("").slice(0, 16);
  }

  function store() { try { return window.localStorage; } catch (e) { return null; } }
  function readEvents() { try { return JSON.parse(store().getItem(KEY_EVENTS) || "[]"); } catch (e) { return []; } }
  function writeEvents(list) { try { store().setItem(KEY_EVENTS, JSON.stringify(list.slice(-CAP))); } catch (e) { /* storage blocked: events are lost, never the game */ } }

  const T = {
    EVENTS, DERIVED, bucket, flagOnFor,
    manifest: null, userHash: null, session: null, dev: false,
    _queue: [], _timer: null, _started: 0,

    async init(manifest) {
      this.manifest = manifest;
      this.dev = /[?&]dev=1/.test(location.search) || (store() && store().getItem(KEY_DEV) === "1");
      let uid = store() && store().getItem(KEY_UID);
      if (!uid) { uid = uuid(); try { store().setItem(KEY_UID, uid); } catch (e) { /* no storage: per-load user */ } }
      this.userHash = await sha256hex16(uid);
      this.session = uuid().slice(0, 8);
      this._started = Date.now();
      const flush = () => this.flush();
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { this.end(); flush(); } });
      window.addEventListener("pagehide", () => { this.end(); flush(); });
      if (manifest.telemetry && manifest.telemetry.endpoint) this._timer = setInterval(flush, (manifest.telemetry.flush_s || 15) * 1000);
      this.event("session_start");
      return this;
    },

    flags() {
      const out = [];
      const f = (this.manifest && this.manifest.flags) || {};
      for (const name of Object.keys(f)) if (flagOnFor(this.userHash, f[name].rollout)) out.push(name);
      return out;
    },
    flagOn(name) { return this.flags().indexOf(name) >= 0; },

    event(name, value, ctx) {
      if (EVENTS.indexOf(name) < 0) {
        const why = DERIVED.indexOf(name) >= 0 ? name + " is derived by the hub, never emitted" : "unknown event " + name;
        if (this.dev) throw new Error(why);
        return null;
      }
      const c = Object.assign({ s: this.session, f: this.flags() }, ctx || {});
      const row = { spoke: this.manifest.id, version: this.manifest.version, user_hash: this.userHash, event: name,
                    value: value == null ? null : Number(value), ctx: c, ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
      if (this.manifest.telemetry && this.manifest.telemetry.endpoint) {
        this._queue.push(row);
        if (this._queue.length >= (this.manifest.telemetry.batch || 20)) this.flush();
      } else {
        const list = readEvents(); list.push(row); writeEvents(list);
      }
      return row;
    },

    _ended: false,
    end() {
      if (this._ended) return;
      this._ended = true;
      this.event("session_end", Math.round((Date.now() - this._started) / 1000));
    },

    flush() {
      const ep = this.manifest && this.manifest.telemetry && this.manifest.telemetry.endpoint;
      if (!ep || !this._queue.length) return;
      const body = JSON.stringify(this._queue.splice(0, 50));
      if (!(navigator.sendBeacon && navigator.sendBeacon(ep, new Blob([body], { type: "text/plain" })))) {
        fetch(ep, { method: "POST", body, headers: { "Content-Type": "text/plain" }, keepalive: true }).catch(() => {});
      }
    },

    count() { return this.manifest && this.manifest.telemetry && this.manifest.telemetry.endpoint ? this._queue.length : readEvents().length; },
    exportJsonl() { return readEvents().map(r => JSON.stringify(r)).join("\n") + (readEvents().length ? "\n" : ""); },
    clearEvents() { writeEvents([]); },
    resetPlayer() { try { store().removeItem(KEY_UID); store().removeItem(KEY_EVENTS); } catch (e) { /* ignore */ } },
  };
  return T;
}));
