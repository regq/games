"""levels.json (issue #5b): base levels plus flag-keyed variants. Shape rules here;
the merge itself is the engine's applyVariants, run under node when node exists."""
from __future__ import annotations

import json
import re
import shutil
import subprocess

import pytest

from test_manifest import ROOT

FLAG_NAME = re.compile(r"^[a-z0-9_]{3,32}$")
GAME = ROOT / "game-01"


def content() -> dict:
    return json.loads((GAME / "levels.json").read_text(encoding="utf-8"))


def test_base_levels_are_numbered_one_to_three_and_the_band_shrinks():
    levels = content()["levels"]
    assert [L["n"] for L in levels] == [1, 2, 3]
    assert [L["band_width"] for L in levels] == sorted((L["band_width"] for L in levels), reverse=True)
    for L in levels:
        assert 0 < L["band_center"] < 1 and 0 < L["band_width"] < 1 and L["fill_per_s"] > 0


def test_variants_name_manifest_grade_flags_real_levels_and_only_base_keys():
    c = content()
    base = {str(L["n"]): L for L in c["levels"]}
    assert isinstance(c.get("variants"), dict) and c["variants"]
    for flag, per in c["variants"].items():
        assert FLAG_NAME.match(flag), flag
        assert isinstance(per, dict) and per
        for n, over in per.items():
            assert n in base, f"{flag}: level {n} does not exist"
            assert set(over) <= set(base[n]) - {"n"}, f"{flag} L{n}: unknown override {set(over) - set(base[n])}"
            for k, v in over.items():
                assert isinstance(v, (int, float)) and v > 0, f"{flag} L{n}.{k}"


def test_wide_l3_is_the_former_hard_coded_multiplier_as_content():
    assert content()["variants"]["wide_l3"]["3"]["band_width"] == pytest.approx(0.09 * 1.5)


def test_engine_merges_variants_only_for_active_flags_and_only_on_their_level():
    if shutil.which("node") is None:
        pytest.skip("node not on PATH")
    script = (
        "const g = require(process.argv[1]); const c = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));"
        "const L3 = c.levels[2], L1 = c.levels[0];"
        "const out = ["
        "  g.applyVariants(L3, c.variants, []).band_width,"
        "  g.applyVariants(L3, c.variants, ['wide_l3']).band_width,"
        "  g.applyVariants(L1, c.variants, ['wide_l3']).band_width,"
        "  g.applyVariants(L3, c.variants, ['wide_l3']).band_center,"
        "  g.applyVariants(L3, c.variants, ['nope', 'wide_l3']).band_width,"
        "  L3.band_width];"
        "process.stdout.write(JSON.stringify(out));"
    )
    r = subprocess.run(["node", "-e", script, str(GAME / "game.js"), str(GAME / "levels.json")], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout) == pytest.approx([0.09, 0.135, 0.30, 0.70, 0.135, 0.09])   # base untouched, other levels untouched
