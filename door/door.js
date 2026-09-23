/* door.js — the Door page's telemetry (spoke `door`, kind `page`, ADR-001 amendment 12).
 *
 * A page has no loop, so the nine primitives have to be mapped to what a page actually
 * does, and the mapping is the whole design:
 *
 *   level       A DOOR. Numbered by a stable id from the door's SLUG, never by its
 *               position on the page -- the "door order" increment reorders them, and a
 *               position-keyed level would silently compare two different doors across
 *               one window.
 *   level_win   that door was clicked.
 *   level_fail  at session end, IF no door was clicked AND the session lasted at least
 *               BOUNCE_S, one per LIVE door that was on screen.
 *   purchase    fires in ADDITION to level_win, on the Ko-fi door only: the win says a
 *               door earned a click, the purchase says a money door opened. Value null --
 *               Ko-fi's free tier has no callback, so a click is all this side can know.
 *   thumbs      the "was this useful" prompt.  report  its "something is wrong" path.
 *
 * NOT USED, and not faked: ugc_publish / ugc_play. Nothing on the Door is user-made.
 *
 * WHY 20 SECONDS, AND WHY ONLY LIVE DOORS. Hover does not exist on a phone and the
 * audience is phone-first; "tapped then abandoned" is not observable once a click
 * navigates away. A door shown for 20 s and not taken is the only thing on a page that
 * honestly means *tried and failed*. Under 20 s nothing is emitted: that is a bounce,
 * visible as a session with zero wins, and blaming a door for a page nobody read would
 * poison the fail cliff. A MUTED door cannot be clicked, so it can never have failed --
 * only live doors are counted.
 *
 * The cost, stated: several fails in one session inflate session-level fail_per_session,
 * which is why every page INCREMENT template proves on a per-door metric instead.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DoorSpoke = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const BOUNCE_S = 20;          // below this a session is a bounce, not a door's failure
  const KOFI = "support";       // the one door that is also a money door

  /** Stable door ids. A door's number is its identity for the whole life of the spoke:
   *  change a slug and you have a new door, not a renamed one. Never reuse a number. */
  const DOORS = { join: 1, support: 2, game: 3, twitch: 4 };

  function levelOf(slug) { return Object.prototype.hasOwnProperty.call(DOORS, slug) ? DOORS[slug] : null; }

  /** The doors a session could actually have taken: on the page, with a real href. */
  function liveDoors(nodes) {
    const out = [];
    for (const el of nodes || []) {
      const slug = el.getAttribute && el.getAttribute("data-door");
      const level = levelOf(slug);
      if (level === null) continue;
      if (el.classList && el.classList.contains("muted")) continue;      // cannot be clicked, cannot have failed
      out.push({ slug, level });
    }
    return out;
  }

  /** Should this session report door failures, and for which doors? Pure, so the rule is
   *  testable without a page: it is the part that decides what the fail cliff means. */
  function failures(opts) {
    if (opts.clicked) return [];                       // a click is a win; nothing failed
    if (!(opts.seconds >= BOUNCE_S)) return [];        // a bounce, not a verdict on any door
    return opts.doors.slice();
  }

  function attach(T, doc) {
    const nodes = doc.querySelectorAll("[data-door]");
    const doors = liveDoors(nodes);
    let clicked = false, sent = false;
    const started = Date.now();

    for (const el of nodes) {
      const slug = el.getAttribute("data-door");
      const level = levelOf(slug);
      if (level === null || (el.classList && el.classList.contains("muted"))) continue;
      el.addEventListener("click", function () {
        clicked = true;
        T.event("level_win", 1, { level, door: slug });
        if (slug === KOFI) T.event("purchase", null, { level, door: slug, via: "kofi", where: "door" });
        T.flush();                                     // the click navigates away: send it now
      });
    }

    // Registered BEFORE Telemetry.init in the page, so this runs before telemetry's own
    // pagehide handler and its beacon carries these events out with session_end.
    function leave() {
      if (sent) return;
      sent = true;
      const secs = (Date.now() - started) / 1000;
      for (const d of failures({ clicked, seconds: secs, doors })) {
        T.event("level_fail", 1, { level: d.level, door: d.slug });
      }
    }
    return { leave, doors, isClicked: () => clicked };
  }

  return { BOUNCE_S, DOORS, KOFI, levelOf, liveDoors, failures, attach };
}));
