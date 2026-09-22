"""check_manifest: shape rules, and version == nearest <id>/v* tag (tmp git repos only)."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import check_manifest as cm  # noqa: E402

GOOD = {
    "id": "game-01", "kind": "game", "version": "0.1.0", "repo": "regq/games", "url": "https://regq.github.io/games/game-01/",
    "telemetry": {"endpoint": "", "batch": 20, "flush_s": 15},
    "flags": {"wide_l3": {"rollout": 0.1, "since": "2026-09-29T00:00:00Z", "window_h": 72, "metric": "win_rate", "expect": 0.1, "issue": 12}},
    "health": {"url": "https://regq.github.io/games/game-01/spoke.json"},
    "rollback_ref": "game-01/v0.1.0", "increment": {"prompt_version": "1", "weekday": "mon"},
}


def test_the_real_manifests_pass_the_shape_rules():
    for p in cm.manifests():
        assert cm.shape_errors(json.loads(p.read_text(encoding="utf-8")), p.parent.name) == []


@pytest.mark.parametrize("patch, needle", [
    ({"id": "game-02"}, "!= folder"),
    ({"version": "1.0"}, "X.Y.Z"),
    ({"kind": "toy"}, "kind must be"),
    ({"telemetry": {"batch": 20}}, "telemetry needs"),
    ({"health": {}}, "health needs"),
    ({"flags": {"Bad Name": GOOD["flags"]["wide_l3"]}}, "name must match"),
    ({"flags": {"wide_l3": {**GOOD["flags"]["wide_l3"], "rollout": 1.5}}}, "rollout must be"),
    ({"flags": {"wide_l3": {**GOOD["flags"]["wide_l3"], "metric": "fun"}}}, "metric must be"),
    ({"flags": {"wide_l3": {**GOOD["flags"]["wide_l3"], "baseline": 0.4}}}, "no baseline key"),
    ({"flags": {"wide_l3": {**GOOD["flags"]["wide_l3"], "expect": 0}}}, "positive lift"),
    ({"support": "https://ko-fi.com/x"}, "support must be an object"),
    ({"support": {"patreon": "https://patreon.com/x"}}, "unknown link"),
    ({"support": {"kofi": 12}}, "must be a string"),
    ({"support": {"kofi": "http://ko-fi.com/x"}}, "must be '' or a kofi page URL"),
    ({"support": {"kofi": "https://ko-fi.example.com/x"}}, "must be '' or a kofi page URL"),
])
def test_shape_rules_name_the_fault(patch, needle):
    m = {**GOOD, **patch}
    errs = cm.shape_errors(m, "game-01")
    assert errs and any(needle in e for e in errs)


@pytest.mark.parametrize("support", [None, {}, {"kofi": ""}, {"kofi": "https://ko-fi.com/raudyr"}, {"kofi": "https://ko-fi.com/raudyr/"}])
def test_support_is_optional_and_may_be_empty(support):
    m = {**GOOD} if support is None else {**GOOD, "support": support}
    assert cm.shape_errors(m, "game-01") == []


def test_the_client_shows_a_support_door_only_for_a_real_kofi_url():
    """supportUrl() in game.js is the one gate: anything that is not a Ko-fi page
    URL renders nothing, so a half-filled manifest cannot ship a dead link."""
    if shutil.which("node") is None:
        pytest.skip("node not on PATH")
    cases = {
        "https://ko-fi.com/raudyr": "https://ko-fi.com/raudyr",
        "https://ko-fi.com/raudyr/": "https://ko-fi.com/raudyr/",
        "": "", "   ": "",
        "http://ko-fi.com/raudyr": "",
        "https://ko-fi.com.evil.example/raudyr": "",
        "javascript:alert(1)": "",
    }
    script = ("const g=require(process.argv[1]);const c=JSON.parse(process.argv[2]);"
              "console.log(JSON.stringify(Object.keys(c).map(u=>g.supportUrl({support:{kofi:u}}))))")
    r = subprocess.run(["node", "-e", script, str(ROOT / "game-01" / "game.js"), json.dumps(cases)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout) == list(cases.values())
    empty = subprocess.run(["node", "-e", "const g=require(process.argv[1]);console.log(JSON.stringify([g.supportUrl({}), g.supportUrl({support:{}}), g.supportUrl(null)]))",
                            str(ROOT / "game-01" / "game.js")], capture_output=True, text=True)
    assert empty.returncode == 0, empty.stderr
    assert json.loads(empty.stdout) == ["", "", ""]


def _git(repo: Path, *args: str) -> str:
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


@pytest.fixture
def repo(tmp_path):
    if shutil.which("git") is None:
        pytest.skip("git not on PATH")
    (tmp_path / "game-01").mkdir()
    (tmp_path / "game-01" / "spoke.json").write_text(json.dumps(GOOD, indent=2) + "\n", encoding="utf-8")
    _git(tmp_path, "init", "-q", "-b", "main")
    _git(tmp_path, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
    _git(tmp_path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "first")
    return tmp_path


def _bump(repo: Path, version: str) -> None:
    m = {**GOOD, "version": version}
    (repo / "game-01" / "spoke.json").write_text(json.dumps(m, indent=2) + "\n", encoding="utf-8")
    _git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-am", f"bump {version}")


def test_version_must_equal_the_nearest_tag_and_a_bump_must_be_tagged_on_head(repo):
    assert cm.check(repo) == ["game-01: no tag game-01/v* reachable from HEAD (tag the release: git tag game-01/v0.1.0)"]
    _git(repo, "tag", "game-01/v0.1.0")
    assert cm.check(repo) == []
    _bump(repo, "0.1.1")                                                   # version changed, no tag yet
    assert cm.check(repo) == ["game-01: version 0.1.1 != nearest tag game-01/v0.1.0"]
    _git(repo, "tag", "game-01/v0.1.1")                                    # tagged on the bump commit: release
    assert cm.check(repo) == []
    (repo / "game-01" / "KILLED.md").write_text("# killed\n", encoding="utf-8")   # a later commit without a version change is fine
    _git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
    _git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "note")
    assert cm.check(repo) == []
    _git(repo, "tag", "game-01/v0.1.2")                                    # someone tags the NOTE commit as 0.1.2 ...
    _bump(repo, "0.1.2")                                                   # ... and bumps the manifest one commit later: the tag is not on HEAD
    assert cm.check(repo) == ["game-01: this commit changed version to 0.1.2 but tag game-01/v0.1.2 is not on HEAD"]
    assert cm.check(repo, use_git=False) == []


def test_flag_bucket_matches_between_python_and_the_js_client():
    """The same 5 hashes bucket the same way in telemetry.js (via node) and in the
    formula the hub recomputes in SQL / Python. Skipped without node."""
    hashes = ["0000000000000000", "ffffffffffffffff", "7fff000000000000", "199a000000000000", "e66600000000ffff"]
    py = [int(h[:4], 16) / 65535 for h in hashes]
    if shutil.which("node") is None:
        pytest.skip("node not on PATH")
    script = ("const T=require(process.argv[1]);const hs=JSON.parse(process.argv[2]);"
              "console.log(JSON.stringify(hs.map(h=>[T.bucket(h), T.flagOnFor(h, 0.1)])))")
    r = subprocess.run(["node", "-e", script, str(ROOT / "shared" / "telemetry.js"), json.dumps(hashes)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    js = json.loads(r.stdout)
    for (b, on), p in zip(js, py):
        assert abs(b - p) < 1e-9 and on == (p < 0.1)
