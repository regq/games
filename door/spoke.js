/* spoke.js — boots the Door as a measured spoke. Loaded last, after telemetry.js and door.js.
 *
 * Order matters and is the only subtle thing here: door.js's `leave` handler is registered
 * BEFORE Telemetry.init, so it runs before telemetry's own pagehide handler. That way the
 * level_fail events for doors nobody took are already in the outbox when telemetry's beacon
 * fires, and they leave with session_end instead of a tick too late.
 */
(async function () {
  "use strict";
  if (typeof Telemetry === "undefined" || typeof DoorSpoke === "undefined") return;   // instrumentation is optional; the page is not
  let spoke = null;
  const leave = () => { if (spoke) spoke.leave(); };
  window.addEventListener("pagehide", leave);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") leave(); });

  let manifest;
  try { manifest = await (await fetch("spoke.json")).json(); } catch (e) { return; }
  const T = await Telemetry.init(manifest);
  spoke = DoorSpoke.attach(T, document);
})();
