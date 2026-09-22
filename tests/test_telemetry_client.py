"""Route A client (issue #3): the pure pieces of shared/telemetry.js under node — a batch
is taken from the front, an ack removes exactly the sent rows, backoff doubles between
15 s and 300 s, Retry-After is honoured — plus the manifest rule for a live endpoint."""
from __future__ import annotations

import json
import shutil
import subprocess

import pytest

from test_manifest import GOOD, ROOT, cm

TELEMETRY = ROOT / "shared" / "telemetry.js"


def _node(script: str, *args: str):
    if shutil.which("node") is None:
        pytest.skip("node not on PATH")
    r = subprocess.run(["node", "-e", script, str(TELEMETRY), *args], capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def test_take_batch_ack_and_backoff_are_pure_and_exact():
    rows = [{"event": "level_win", "ts": f"2026-09-22T18:00:0{i}Z"} for i in range(4)]
    dup = [rows[1], rows[1]]                                           # two identical rows: an ack of one removes one
    out = _node("const T=require(process.argv[1]);const rows=JSON.parse(process.argv[2]);const dup=JSON.parse(process.argv[3]);"
                "const batch=T.takeBatch(rows,2);"
                "process.stdout.write(JSON.stringify({batch, left:T.ack(rows,batch), dupLeft:T.ack(dup,[dup[0]]),"
                "bo:[T.backoffNext(0),T.backoffNext(15),T.backoffNext(200),T.backoffNext(300)],"
                "ra:[T.retryAfterSeconds('120',15),T.retryAfterSeconds('nope',15),T.retryAfterSeconds('99999',15)], cap:[T.CAP,T.BATCH_MAX]}))",
                json.dumps(rows), json.dumps(dup))
    assert out["batch"] == rows[:2] and out["left"] == rows[2:] and out["dupLeft"] == [rows[1]]
    assert out["bo"] == [15, 30, 300, 300] and out["ra"] == [120, 15, 3600] and out["cap"] == [2000, 50]


def test_module_still_exposes_the_flag_bucket_and_the_nine_names():
    out = _node("const T=require(process.argv[1]);process.stdout.write(JSON.stringify([T.EVENTS.length, T.DERIVED, T.bucket('ffff000000000000'), typeof T.unsent]))")
    assert out == [9, ["rage_quit"], 1.0, "function"]


def test_manifest_endpoint_rule():
    live = {**GOOD, "telemetry": {"endpoint": "https://spoke-ingest.regq.workers.dev/v1/events", "batch": 20, "flush_s": 15}}
    assert cm.shape_errors(live, "game-01") == []
    bad = {**GOOD, "telemetry": {"endpoint": "http://spoke-ingest.regq.workers.dev/v1/events", "batch": 20, "flush_s": 15}}
    assert any("must be '' or https://<host>/v1/events" in e for e in cm.shape_errors(bad, "game-01"))
    wrong_path = {**GOOD, "telemetry": {"endpoint": "https://x.workers.dev/events", "batch": 20, "flush_s": 15}}
    assert any("v1/events" in e for e in cm.shape_errors(wrong_path, "game-01"))
    too_big = {**GOOD, "telemetry": {"endpoint": "https://x.workers.dev/v1/events", "batch": 80, "flush_s": 15}}
    assert any("batch must be 1..50" in e for e in cm.shape_errors(too_big, "game-01"))
    assert cm.shape_errors(GOOD, "game-01") == []                         # '' stays legal (Route B)
