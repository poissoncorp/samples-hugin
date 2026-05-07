#!/usr/bin/env python3
"""
Probe RavenDB's Corax timing for a sequence of queries on HuginAI.

Run each query 3 times: first is cache-miss (cold, includes Ollama embed),
runs 2-3 should hit @embeddings-cache-for-querying (warm).

Used to calibrate the embedGenerated heuristic threshold in backend/app.js.
"""
import json
import urllib.request
import statistics

QUERIES = [
    "raspberry pi gpio",
    "kernel panic recovery",
    "docker compose volumes",
    "slow computer fix",
    "wifi setup linux",
    "windows update problem",
]
RUNS_PER_QUERY = 3
URL = "http://127.0.0.1:8080/databases/HuginAI/queries"

def corax_for(q):
    rql = (
        "from index 'Questions/ByVector' "
        "where vector.search(TitleVector, "
        "embedding.text(\"" + q.replace('"', '\\"') + "\", ai.task('embedtaskhuginai'))) "
        "limit 5 include timings()"
    )
    body = json.dumps({"Query": rql}).encode()
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.load(r)
    try:
        return int(d["Timings"]["Timings"]["Query"]["Timings"]["Corax"]["DurationInMs"])
    except (KeyError, TypeError):
        return None

cold, warm = [], []
for q in QUERIES:
    durations = []
    for i in range(RUNS_PER_QUERY):
        c = corax_for(q)
        durations.append(c)
    print(f'  q="{q}": {durations}')
    cold.append(durations[0])
    warm.extend(durations[1:])

print()
print("=== summary ===")
print(f"cold (run 1):  n={len(cold)}  min={min(cold)}  max={max(cold)}  mean={int(statistics.mean(cold))}  median={int(statistics.median(cold))}")
print(f"warm (run 2+): n={len(warm)}  min={min(warm)}  max={max(warm)}  mean={int(statistics.mean(warm))}  median={int(statistics.median(warm))}")
sep_midpoint = (max(warm) + min(cold)) / 2
print()
print(f"max(warm)  = {max(warm)} ms")
print(f"min(cold)  = {min(cold)} ms")
print(f"midpoint   = {int(sep_midpoint)} ms")
print(f"suggested threshold (max(warm) * 2 with headroom): {int(max(warm) * 2)} ms")
print(f"current threshold in backend: 800 ms")
