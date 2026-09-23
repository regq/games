"""CI gate for every `<game>/spoke.json` (ADR-001, amendment 7).

    python tools/check_manifest.py            # every manifest, against git tags
    python tools/check_manifest.py --no-git   # shape only (no tag lookup)

Checks, per manifest:
  - shape: id == folder name, kind, semver version, repo, url, telemetry
    {endpoint, batch, flush_s}, optional support {kofi: '' | a Ko-fi page URL},
    flags {name: {rollout, since, window_h, metric, expect, issue}},
    health.url (or health.hub_tool), rollback_ref, increment.prompt_version
  - version == the nearest tag `<id>/vX.Y.Z` reachable from HEAD, and when the
    commit at HEAD changed `version`, that tag must sit on HEAD itself.
Exit 1 with one line per failure. Nothing is written.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")
FLAG_NAME = re.compile(r"^[a-z0-9_]{3,32}$")
# `page` (2026-09-23): a spoke that is a page, not a loop. Its levels are doors -- see
# ADR-001 amendment 12 -- so it ships no levels.json and no game template may fire on it.
KINDS = ("game", "bot", "shop", "persona", "page")
METRICS = ("win_rate", "fail_per_session", "session_len_s", "rage_quit_rate", "thumbs_up_rate", "level_win_rate")
LEVEL_ONLY_METRICS = ("level_win_rate",)          # meaningless without a level to measure at
METRIC_AT = re.compile(r"^([a-z_]+)(?:@L(\d+))?$")


def split_metric(raw: object) -> tuple[str, int | None]:
    """`fail_per_session@L1` -> ('fail_per_session', 1); `win_rate` -> ('win_rate', None).

    The `@L<n>` qualifier (2026-09-23) scopes a metric to one level, which is what makes a
    target like "12% of runs reach L3" expressible at all -- a whole-session win rate cannot
    say anything about one segment."""
    m = METRIC_AT.match(str(raw or "").strip())
    if not m:
        return str(raw or ""), None
    return m.group(1), (int(m.group(2)) if m.group(2) else None)
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,31}$")
# support: optional links the game shows as a door out (Ko-fi today). A key that is
# present but empty renders nothing -- the same "muted until set" rule the Door page
# uses -- so a manifest can ship the slot long before the page behind it exists.
SUPPORT_LINKS = {"kofi": re.compile(r"^https://ko-fi\.com/[A-Za-z0-9_-]+/?$")}


def manifests(root: Path | None = None) -> list[Path]:
    root = root if root is not None else ROOT   # resolved at call time (C4)
    return sorted(p for p in root.glob("*/spoke.json") if p.parent.name not in ("node_modules", "tools", "tests", "docs", "shared"))


def shape_errors(m: dict, folder: str) -> list[str]:
    e: list[str] = []
    if m.get("id") != folder:
        e.append(f"id {m.get('id')!r} != folder {folder!r}")
    if not ID_RE.match(str(m.get("id") or "")):
        e.append("id must match [a-z0-9][a-z0-9-]{1,31}")
    if m.get("kind") not in KINDS:
        e.append("kind must be " + " | ".join(KINDS))
    if not SEMVER.match(str(m.get("version") or "")):
        e.append("version must be X.Y.Z")
    for key in ("repo", "url", "rollback_ref"):
        if not isinstance(m.get(key), str) or not m[key]:
            e.append(f"{key} missing")
    t = m.get("telemetry") or {}
    if not isinstance(t, dict) or "endpoint" not in t or not isinstance(t.get("batch"), int) or not isinstance(t.get("flush_s"), (int, float)):
        e.append("telemetry needs endpoint (may be ''), batch (int), flush_s (number)")
    elif t.get("endpoint") and not re.match(r"^https://[^/\s]+/v1/events$", str(t["endpoint"])):
        e.append("telemetry.endpoint must be '' or https://<host>/v1/events (the ingest Worker)")
    elif t.get("endpoint") and not (1 <= t["batch"] <= 50):
        e.append("telemetry.batch must be 1..50 when an endpoint is set (the Worker takes 50 per POST)")
    s = m.get("support")
    if s is not None:
        if not isinstance(s, dict):
            e.append("support must be an object (may be omitted)")
        else:
            for name, url in s.items():
                if name not in SUPPORT_LINKS:
                    e.append(f"support.{name}: unknown link (known: {', '.join(sorted(SUPPORT_LINKS))})")
                elif not isinstance(url, str):
                    e.append(f"support.{name}: must be a string (empty = the door is hidden)")
                elif url and not SUPPORT_LINKS[name].match(url):
                    e.append(f"support.{name}: must be '' or a {name} page URL")
    h = m.get("health") or {}
    if not isinstance(h, dict) or not (h.get("url") or h.get("hub_tool")):
        e.append("health needs url (deployed spoke.json) or hub_tool (a hub-side read check)")
    inc = m.get("increment") or {}
    if not isinstance(inc, dict) or not str(inc.get("prompt_version") or ""):
        e.append("increment.prompt_version missing")
    flags = m.get("flags")
    if not isinstance(flags, dict):
        e.append("flags must be an object (may be empty)")
    else:
        for name, f in flags.items():
            if not FLAG_NAME.match(name):
                e.append(f"flag {name!r}: name must match [a-z0-9_]{{3,32}}")
            if not isinstance(f, dict):
                e.append(f"flag {name!r}: not an object"); continue
            r = f.get("rollout")
            if not isinstance(r, (int, float)) or not 0 <= r <= 1:
                e.append(f"flag {name!r}: rollout must be 0..1")
            if not isinstance(f.get("since"), str) or not f["since"]:
                e.append(f"flag {name!r}: since (ISO 8601) missing")
            if not isinstance(f.get("window_h"), int) or f["window_h"] <= 0:
                e.append(f"flag {name!r}: window_h must be a positive int")
            metric, level = split_metric(f.get("metric"))
            if metric not in METRICS or (metric in LEVEL_ONLY_METRICS and level is None):
                e.append(f"flag {name!r}: metric must be one of {', '.join(METRICS)}"
                         + (f" ({', '.join(LEVEL_ONLY_METRICS)} only with @L<n>)" if metric in LEVEL_ONLY_METRICS else ""))
            elif level is not None and level < 1:
                e.append(f"flag {name!r}: @L<n> must be a level number from 1")
            targeted = "target" in f or "tolerance" in f
            if targeted:
                if level is None:
                    e.append(f"flag {name!r}: the target form needs a level: metric <m>@L<n> target <v> tolerance <t>")
                if not isinstance(f.get("target"), (int, float)):
                    e.append(f"flag {name!r}: target must be a number")
                if not isinstance(f.get("tolerance"), (int, float)) or f["tolerance"] <= 0:
                    e.append(f"flag {name!r}: tolerance must be positive")
                if "expect" in f:
                    e.append(f"flag {name!r}: a flag is either the lift form (expect) or the target form (target + tolerance), never both")
            elif not isinstance(f.get("expect"), (int, float)) or f["expect"] <= 0:
                e.append(f"flag {name!r}: expect must be a positive lift (or use the target form: target + tolerance)")
            if "baseline" in f:
                e.append(f"flag {name!r}: no baseline key -- canary vs control only (ADR-001 amendment 1)")
    return e


def nearest_tag(spoke_id: str, root: Path | None = None) -> str | None:
    root = root if root is not None else ROOT   # resolved at call time (C4)
    r = subprocess.run(["git", "-C", str(root), "describe", "--tags", "--abbrev=0", "--match", f"{spoke_id}/v*"],
                       capture_output=True, text=True)
    return r.stdout.strip() or None


def tag_on_head(tag: str, root: Path | None = None) -> bool:
    root = root if root is not None else ROOT   # resolved at call time (C4)
    r = subprocess.run(["git", "-C", str(root), "tag", "--points-at", "HEAD"], capture_output=True, text=True)
    return tag in r.stdout.split()


def version_changed_at_head(manifest: Path, root: Path | None = None) -> bool:
    root = root if root is not None else ROOT   # resolved at call time (C4)
    r = subprocess.run(["git", "-C", str(root), "diff", "HEAD~1", "HEAD", "--", str(manifest.relative_to(root).as_posix())],
                       capture_output=True, text=True)
    return any(line.startswith(("+", "-")) and '"version"' in line for line in r.stdout.splitlines())


def git_errors(m: dict, manifest: Path, root: Path | None = None) -> list[str]:
    root = root if root is not None else ROOT   # resolved at call time (C4)
    sid, ver = m["id"], m["version"]
    tag = nearest_tag(sid, root)
    if tag is None:
        return [f"no tag {sid}/v* reachable from HEAD (tag the release: git tag {sid}/v{ver})"]
    if tag != f"{sid}/v{ver}":
        return [f"version {ver} != nearest tag {tag}"]
    if version_changed_at_head(manifest, root) and not tag_on_head(tag, root):
        return [f"this commit changed version to {ver} but tag {tag} is not on HEAD"]
    return []


def check(root: Path | None = None, use_git: bool = True) -> list[str]:
    root = root if root is not None else ROOT   # resolved at call time (C4)
    out: list[str] = []
    found = manifests(root)
    if not found:
        return ["no */spoke.json found"]
    for p in found:
        try:
            m = json.loads(p.read_text(encoding="utf-8"))
        except ValueError as exc:
            out.append(f"{p.parent.name}: not JSON ({exc})"); continue
        errs = shape_errors(m, p.parent.name)
        if not errs and use_git:
            errs = git_errors(m, p, root)
        out += [f"{p.parent.name}: {e}" for e in errs]
    return out


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    errs = check(use_git="--no-git" not in argv)
    for e in errs:
        print("MANIFEST " + e)
    if not errs:
        print(f"manifests ok: {', '.join(p.parent.name for p in manifests())}")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
