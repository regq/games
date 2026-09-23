"""shared/skin.js: the v1 skin schema (ADR-001 amendment 10), run under node.

Refused, never repaired: one bad slot fails the whole skin and the game keeps its
built-in look. SVG is excluded until a sanitizer exists.
"""
from __future__ import annotations

import base64
import json
import shutil
import subprocess

import pytest

from test_manifest import ROOT

SKIN = ROOT / "shared" / "skin.js"
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")


def png(nbytes: int = 64) -> str:
    return "data:image/png;base64," + base64.b64encode(b"\x89PNG" + b"x" * max(0, nbytes - 4)).decode()


def wav(nbytes: int = 64) -> str:
    return "data:audio/wav;base64," + base64.b64encode(b"RIFF" + b"x" * max(0, nbytes - 4)).decode()


def call(fn: str, *args) -> object:
    """Args go in on STDIN, not argv: a 32 KB data URI on a Windows command line is
    `WinError 206, the filename or extension is too long`, and the size limits are
    exactly what these tests have to push against."""
    script = ("let b='';process.stdin.on('data',d=>b+=d).on('end',()=>{"
              "const s=require(process.argv[1]);const a=JSON.parse(b);"
              "process.stdout.write(JSON.stringify(s[process.argv[2]].apply(null,a)));});")
    r = subprocess.run(["node", "-e", script, str(SKIN), fn], input=json.dumps(list(args)), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def errors(skin: object, version: str = "0.1.0") -> list[str]:
    return call("validate", skin, version)["errors"]


def good() -> dict:
    return {"name": "default", "engine": ">=0.1.0", "palette": {"ink": "#f1e6d3", "sky": "#123"},
            "sprites": {"walker": png()}, "sfx": {"chime": wav()}}


def test_a_good_skin_passes_and_merges_over_the_builtin():
    v = call("validate", good(), "0.1.0")
    assert v["ok"] and v["errors"] == []
    merged = call("merge", {"palette": {"ink": "#000", "dim": "#888"}, "sprites": {}, "sfx": {}}, good())
    assert merged["palette"] == {"ink": "#f1e6d3", "dim": "#888", "sky": "#123"}      # skin wins, builtin fills
    assert merged["sprites"]["walker"].startswith("data:image/png;base64,")


def test_the_engine_gate_refuses_a_skin_newer_than_the_game():
    assert call("satisfies", "0.2.0", ">=0.1.0") is True
    assert call("satisfies", "0.1.0", ">=0.2.0") is False
    assert call("satisfies", "0.1.0", "0.1.0") is False        # a bare version is not a range
    assert call("satisfies", "", ">=0.1.0") is False and call("satisfies", "0.1.0", "") is False
    assert errors({**good(), "engine": ">=9.0.0"}, "0.1.0") == [
        'engine ">=9.0.0" is not satisfied by this game at 0.1.0']
    assert errors({**good(), "engine": ">=0.1.0"}, "0.1.0") == []


@pytest.mark.parametrize("uri, why", [
    ("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "SVG is excluded"),          # the one the ADR names
    ("data:image/jpeg;base64,/9j/4AAQ", "must be a PNG"),
    ("https://example.com/walker.png", "must be a PNG"),
    ("data:image/png,notbase64", "must be a PNG"),
])
def test_only_png_data_uris_are_sprites(uri, why):
    errs = errors({**good(), "sprites": {"walker": uri}})
    assert len(errs) == 1 and why in errs[0]


def test_sizes_and_slot_counts_are_refused_not_truncated():
    big = errors({**good(), "sprites": {"walker": png(32 * 1024 + 1)}})
    assert len(big) == 1 and "over the 32768 limit" in big[0]
    assert errors({**good(), "sprites": {"walker": png(32 * 1024)}}) == []            # exactly at the limit passes
    loud = errors({**good(), "sfx": {"chime": wav(64 * 1024 + 1)}})
    assert len(loud) == 1 and "over the 65536 limit" in loud[0]
    many = {f"s{i}": png() for i in range(13)}
    errs = errors({**good(), "sprites": many})
    assert any("13 slots, at most 12" in e for e in errs)
    assert errors({**good(), "sprites": {f"s{i}": png() for i in range(12)}}) == []


def test_palette_slots_must_be_hex_and_named():
    assert errors({**good(), "palette": {"ink": "red"}}) == ["palette.ink: must be #rgb or #rrggbb"]
    assert errors({**good(), "palette": {"ink": "#12345"}}) == ["palette.ink: must be #rgb or #rrggbb"]
    assert errors({**good(), "palette": {"Ink Slot": "#fff"}})[0].startswith("palette.Ink Slot: slot names are")
    assert errors({**good(), "palette": {"ink": "#FFF", "sky": "#0a0B0c"}}) == []


def test_every_reason_is_reported_not_just_the_first():
    errs = errors({"engine": ">=9.9.9", "palette": {"ink": "nope"}, "sprites": {"w": "http://x/y.png"},
                   "sfx": {"c": "data:audio/mp3;base64,AAAA"}, "surprise": 1}, "0.1.0")
    assert len(errs) == 5, errs
    assert any("engine" in e for e in errs) and any("palette.ink" in e for e in errs)
    assert any("sprites.w" in e for e in errs) and any("sfx.c" in e for e in errs)
    assert any('unknown key "surprise"' in e for e in errs)


def test_a_refused_skin_yields_nothing_and_a_missing_section_is_simply_absent():
    v = call("validate", {"palette": {"ink": "nope"}}, "0.1.0")
    assert v["ok"] is False and v["skin"] is None                 # never half-applied
    assert errors({}) == [] and errors({"palette": {}, "sprites": {}, "sfx": {}}) == []
    for junk in ([], "skin", 3, None):
        assert errors(junk) == ["skin.json is not an object"]


def test_the_shipped_skins_all_validate_against_their_own_game():
    """Every skin.json in the repo, checked against the version its manifest declares."""
    import check_manifest as cm
    seen = 0
    for m in cm.manifests():
        skin = m.parent / "skin.json"
        if not skin.exists():
            continue
        seen += 1
        version = json.loads(m.read_text(encoding="utf-8"))["version"]
        v = call("validate", json.loads(skin.read_text(encoding="utf-8")), version)
        assert v["ok"], f"{m.parent.name}/skin.json: {v['errors']}"
    if not seen:
        pytest.skip("no game ships a skin.json yet")
