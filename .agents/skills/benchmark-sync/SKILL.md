---
name: benchmark-sync
description: Use when benchmarking OmniRecall sync performance.
---

# Benchmark sync

Match the requested stage: a request to discuss a benchmark needs a
concrete proposed comparison; a request to run it needs measurements.
Do not let benchmark infrastructure become the deliverable.

## Set up the comparison

Inspect the built CLI's `sync --help` and the comparator's actual help
and implementation. In this checkout, the CLI entry point is
`node apps/cli/dist/index.js`. Build first if it is missing or stale,
and keep build or package-download time separate from sync time.

Use equivalent source sessions and isolated temporary destination
archives. Confirm each tool's source and database path options instead
of inventing flags. If isolation requires a temporary home, ensure it
still points to the intended input corpus; an empty import is not a
valid fast result. Never delete the user's archive to simulate a cold
import or modify original session files to manufacture append cases.

Select the workloads needed to answer the question:

| Workload         | Starting state                                               |
| ---------------- | ------------------------------------------------------------ |
| Initial import   | Fresh destination archive with the chosen corpus             |
| Unchanged repeat | Completed import, identical sources                          |
| Append           | Completed import, records appended to a fixture copy         |
| Rewrite          | Completed import, existing content changed in a fixture copy |

An initial import is not necessarily a cold filesystem-cache run.
Record that distinction rather than claiming to have flushed
operating-system caches. Use synthetic or copied fixtures for
controlled edits. Keep private session content out of committed
fixtures and benchmark reports.

## Run a small useful measurement

Start with the requested commands and a small comparison, using a
bounded timeout. Check exit status and sync counts before interpreting
elapsed time. Report timeouts as incomplete runs with the observed
limit; do not treat them as completed timings. Investigate a stalled
run before repeating it unchanged.

Repeat completed runs when needed to distinguish an improvement from
noise. Reset the destination for each initial-import run. Report the
number of repetitions and spread when making a comparative claim. A
large permanent harness is warranted only if repeated use needs it.

Verify equivalent useful output: which sessions were imported, what
became searchable, and whether either tool skipped or rejected
records. Files, sessions, records, and searchable messages are
different units. An unchanged sync should preserve retrieval results
without adding logical duplicates.

## Explain the result

Report the commands, versions, corpus, workload, elapsed time, counts,
and failures. State whether source parsing, database writes, process
startup, or installation are included. Investigate code paths or
profile when a causal explanation is needed; elapsed time alone does
not prove where the cost lies.

For example, compare initial import against initial import before
explaining a difference between OmniRecall and PiRecall. Then measure
an unchanged repeat separately. Account for additional retained
evidence or different parsing semantics instead of assuming both tools
do the same work.

Conclude with the measured difference, supported explanation, and the
smallest useful next step. Treat timings as observations, not a
brittle wall-clock CI threshold.
