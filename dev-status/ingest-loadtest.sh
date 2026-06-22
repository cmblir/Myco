#!/usr/bin/env bash
# Memex ingest load test + monitor (parallel).
#
# Replicates the desktop app's CLI ingest (claude --print --allowedTools ...
# --model <model>, cwd = vault, prompt on stdin) over N synthetic sources of
# varied shape (long article, CSV-as-text, notes), measuring per-ingest:
# success, wiki files created/modified, citations added, duration. Writes a
# JSONL log + a summary so a 1000-run soak can be monitored.
#
# Usage:  ./ingest-loadtest.sh [N] [model] [concurrency]
#   N            number of ingests to run        (default 5)
#   model        claude CLI model alias/id       (default haiku)
#   concurrency  parallel workers, P             (default 6)
#
# Wall-clock is ~ (N / P) x per-ingest time. Each worker runs in its OWN copy
# of the seed vault (vault-w1..wP) so concurrent `claude` processes never race
# on wiki/index.md or wiki/log.md; at most P claude processes run at once.
# Each ingest is still the identical CLI path the app uses.
#
# It seeds throwaway vaults (copies the app's CLAUDE.md + a wiki scaffold) so
# your real ~/Documents/Memex is never touched.
set -uo pipefail

N="${1:-5}"
MODEL="${2:-haiku}"
CONCURRENCY="${3:-6}"
TOOLS="Read,Write,Edit,Glob,Grep,Bash"
RUN_DIR="/tmp/memex-ingest-test"
LOG="$RUN_DIR/results.jsonl"
SEED_VAULT="$HOME/Documents/Memex"

# clamp concurrency to [1, N]
[ "$CONCURRENCY" -lt 1 ] && CONCURRENCY=1
[ "$CONCURRENCY" -gt "$N" ] && CONCURRENCY="$N"

mkdir -p "$RUN_DIR"

