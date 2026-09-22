# Games — HTML5 micro-game factory

One repo, many small browser games, each in its own folder with its own
`spoke.json`. GitHub Pages serves the repo root, so `game-01/` is
`https://regq.github.io/games/game-01/`.

The contract with the hub that watches these games is
`docs/adr/ADR-001-feedback-loop-contract.md`: a game emits nine primitive
events through `shared/telemetry.js`, the hub ranks what hurts, proposes
increments as GitHub issues, ships them behind flags in `spoke.json`, and
promotes or kills them on the canary's numbers.

## Layout

| path | what |
|---|---|
| `shared/telemetry.js` | the one telemetry client every game loads (no dependencies) |
| `<game>/spoke.json` | the manifest: id, version (= git tag `<game>/vX.Y.Z`), flags, health, rollback ref |
| `<game>/index.html`, `game.js`, `levels.json` | the game; content is JSON, engine is tagged code. `levels.json` also holds `variants` `{ "<flag>": { "<level n>": { overrides } } }`: a player whose active flags include the flag plays that level with the overrides merged in, so a numbers-only increment ships as content behind its flag |
| `<game>/KILLED.md` | increments the canary reverted (written by the hub, never by hand) |
| `tools/check_manifest.py` | CI gate: every manifest well-formed and `version == nearest tag` |
| `docs/adr/` | decisions |

## Work orders

A GitHub issue labelled `increment` + `spoke:<game>` is a work order. It
carries evidence from the hub's ranking, the change, the proving metric and
the expected lift, and the flag name it ships behind.

## Dev

```bash
python -m pytest -q tests
python tools/check_manifest.py
```

Open a game with `?dev=1` for the dev overlay: event count (and, when an
endpoint is set, how many are still unsent), **Export** (the events as JSONL,
also copied into the box), **Reset player**. With `telemetry.endpoint` empty
the export is what the hub imports (Route B); with it set the client also
sends batches to the ingest endpoint and the hub pulls them nightly (Route A),
and the export stays as the fallback.

## Release

```bash
# bump "version" in game-01/spoke.json, commit, then tag that commit:
git tag game-01/v0.1.1 && git push --tags && git push
```

CI refuses a manifest whose `version` is not the nearest `<game>/v*` tag.

## Privacy

No accounts, no cookies, no user-agent logging, and nothing stored about your
connection. The only identifier is a hash of a random id kept in your
browser's localStorage; clearing it makes you a new player. Events are
anonymous play statistics (level won or failed, session length, a thumbs
vote, a problem report you type). When a game sends events to its ingest
endpoint, the edge network that hosts it sees your IP address to deliver the
request, as any website does; the endpoint keeps none of it, and rate limits
are counted, never logged per person.
