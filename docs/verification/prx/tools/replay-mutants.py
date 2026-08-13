#!/usr/bin/env python3
"""Empirical mutant replay: apply each surviving/no-coverage mutant from the
focused report to the real source, run the real mutation-scope suite as a
subprocess, and record whether the suite fails (mutant killed in reality —
Stryker activation artifact) or passes (true survivor).

Restores every file byte-exactly afterwards; asserts restoration.
"""
import json
import subprocess
import sys
import hashlib

REPORT = "reports/prx-mutation-blocking.json"
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/replay-results.json"
ONLY_IDS = set(sys.argv[2].split(",")) if len(sys.argv) > 2 else None

r = json.load(open(REPORT))
targets = []
for fn, f in r["files"].items():
    for m in f["mutants"]:
        if m["status"] in ("Survived", "NoCoverage"):
            if ONLY_IDS and m["id"] not in ONLY_IDS:
                continue
            targets.append((fn, m))

originals = {}
def apply_mutant(fn, m):
    if fn not in originals:
        originals[fn] = open(fn, "rb").read()
    text = originals[fn].decode()
    lines = text.split("\n")
    s, e = m["location"]["start"], m["location"]["end"]
    # mutation-testing schema: 1-based lines AND columns, end-exclusive col
    def off(pos):
        return sum(len(l) + 1 for l in lines[: pos["line"] - 1]) + pos["column"] - 1
    a, b = off(s), off(e)
    mutated = text[:a] + m["replacement"] + text[b:]
    open(fn, "w").write(mutated)
    return text[a:b]

def restore_all():
    for fn, data in originals.items():
        open(fn, "wb").write(data)

results = []
try:
    for i, (fn, m) in enumerate(targets):
        orig_span = apply_mutant(fn, m)
        proc = subprocess.run(
            ["npx", "vitest", "run", "-c", "scripts/prx/vitest.prx.mutation.config.ts",
             "--reporter=dot", "--silent"],
            capture_output=True, text=True, timeout=300,
        )
        killed = proc.returncode != 0
        results.append({
            "id": m["id"], "file": fn, "line": m["location"]["start"]["line"],
            "mutator": m["mutatorName"], "status": m["status"],
            "replacement": m["replacement"], "originalSpan": orig_span[:60],
            "replayKilled": killed,
        })
        print(f"[{i+1}/{len(targets)}] {fn.split('/')[-1]}:{m['location']['start']['line']} "
              f"id={m['id']} {m['mutatorName']} -> {'KILLED-IN-REALITY' if killed else 'TRUE-SURVIVOR'}",
              flush=True)
        # restore before next mutant
        open(fn, "wb").write(originals[fn])
finally:
    restore_all()
    for fn, data in originals.items():
        assert hashlib.sha256(open(fn, "rb").read()).hexdigest() == hashlib.sha256(data).hexdigest()

json.dump(results, open(OUT, "w"), indent=1)
k = sum(1 for x in results if x["replayKilled"])
print(f"\nreplayed {len(results)}: {k} KILLED-IN-REALITY, {len(results)-k} TRUE-SURVIVOR")
print(f"results: {OUT}")
