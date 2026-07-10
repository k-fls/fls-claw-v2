# Bootstrap snapshot — fork feature inventory

Verbatim copy of the fork-registry feature entries at the moment the
dissolved `maint/fork-registry` branch was superseded (owner decision,
2026-07-10: registry branch dissolved; durable artifacts live with the sweep
tooling, live state is derived or group-owned).

- **Snapshot date:** 2026-07-10
- **Source ref:** `maint/fork-registry@ca693b0e584c8c50e8bb7ab070a3d83b6b865c00`
- **Tree hash** (`git rev-parse ca693b0e:fork-registry/features`):
  `e91f4b4e33e9e6ad04df685d4212dec7e4e05015` (directory name carries the
  first 12 chars)

Purpose: cheap re-bootstrap of a maintenance group's live inventory — copy
`features/` into the group workspace (or point `--inventory` here directly),
then regenerate mechanical fields with the `fork-registry-generate` skill.
The moment of capture is explicit: `verified_against` tips below are valid
AS OF the snapshot date and drift as branches move; the validator (rule 6)
flags the drift.

| entry | status | branch | verified_against |
|---|---|---|---|
| edition.fls-ai-bot | shipped | edition/fls-ai-bot | ca2fec600f5c380eb5c98880ec684a9f3456c50f |
| feat.autonomy-matrix | in-progress | feat/autonomy-matrix | 7e0b90c1cb151a74f8ef80a88e344240ef3a1772 |
| feat.calendar-triggers | in-progress | feat/calendar-triggers | 26c3aaee16e626a50a694543b8ad4f46aa8becaf |
| feat.dependent-groups | in-progress | feat/dependent-groups | 79f9625b35e59fd9bce36662b5759a794c5b37be |
| feat.maintenance-sweep | in-progress | feat/maintenance-sweep | 4d24f6c83b4c6d2530fe7d8c61767d19c7f6a8d8 |
| feat.memory-substrate | in-progress | feat/memory-substrate | ea94786081db7700f4280513f3a84db4794daccd |
| feat.mitm-credential-proxy | shipped | feat/mitm-credential-proxy | 4d386dbab63a5204b32117ad6a82b6d100da3c71 |
| feat.onecli-broker | in-progress | feat/onecli-broker | 49f6b0720413df20ca6084a39681ebcb13d93b2f |
| feat.ops-registry | in-progress | feat/ops-registry | 7b9dca7d36d236ed4948144fa8bf1955c1a51681 |
| feat.question-fanout | in-progress | feat/question-fanout | ab965f57727d0e68129cb013299408aa48e8c177 |
| feat.ssh-auth | in-progress | feat/ssh-auth | d7a2fa6eb957bfe3da2e230ae14fcdab0fcd065d |
| feat.tenant-budgets | in-progress | feat/tenant-budgets | 4bf0b87a343d505b77a9bb5c55e2ab6837ef8c19 |
| feat.todoist-channel | in-progress | feat/todoist-channel | 9d20c363ee532aaa20d7f8bb61e5100105e97aa1 |
| feat.topic-routing | in-progress | feat/topic-routing | 2cc9d81a3ea2475a59e60b596c4e542000fb9d20 |
| module.agent-group-contributions | shipped | module/agent-group-contributions | f3e947ff56748dbac5a33cdb1b5a41c812d63cbb |
| module.command-gate | shipped | module/command-gate | 3d5dde16a9ea1c073968db240807ba3bc01e0f9a |
| module.container-bootstrap | shipped | module/container-bootstrap | 703d047e5f708f15910e058a0693fce53f3068b7 |
| module.container-queue | shipped | module/container-queue | 09169ade7b414a8c2927327734e2decda14d2127 |
| module.credentials | shipped | module/credentials | ac0701984c3cb379047ab910686c0b7ea54845e2 |
| module.crypto | shipped | module/crypto | ac901a4603730c9b994334631924269e4093a16f |
| module.egress-lockdown | shipped | module/egress-lockdown | 01b10d1c2059a166894cb834b445c83d35caaf50 |
| module.host-rpc | shipped | module/host-rpc | 1386c873c9b0a69f89b11f24d2ecbdf60b385f74 |
| module.interaction-status | shipped | module/interaction-status | de0427e4aea1d955787ea73244264bc28df78701 |
| module.interactions-helpers | shipped | module/interactions-helpers | 8fc0ca9e3684485be8e3497cc3bfea272b4649bb |
| module.runtime-updater | shipped | module/runtime-updater | 677714a9b0c08bd880ebe43bfb0d3ebef94a372e |
| planned.estate-config | planned | — | — |
| planned.ops-kb | planned | — | — |
