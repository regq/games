"""long-walk's engine: the pure half, run under node. Seeded runs, speeds, hazard draws,
telegraphs and the token economy — everything a playtest cannot pin down by eye."""
from __future__ import annotations

import json
import math
import shutil
import subprocess

import pytest

from test_manifest import ROOT

GAME = ROOT / "long-walk"
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")


def content() -> dict:
    return json.loads((GAME / "levels.json").read_text(encoding="utf-8"))


def call(fn: str, *args) -> object:
    script = ("let b='';process.stdin.on('data',d=>b+=d).on('end',()=>{"
              "const g=require(process.argv[1]);const a=JSON.parse(b);"
              "process.stdout.write(JSON.stringify(g[process.argv[2]].apply(null,a)));});")
    r = subprocess.run(["node", "-e", script, str(GAME / "game.js"), fn], input=json.dumps(list(args)),
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def node(body: str, *args) -> object:
    """Run a snippet with the engine as `g` and JSON argv as `a`."""
    script = ("let b='';process.stdin.on('data',d=>b+=d).on('end',()=>{"
              "const g=require(process.argv[1]);const a=JSON.parse(b);"
              f"process.stdout.write(JSON.stringify((function(){{{body}}})()));}});")
    r = subprocess.run(["node", "-e", script, str(GAME / "game.js")], input=json.dumps(list(args)),
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


# --- the seed ----------------------------------------------------------------------

def test_a_seed_reproduces_a_run_exactly_and_two_seeds_do_not():
    same = node("const a1=g.mulberry32(a[0]), a2=g.mulberry32(a[0]), b=g.mulberry32(a[1]);"
                "const p=f=>Array.from({length:8},()=>f());"
                "return [p(a1), p(a2), p(b)];", 12345, 12346)
    assert same[0] == same[1], "the same seed must give the same run"
    assert same[0] != same[2]
    assert all(0 <= x < 1 for x in same[0])


def test_the_prng_is_uniform_enough_to_trust_a_hazard_rate():
    xs = node("const f=g.mulberry32(a[0]);return Array.from({length:4000},()=>f());", 7)
    assert abs(sum(xs) / len(xs) - 0.5) < 0.02
    quarters = [sum(1 for x in xs if i / 4 <= x < (i + 1) / 4) for i in range(4)]
    assert all(abs(q - 1000) < 120 for q in quarters), quarters


# --- speed, hazards, telegraph -------------------------------------------------------

def test_sprint_doubles_the_speed_and_boots_stack_on_top():
    c = content()
    L, cfg = c["levels"][0], c["meta"]
    walk = call("speedOf", L, {"boots": 0}, False, cfg)
    assert walk == pytest.approx(1.20)
    assert call("speedOf", L, {"boots": 0}, True, cfg) == pytest.approx(2.40)
    assert call("speedOf", L, {"boots": 2}, False, cfg) == pytest.approx(1.20 * 1.20)
    assert call("speedOf", L, {"boots": 2}, True, cfg) == pytest.approx(1.20 * 1.20 * 2)


def test_the_pack_lowers_the_hazard_rate_and_it_never_leaves_the_open_interval():
    c = content()
    L3, cfg = c["levels"][2], c["meta"]
    assert call("hazardRate", L3, {"pack": 0}, cfg) == pytest.approx(0.09)
    assert call("hazardRate", L3, {"pack": 1}, cfg) == pytest.approx(0.072)
    assert call("hazardRate", L3, {"pack": 2}, cfg) == pytest.approx(0.0576)
    assert call("hazardRate", {"hazard_per_10m": 0}, {"pack": 0}, cfg) > 0        # never 0: the gap draw would diverge
    assert call("hazardRate", {"hazard_per_10m": 5}, {"pack": 0}, cfg) <= 0.9


def test_the_telegraph_is_fixed_in_seconds_so_a_sprint_doubles_it_in_metres():
    """The GDD's claim, in code: the sprint does not shorten the warning in time, it
    raises what a missed one costs."""
    L = content()["levels"][0]
    assert call("telegraphMetres", L, 1.20) == pytest.approx(2.4)
    assert call("telegraphMetres", L, 2.40) == pytest.approx(4.8)
    wide = dict(L, telegraph_s=3.0)                                              # the telegraph_3s variant
    assert call("telegraphMetres", wide, 1.20) == pytest.approx(3.6)


def test_the_hazard_gap_is_geometric_and_lands_on_ten_metre_steps():
    assert call("nextHazardGap", 0.5, 0.0) == 10                                 # u=0 -> the very next step
    assert call("nextHazardGap", 0.5, 0.9) == 40                                 # ceil(log(.1)/log(.5)) = 4
    for u in (0.0, 0.25, 0.5, 0.75, 0.999999, 1.0):
        gap = call("nextHazardGap", 0.09, u)
        assert gap >= 10 and gap % 10 == 0, (u, gap)


def test_the_measured_hazard_rate_matches_the_rate_asked_for():
    """The number in levels.json has to mean what the GDD says it means: a chance per 10 m."""
    for rate in (0.02, 0.09):
        gaps = node("const f=g.mulberry32(7);"
                    "return Array.from({length:4000},()=>g.nextHazardGap(a[0], f()));", rate)
        measured = 10 / (sum(gaps) / len(gaps))                                  # 10 m / mean gap = per-10 m rate
        assert abs(measured - rate) < rate * 0.12, (rate, measured)


def test_a_seeded_run_reaches_the_same_distance_every_time():
    """The whole point of ctx.seed: replay the draw sequence, get the same hazards."""
    c = content()
    runs = node(
        "const c=a[0], seed=a[1], meta=a[2];"
        "function sim(){const f=g.mulberry32(seed);let d=0,seg=0,haz=0,n=0;"
        "  haz=d+g.nextHazardGap(g.hazardRate(c.levels[seg],meta,c.meta),f());"
        "  while(n<500){ d=haz; n++;"
        "    while(c.levels[seg] && d>=c.levels[seg].ends_at_m && seg<c.levels.length-1) seg++;"
        "    if(d>4000) break;"
        "    haz=d+g.nextHazardGap(g.hazardRate(c.levels[seg],meta,c.meta),f()); }"
        "  return [Math.round(d), n];}"
        "return [sim(), sim()];", c, 99, {"pack": 0})
    assert runs[0] == runs[1]


# --- the economy ---------------------------------------------------------------------

def test_upgrades_cost_what_levels_json_says_and_stop_at_their_cap():
    cfg = content()["meta"]
    poor = {"tokens": 2, "boots": 0, "pack": 0, "best": 0}
    assert call("upgrade", poor, cfg, "boots")["can"] is False                   # 3 needed
    rich = {"tokens": 10, "boots": 0, "pack": 0, "best": 0}
    after = call("buy", rich, cfg, "boots")
    assert (after["tokens"], after["boots"]) == (7, 1)
    two = call("buy", call("buy", rich, cfg, "boots"), cfg, "boots")
    assert (two["tokens"], two["boots"]) == (4, 2)
    assert call("upgrade", two, cfg, "boots")["can"] is False                    # capped at 2 stacks
    assert call("buy", two, cfg, "boots") == two                                 # a refused buy costs nothing
    packed = call("buy", rich, cfg, "pack")
    assert (packed["tokens"], packed["pack"]) == (5, 1)


def test_meta_survives_a_round_trip_and_junk_reads_as_a_fresh_player():
    out = node("const s={v:null,getItem(){return this.v},setItem(k,x){this.v=x}};"
               "g.writeMeta(s,{tokens:4,boots:1,pack:2,best:1234});"
               "const back=g.readMeta(s);"
               "s.v='{not json';const junk=g.readMeta(s);"
               "s.v=JSON.stringify({tokens:-5,boots:'x',best:-1});const bad=g.readMeta(s);"
               "return [back,junk,bad];")
    assert out[0] == {"tokens": 4, "boots": 1, "pack": 2, "best": 1234}
    assert out[1] == {"tokens": 0, "boots": 0, "pack": 0, "best": 0}
    assert out[2] == {"tokens": 0, "boots": 0, "pack": 0, "best": 0}             # negatives and junk clamp, never crash


# --- segments ------------------------------------------------------------------------

def test_the_segment_follows_the_distance_and_the_walk_goes_on_past_the_last_checkpoint():
    levels = content()["levels"]
    for metres, want in [(0, 0), (399, 0), (400, 1), (1199, 1), (1200, 2), (2399, 2), (2400, 2), (99999, 2)]:
        assert call("segmentAt", levels, metres) == want, metres


def test_the_two_pre_registered_variants_are_the_ones_the_gdd_named():
    c = content()
    assert set(c["variants"]) == {"telegraph_3s", "pass_hazard_12"}
    assert all(v["telegraph_s"] == 3.0 for v in c["variants"]["telegraph_3s"].values())
    assert c["variants"]["pass_hazard_12"]["3"]["hazard_per_10m"] == pytest.approx(0.12)
    base = {str(L["n"]): L for L in c["levels"]}
    assert base["3"]["hazard_per_10m"] == pytest.approx(0.09)                    # the control arm
    assert all(L["telegraph_s"] == 2.0 for L in c["levels"])


def test_both_flags_ship_at_rollout_zero_so_nobody_is_in_a_canary_yet():
    flags = json.loads((GAME / "spoke.json").read_text(encoding="utf-8"))["flags"]
    assert set(flags) == {"telegraph_3s", "pass_hazard_12"}
    assert all(f["rollout"] == 0 for f in flags.values())
    on = node("return [g.applyVariants(a[0],a[1],[]).telegraph_s, g.applyVariants(a[0],a[1],['telegraph_3s']).telegraph_s];",
              content()["levels"][0], content()["variants"])
    assert on == [2.0, 3.0]
