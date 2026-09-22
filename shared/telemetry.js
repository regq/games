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
 * One backing store, two routes (issue #3):
 *   'spoke:events'  every event, capped at CAP (oldest dropped) — what Export shows and
 *                   what the hub imports by hand (Route B). Always written.
 *   'spoke:outbox'  the unsent events, only when telemetry.endpoint is set (Route A).
 * flush() sends up to BATCH_MAX outbox rows with fetch(keepalive) and removes them ONLY
 * on a 2xx ack; any failure keeps them and backs off (BACKOFF_MIN → BACKOFF_MAX seconds,
 * Retry-After honoured, reset on success). A 400 or 413 for a whole batch means the
 * batch itself is bad: it is dropped (and thrown in dev) rather than retried forever.
 * On pagehide the outbox goes out once more with sendBeacon and is KEPT, because a
 * beacon cannot be confirmed; the next load may resend it, and duplicates collapse on
 * the Worker's fingerprint and again on the hub's. Nothing here ever deletes an event
 * the server has not acknowledged, and nothing bypasses the queue.
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
  const CAP = 2000, BATCH_MAX = 50, BACKOFF_MIN = 15, BACKOFF_MAX = 300;
  const KEY_UID = "spoke:uid", KEY_EVENTS = "spoke:events", KEY_OUTBOX = "spoke:outbox", KEY_DEV = "spoke:dev";

  function bucket(userHash) { return parseInt(String(userHash).slice(0, 4), 16) / 65535; }
  function flagOnFor(userHash, rollout) { return bucket(userHash) < Number(rollout || 0); }

  // --- pure helpers (node-tested) ---------------------------------------------------
  function takeBatch(list, n) { return list.slice(0, n || BATCH_MAX); }
  function ack(list, batch) {                       // remove exactly the acknowledged rows, by content
    const sent = new Set(batch.map(r => JSON.stringify(r)));
    const out = [];
    for (const r of list) { const k = JSON.stringify(r); if (sent.has(k)) sent.delete(k); else out.push(r); }
    return out;
  }
  function backoffNext(prev) { return Math.min(BACKOFF_MAX, Math.max(BACKOFF_MIN, (prev || 0) * 2)); }
  function retryAfterSeconds(header, fallback) { const n = Number(header); return Number.isFinite(n) && n > 0 ? Math.min(n, 3600) : fallback; }

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
  function readList(key) { try { return JSON.parse(store().getItem(key) || "[]"); } catch (e) { return []; } }
  function writeList(key, list) { try { store().setItem(key, JSON.stringify(list.slice(-CAP))); } catch (e) { /* storage blocked: events are lost, never the game */ } }

  const T = {
    EVENTS, DERIVED, CAP, BATCH_MAX, BACKOFF_MIN, BACKOFF_MAX, bucket, flagOnFor, takeBatch, ack, backoffNext, retryAfterSeconds,
    manifest: null, userHash: null, session: null, dev: false,
    _timer: null, _started: 0, _inflight: false, _backoff: 0, _nextTry: 0, _ended: false,

    endpoint() { return (this.manifest && this.manifest.telemetry && this.manifest.telemetry.endpoint) || ""; },

    async init(manifest) {
      this.manifest = manifest;
      this.dev = /[?&]dev=1/.test(location.search) || (store() && store().getItem(KEY_DEV) === "1");
      let uid = store() && store().getItem(KEY_UID);
      if (!uid) { uid = uuid(); try { store().setItem(KEY_UID, uid); } catch (e) { /* no storage: per-load user */ } }
      this.userHash = await sha256hex16(uid);
      this.session = uuid().slice(0, 8);
      this._started = Date.now();
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { this.end(); this.flush({ beacon: true }); } });
      window.addEventListener("pagehide", () => { this.end(); this.flush({ beacon: true }); });
      if (this.endpoint()) this._timer = setInterval(() => this.flush(), (manifest.telemetry.flush_s || 15) * 1000);
      this.event("session_start");
      if (this.endpoint()) this.flush();            // anything left from the last load goes first
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
      writeList(KEY_EVENTS, readList(KEY_EVENTS).concat([row]));
      if (this.endpoint()) {
        const box = readList(KEY_OUTBOX).concat([row]);
        writeList(KEY_OUTBOX, box);
        if (box.length >= (this.manifest.telemetry.batch || 20)) this.flush();
      }
      return row;
    },

    end() {
      if (this._ended) return;
      this._ended = true;
      this.event("session_end", Math.round((Date.now() - this._started) / 1000));
    },

    flush(opts) {
      const ep = this.endpoint();
      if (!ep) return;
      const box = readList(KEY_OUTBOX);
      if (!box.length) return;
      const batch = takeBatch(box, BATCH_MAX);
      const body = JSON.stringify(batch);
      if (opts && opts.beacon) {                     // last words: fire, keep, let the fingerprints dedupe
        if (navigator.sendBeacon) navigator.sendBeacon(ep, new Blob([body], { type: "text/plain" }));
        return;
      }
      if (this._inflight || Date.now() < this._nextTry) return;
      this._inflight = true;
      const self = this;
      fetch(ep, { method: "POST", body, headers: { "Content-Type": "text/plain" }, keepalive: true }).then(res => {
        if (res.ok) {
          writeList(KEY_OUTBOX, ack(readList(KEY_OUTBOX), batch));
          self._backoff = 0; self._nextTry = 0;
          if (readList(KEY_OUTBOX).length >= BATCH_MAX) setTimeout(() => self.flush(), 0);
        } else if (res.status === 400 || res.status === 413) {
          writeList(KEY_OUTBOX, ack(readList(KEY_OUTBOX), batch));   // the batch itself is refused: never retried
          if (self.dev) throw new Error("telemetry batch refused: " + res.status);
        } else {
          self._backoff = backoffNext(self._backoff);
          self._nextTry = Date.now() + retryAfterSeconds(res.headers.get("Retry-After"), self._backoff) * 1000;
        }
      }).catch(err => {
        self._backoff = backoffNext(self._backoff);
        self._nextTry = Date.now() + self._backoff * 1000;
        if (self.dev && err && /refused/.test(String(err.message))) console.warn(err.message);
      }).finally(() => { self._inflight = false; });
    },

    count() { return readList(KEY_EVENTS).length; },
    unsent() { return this.endpoint() ? readList(KEY_OUTBOX).length : 0; },
    exportJsonl() { const l = readList(KEY_EVENTS); return l.map(r => JSON.stringify(r)).join("\n") + (l.length ? "\n" : ""); },
    clearEvents() { writeList(KEY_EVENTS, []); writeList(KEY_OUTBOX, []); },
    resetPlayer() { try { store().removeItem(KEY_UID); store().removeItem(KEY_EVENTS); store().removeItem(KEY_OUTBOX); } catch (e) { /* ignore */ } },
  };
  return T;
}));