# --- seed one worker vault (idempotent copy of the scaffold) ----------------
seed_vault() {
  local vault="$1"
  rm -rf "$vault"; mkdir -p "$vault/raw" "$vault/wiki" "$vault/ingest-reports"
  if [ -f "$SEED_VAULT/CLAUDE.md" ]; then
    cp "$SEED_VAULT/CLAUDE.md" "$vault/CLAUDE.md"
    cp "$SEED_VAULT"/wiki/index.md "$vault/wiki/" 2>/dev/null || true
    cp "$SEED_VAULT"/wiki/log.md "$vault/wiki/" 2>/dev/null || true
    # a handful of existing concept pages to link to (not the whole vault)
    ls "$SEED_VAULT"/wiki/*.md 2>/dev/null | head -8 | while read -r f; do cp "$f" "$vault/wiki/"; done
  else
    printf '# Memex Vault\nMaintain wiki/ pages with frontmatter + [^src-*] citations per ingest.\n' > "$vault/CLAUDE.md"
    printf '# Index\n' > "$vault/wiki/index.md"
    printf '# Log\n' > "$vault/wiki/log.md"
  fi
}

# --- synthetic sources of varied shape ------------------------------------
src_long() {  # a long article (~ a few thousand words)
  printf '# Retrieval-Augmented Generation: a survey\n\n'
  for j in $(seq 1 60); do  # NB: not `i` — that is the outer run counter
    printf 'Section %s. RAG systems retrieve documents and condition generation on them. ' "$j"
    printf 'Dense retrievers embed queries and passages into a shared space; the top-k passages are concatenated into the prompt. '
    printf 'Failure modes include retrieval miss, context dilution, and citation drift. Hybrid sparse-dense retrieval and reranking mitigate these. '
    printf 'Compared to a maintained wiki, RAG re-derives knowledge per query instead of accumulating it.\n\n'
  done
}
src_csv() {  # CSV-as-text (spreadsheet-style data)
  printf 'model,context_window,input_per_m_usd,output_per_m_usd,notes\n'
  printf 'gemini-2.5-flash-lite,1000000,0.10,0.40,cheapest viable\n'
  printf 'gemini-2.5-flash,1000000,0.30,2.50,quality-safe default\n'
  printf 'claude-haiku-4-5,200000,1.00,5.00,best instruction following\n'
  printf 'deepseek-v4-flash,1000000,0.14,0.28,data residency concern\n'
  printf 'gpt-5.4-nano,?,0.20,1.25,mid price\n'
}
src_notes() {  # short notes ('%s' form so leading "-" bullets aren't read as flags)
  printf '# Meeting notes: knowledge base architecture\n\n'
  printf '%s\n' '- Decided: wiki pages are the source of truth, RAG is a fallback.'
  printf '%s\n' '- Each ingest must add citations and flag contradictions.'
  printf '%s\n' '- Open question: how to cap per-ingest token cost for unlimited plans.'
  printf '%s\n' '- Cheapest capable model for ingest looks like Gemini Flash-Lite.'
}

pick_source() {  # cycle source shapes by index
  case $(( $1 % 3 )) in
    0) echo long ;;
    1) echo csv ;;
    *) echo notes ;;
  esac
}

# --- one ingest in a given worker vault ------------------------------------
# args: <global_index> <worker_id> <vault> <out_jsonl>
run_one() {
  local i="$1" w="$2" vault="$3" out="$4"
  local shape slug title
  shape=$(pick_source "$i")
  slug="loadtest-${shape}-${i}"
  title="Load test ${shape} #${i}"
  case "$shape" in
    long)  src_long  > "$vault/raw/$slug.md" ;;
    csv)   { printf '# %s\n\n' "$title"; src_csv; } > "$vault/raw/$slug.md" ;;
    notes) src_notes > "$vault/raw/$slug.md" ;;
  esac

  # Snapshot wiki state before the run; a per-worker marker detects touched pages.
  local before_files before_cites marker
  before_files=$(find "$vault/wiki" -name '*.md' | wc -l | tr -d ' ')
  before_cites=$(grep -rho '\[\^src-' "$vault/wiki" 2>/dev/null | wc -l | tr -d ' ')
  marker="$RUN_DIR/.before-w$w"; touch "$marker"; sleep 1

  local prompt
  prompt="New source has been added at \`raw/$slug.md\` (title: \"$title\"). Please ingest it into the wiki following the workflow in CLAUDE.md:
1. Read the source completely.
2. Identify pages it affects (entities, concepts, techniques, analyses).
3. Update existing pages with inline citations, or create new pages with required frontmatter.
4. Create the source-summary page \`wiki/source-$slug.md\`.
5. Update \`wiki/index.md\` and append a \`wiki/log.md\` entry.
6. Write an ingest report at \`ingest-reports/<datetime>-$slug.md\`.
When done, output a one-line confirmation."

  local start_ms end_ms dur err out_text
  start_ms=$(perl -MTime::HiRes=time -e 'printf "%d", time()*1000')
  err=""
  # Run with cwd = vault so the CLI's file tools resolve raw/ and wiki/ paths.
  out_text=$( (cd "$vault" && printf '%s' "$prompt" | claude --print --allowedTools "$TOOLS" --model "$MODEL") 2>"$RUN_DIR/stderr-w$w.txt" ) \
    || err=$(head -c 300 "$RUN_DIR/stderr-w$w.txt")
  end_ms=$(perl -MTime::HiRes=time -e 'printf "%d", time()*1000')
  dur=$(( end_ms - start_ms ))

  local after_files after_cites changed new_files new_cites report status
  after_files=$(find "$vault/wiki" -name '*.md' | wc -l | tr -d ' ')
  after_cites=$(grep -rho '\[\^src-' "$vault/wiki" 2>/dev/null | wc -l | tr -d ' ')
  changed=$(find "$vault/wiki" -name '*.md' -newer "$marker" | wc -l | tr -d ' ')
  new_files=$(( after_files - before_files ))
  new_cites=$(( after_cites - before_cites ))
  report=$(find "$vault/ingest-reports" -name "*-$slug.md" | head -1)

  # success = the wiki actually changed (mirrors the app's wikiChanged check)
  if [ "$changed" -gt 0 ] && [ -z "$err" ]; then status="ok"; else status="fail"; fi

  printf '{"i":%d,"worker":%d,"slug":"%s","shape":"%s","status":"%s","duration_ms":%d,"wiki_changed":%d,"new_pages":%d,"new_citations":%d,"report":"%s","error":%s}\n' \
    "$i" "$w" "$slug" "$shape" "$status" "$dur" "$changed" "$new_files" "$new_cites" "$(basename "${report:-}")" \
    "$(printf '%s' "${err:-}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" >> "$out"
  printf '[w%d i=%d/%d] %-7s %-22s %6sms  changed=%s new=%s cites=+%s  %s\n' \
    "$w" "$i" "$N" "$status" "$slug" "$dur" "$changed" "$new_files" "$new_cites" "${err:0:50}"
}

# --- worker: process every index assigned to this worker, sequentially ------
# args: <worker_id>
worker_loop() {
  local w="$1"
  local vault="$RUN_DIR/vault-w$w"
  local out="$RUN_DIR/results-w$w.jsonl"
  seed_vault "$vault"
  : > "$out"
  local i
  for i in $(seq 1 "$N"); do
    # round-robin assignment: worker w owns indices where ((i-1) % P)+1 == w
    if [ $(( (i - 1) % CONCURRENCY + 1 )) -eq "$w" ]; then
      run_one "$i" "$w" "$vault" "$out"
    fi
  done
}

est_per=85
est_wall=$(( (N + CONCURRENCY - 1) / CONCURRENCY * est_per ))
echo "ingest load test: N=$N model=$MODEL concurrency=$CONCURRENCY"
echo "est wall-clock ~ $(( est_wall / 60 ))m (${est_per}s/ingest, ${CONCURRENCY}x parallel)"
echo "log: $LOG"

# launch P workers in the background, wait for all
for w in $(seq 1 "$CONCURRENCY"); do
  worker_loop "$w" &
done
wait

# merge per-worker logs into one sorted JSONL
cat "$RUN_DIR"/results-w*.jsonl 2>/dev/null \
  | python3 -c 'import sys,json; rows=[json.loads(l) for l in sys.stdin if l.strip()]; rows.sort(key=lambda r:r["i"]); print("\n".join(json.dumps(r) for r in rows))' \
  > "$LOG"

echo "----"
python3 - "$LOG" <<'PY'
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
n=len(rows); ok=sum(1 for r in rows if r["status"]=="ok")
durs=[r["duration_ms"] for r in rows] or [0]
durs_s=sorted(durs)
def pct(p): return durs_s[min(len(durs_s)-1, int(len(durs_s)*p))]/1000
pages=sum(r["new_pages"] for r in rows); cites=sum(r["new_citations"] for r in rows)
print(f"DONE: {ok}/{n} ok, {n-ok} fail")
print(f"per-ingest: avg {sum(durs)//max(n,1)/1000:.0f}s  p50 {pct(0.5):.0f}s  p95 {pct(0.95):.0f}s  max {max(durs)/1000:.0f}s")
print(f"output: {pages} new pages, {cites} new citations")
for sh in ("csv","notes","long"):
    sr=[r for r in rows if r["shape"]==sh]
    if sr:
        sok=sum(1 for r in sr if r["status"]=="ok")
        print(f"  {sh}: {sok}/{len(sr)} ok, avg {sum(r['duration_ms'] for r in sr)//len(sr)/1000:.0f}s, pages={sum(r['new_pages'] for r in sr)}, cites={sum(r['new_citations'] for r in sr)}")
fails=[r for r in rows if r["status"]!="ok"]
if fails:
    print("FAILURES:")
    for r in fails[:20]:
        print(f"  i={r['i']} {r['slug']}: {(r.get('error') or 'wiki unchanged')[:80]}")
PY
echo "per-run JSONL: $LOG"
