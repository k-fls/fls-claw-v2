# Upstream-sweep toolkit (`scripts/sweep/`)

Scripted core of the FLSclaw self-maintenance pipeline: the driver that keeps the
fork current with upstream, plus the config and test material it reads.

**The spec is `DRIVER.md`** — model, scope and topology, planning, the case loop,
the quality gates, tiers, publication, the result-id registry, and the file map.
Read it before changing anything here; this file is orientation only and
deliberately states no rules of its own.

The only command surface:

```
pnpm exec tsx scripts/sweep/sweep-machine.ts <start|next-case|report-case|report-pr|finish|abort> [flags]
```

One tool sits beside it, because the `fork-registry-generate` skill invokes it:

```
pnpm exec tsx scripts/sweep/sweep.ts validate-registry --repo <repo> --inventory <dir>
```

Everything in this directory is DEVELOPER documentation, except `doctrine/`,
which is the sweep agent's only documentation — self-contained by rule: nothing
in it may reference another file, and nothing outside it may be put in front of
the agent.

## Directory map

```
scripts/sweep/
  README.md                  this file
  DRIVER.md                  THE driver specification
  doctrine/                  THE AGENT'S ONLY DOCS
    SWEEP-DOCTRINE.md          how to run a sweep, what to claim, what to write
    RESULT-CODES.md            one line per ERR*/WARN*: meaning + what to do
  *.ts                       the toolkit + colocated *.test.ts (DRIVER.md §12.1)
  sweep-machine.ts           the six-command agent-facing CLI
  sweep.ts                   the inventory validator CLI (validate-registry)
  checks.json                the checks gate's typecheck/test command lists
  cut-point-exceptions.yaml  owner-approved blame exceptions
  inventory/
    <id>.yaml                one strict-config entry per fork feature
  bootstrap/
    fork-registry@<hash>/    the committed inventory snapshot (loader default)
  registry/
    schema/feature-entry.schema.json
    routing.yaml             global driver lever (scope_guard_mode)
    scope.yaml               scope policy: exclusions, extra_edges
    prompts/                 overlap-check.md, catch-all-triage.md
  test-cases/
    propagation/cases/*.yaml pinned-SHA propagation cases
    fixtures/                dated recon snapshots
.claude/skills/fork-registry-generate/
  SKILL.md  seeds.yaml       inventory (re)generation; judgment seeds live HERE
```

Group-owned state lives OUTSIDE the clone, under `--workspace` (the group root,
parent of the clone): `propagation/pass-<watermark12>/` and the durable
`rr-cache/`. See `DRIVER.md` §12.2-§12.3.

## Running it against a group workspace

From a clone where `origin` = k-fls/fls-claw-v2 and `upstream` =
nanocoai/nanoclaw — never a human's checkout with work in progress. The group
root (the parent of the clone) is the workspace. Then run the loop described in
`doctrine/SWEEP-DOCTRINE.md`; the clone persists across sessions.

## References

- `DRIVER.md` — the driver specification.
- `doctrine/` — the sweep agent's documentation.
- `docs/design/02-self-maintaining-flsclaw.md` §5 — where this pipeline sits in
  the estate design.
- `.claude/skills/fork-registry-generate/` — inventory regeneration and the
  canonical judgment seeds.
