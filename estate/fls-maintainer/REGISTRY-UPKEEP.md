# Registry upkeep

Nothing prompts this — no driver error points here. You come here because YOU
noticed one of the triggers in the doctrine.

- Keep `./inventory/` current: when fork branches appear, land, or retire,
  regenerate entries locally with the `fork-registry-generate` skill.
- The moment a blocked case is resolved, record the outcome in the live
  inventory entry (`prompt.extra_context`: what, when, implementing PR,
  standing consequence).
- Propose `seeds.yaml` updates (new invariants, hints, recurring resolutions)
  and refreshed inventory snapshots in your end-of-sweep result for the OWNER
  to apply — you push nothing and open no PR for them (rule 3).

The inventory is a GENERATED artifact (`.claude/skills/fork-registry-generate/`).
Hand-editing `./inventory/*.yaml` is wiped by the next regeneration — which is
why changes go to the owner as a proposal, not as an edit you make.
