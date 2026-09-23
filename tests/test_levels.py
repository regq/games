"""levels.json (issue #5b): base levels plus flag-keyed variants.

Shape rules apply to EVERY game (parametrised over check_manifest.manifests(), the same
glob CI and the Pages workflow use); values that belong to one game live in that game's
own fixture below. Until 2026-09-23 this file was hard-wired to `game-01`, so a second
game would have shipped with no content coverage at all and nobody would have noticed.

The merge itself is the engine's applyVariants, run under node when node exists.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess

import pytest

from test_manifest import ROOT
import check_manifest as cm

FLAG_NAME = re.compile(r"^[a-z0-9_]{3,32}$")
LEVELS_NAME = "levels.json"


def games() -> list[str]:
    """Every game folder that ships content. A game with no levels.json is not a
    failure -- not every kind of spoke has levels -- it simply has nothing here to check."""
    return sorted(p.parent.name for p in cm.manifests() if (p.parent / LEVELS_NAME).exists())


def content(game: str) -> dict:
    return json.loads((ROOT / game / LEVELS_NAME).read_text(encoding="utf-8"))


def pytest_generate_tests(metafunc):
    if "game" in metafunc.fixturenames:
        found = games()
        metafunc.parametrize("game", found or [pytest.param("none", marks=pytest.mark.skip(reason="no game ships levels.json"))])


def test_at_least_one_game_ships_content():
    """The guard on the guard: if this file silently matched nothing, every test below
    would skip and the suite would still be green."""
    assert games(), "no */levels.json found -- the shape rules below are checking nothing"


def test_base_levels_are_numbered_from_one_and_every_knob_is_a_positive_number(game):
    levels = content(game)["levels"]
    assert levels, f"{game}: no levels"
    assert [L["n"] for L in levels] == list(range(1, len(levels) + 1)), f"{game}: levels are not 1..n"
    for L in levels:
        for k, v in L.items():
            if k == "n":
                continue
            assert isinstance(v, (int, float)) and v > 0, f"{game} L{L['n']}.{k} = {v!r}"


def test_every_level_has_the_same_keys(game):
    """A knob that exists on one level and not another is a variant waiting to fail:
    applyVariants merges over the base row, so a missing base key reads as undefined."""
    levels = content(game)["levels"]
    keys = [set(L) for L in levels]
    assert all(k == keys[0] for k in keys), f"{game}: levels disagree on their keys: {[sorted(k) for k in keys]}"


def test_variants_name_manifest_grade_flags_real_levels_and_only_base_keys(game):
    c = content(game)
    base = {str(L["n"]): L for L in c["levels"]}
    variants = c.get("variants")
    assert isinstance(variants, dict), f"{game}: variants must be an object (may be empty)"
    for flag, per in variants.items():
        assert FLAG_NAME.match(flag), f"{game}: {flag}"
        assert isinstance(per, dict) and per, f"{game}: {flag} is empty"
        for n, over in per.items():
            assert n in base, f"{game}: {flag}: level {n} does not exist"
            assert set(over) <= set(base[n]) - {"n"}, f"{game}: {flag} L{n}: unknown override {set(over) - set(base[n])}"
            for k, v in over.items():
                assert isinstance(v, (int, float)) and v > 0, f"{game}: {flag} L{n}.{k}"


def test_the_engine_merges_variants_only_for_active_flags_and_only_on_their_level(game):
    """Run against each game's OWN engine and content: the contract is applyVariants,
    not any particular knob, so this reads the first variant the game happens to ship."""
    if shutil.which("node") is None:
        pytest.skip("node not on PATH")
    c = content(game)
    if not c.get("variants"):
        pytest.skip(f"{game} ships no variants")
    flag = sorted(c["variants"])[0]
    lvl, over = sorted(c["variants"][flag].items())[0]
    key = sorted(over)[0]
    idx = [str(L["n"]) for L in c["levels"]].index(lvl)
    other = next((i for i in range(len(c["levels"])) if i != idx), idx)
    script = (
        "const g = require(process.argv[1]); const c = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));"
        "const [flag, idx, other, key] = [process.argv[3], +process.argv[4], +process.argv[5], process.argv[6]];"
        "const L = c.levels[idx], O = c.levels[other];"
        "process.stdout.write(JSON.stringify(["
        "  g.applyVariants(L, c.variants, [])[key],"
        "  g.applyVariants(L, c.variants, [flag])[key],"
        "  g.applyVariants(O, c.variants, [flag])[key],"
        "  g.applyVariants(L, c.variants, ['definitely_not_a_flag', flag])[key],"
        "  L[key], O[key]]));"
    )
    r = subprocess.run(["node", "-e", script, str(ROOT / game / "game.js"), str(ROOT / game / LEVELS_NAME),
                        flag, str(idx), str(other), key], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    off, on, other_on, with_noise, base_l, base_o = json.loads(r.stdout)
    assert off == pytest.approx(base_l)                      # no flag: the base row, untouched
    assert on == pytest.approx(over[key])                    # flag on: the override, on its own level
    assert other_on == pytest.approx(base_o)                 # another level: never touched
    assert with_noise == pytest.approx(over[key])            # an unknown flag alongside changes nothing
    assert base_l == pytest.approx(content(game)["levels"][idx][key])   # the file on disk is unchanged


# --- per-game values ---------------------------------------------------------------

def test_game_01_bands_shrink_and_wide_l3_is_the_former_hard_coded_multiplier():
    c = content("game-01")
    widths = [L["band_width"] for L in c["levels"]]
    assert widths == sorted(widths, reverse=True)
    for L in c["levels"]:
        assert 0 < L["band_center"] < 1 and 0 < L["band_width"] < 1
    assert c["variants"]["wide_l3"]["3"]["band_width"] == pytest.approx(0.09 * 1.5)
