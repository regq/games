"""door.js: the page mapping (ADR-001 amendment 12), run under node.

`level` is a door, keyed by a stable slug. A click is a win. A session that shows a live
door for >= 20 s and takes none of them fails every one of them. A bounce fails nothing,
and a muted door can never fail because it could never be clicked.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess

import pytest

from test_manifest import ROOT

DOOR = ROOT / "door"
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")


def call(fn: str, *args) -> object:
    script = ("let b='';process.stdin.on('data',d=>b+=d).on('end',()=>{"
              "const d=require(process.argv[1]);const a=JSON.parse(b);"
              "process.stdout.write(JSON.stringify(d[process.argv[2]].apply(null,a)));});")
    r = subprocess.run(["node", "-e", script, str(DOOR / "door.js"), fn], input=json.dumps(list(args)),
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def node(body: str, *args) -> object:
    script = ("let b='';process.stdin.on('data',x=>b+=x).on('end',()=>{"
              "const d=require(process.argv[1]);const a=JSON.parse(b);"
              f"process.stdout.write(JSON.stringify((function(){{{body}}})()));}});")
    r = subprocess.run(["node", "-e", script, str(DOOR / "door.js")], input=json.dumps(list(args)),
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def doors() -> list[dict]:
    return [{"slug": "join", "level": 1}, {"slug": "support", "level": 2}]


def test_door_numbers_are_stable_ids_not_positions():
    assert call("levelOf", "join") == 1 and call("levelOf", "twitch") == 4
    assert call("levelOf", "nope") is None and call("levelOf", "") is None
    ids = node("return d.DOORS;")
    assert ids == {"join": 1, "support": 2, "game": 3, "twitch": 4}
    assert sorted(ids.values()) == list(range(1, len(ids) + 1)) and len(set(ids.values())) == len(ids)


def test_the_page_and_the_engine_agree_on_every_door():
    """The built page carries the ids door.js keys on; a rename in one must break here."""
    html = (DOOR / "index.html").read_text(encoding="utf-8")
    ids = node("return d.DOORS;")
    found = dict((m.group(1), int(m.group(2))) for m in re.finditer(r'data-door="([a-z]+)" data-level="(\d+)"', html))
    assert found == ids


def test_a_click_is_a_win_so_nothing_failed():
    assert call("failures", {"clicked": True, "seconds": 300, "doors": doors()}) == []


def test_a_bounce_under_twenty_seconds_fails_nothing():
    """Blaming a door for a page nobody read would poison the fail cliff."""
    for secs in (0, 5, 19.9):
        assert call("failures", {"clicked": False, "seconds": secs, "doors": doors()}) == []
    assert call("failures", {"clicked": False, "seconds": 20, "doors": doors()}) == doors()     # exactly at the line
    assert call("failures", {"clicked": False, "seconds": 600, "doors": doors()}) == doors()


def test_every_live_door_on_screen_failed_together():
    """Each door had its chance in the same session and none of them took it, so fail/win
    per door is exactly the click-through funnel."""
    three = doors() + [{"slug": "game", "level": 3}]
    assert call("failures", {"clicked": False, "seconds": 45, "doors": three}) == three


def test_a_muted_door_can_never_fail_because_it_could_never_be_clicked():
    nodes = [{"attrs": {"data-door": "join"}, "classes": ["door", "muted"]},
             {"attrs": {"data-door": "support"}, "classes": ["door"]},
             {"attrs": {"data-door": "twitch"}, "classes": ["door"]},
             {"attrs": {"data-door": "surprise"}, "classes": ["door"]}]
    live = node("return d.liveDoors(a[0].map(n => ({"
                "getAttribute: k => n.attrs[k] === undefined ? null : n.attrs[k],"
                "classList: { contains: c => n.classes.indexOf(c) >= 0 } })));", nodes)
    assert live == [{"slug": "support", "level": 2}, {"slug": "twitch", "level": 4}]   # muted and unknown both dropped


def test_the_bounce_threshold_is_the_documented_twenty_seconds():
    assert node("return d.BOUNCE_S;") == 20
    assert node("return d.KOFI;") == "support"


def test_the_manifest_is_a_page_and_ships_no_levels():
    m = json.loads((DOOR / "spoke.json").read_text(encoding="utf-8"))
    assert m["kind"] == "page" and m["id"] == "door"
    assert not (DOOR / "levels.json").exists()          # a page has no loop and no content file
    assert m["flags"] == {}
    assert m["telemetry"]["endpoint"].endswith("/v1/events")
