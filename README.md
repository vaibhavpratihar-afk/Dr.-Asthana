# Auto Dev Agent

Autonomous JIRA-to-PR agent with a council-first workflow.

## Core Model

The system splits work into two phases:

1. Council phase (expensive models): produce an execution plan.
2. Execution phase (cheap model): apply the plan with minimal interpretation.

The council is now **artifact-first**:
- Reasoning is exchanged via `.md` files.
- Deterministic control signals are exchanged via `.json` files.
- No semantic in-memory handoff between council members.

## Council Protocol (Current)

Each round follows:
1. Proposer writes `rounds/round-N/proposer.md`
2. Critics write `rounds/round-N/critic-*.md`
3. Agreement writes `rounds/round-N/agreement.md` and `rounds/round-N/control.json`
4. Evaluator writes `rounds/round-N/evaluation.md` and updates `control.json`

Shared files (cross-round state):
- `context/ticket-context.md`
- `context/roles.md`
- `shared/scope-lock.md`
- `shared/blockers.md`
- `shared/decisions.md`
- `shared/evaluator-feedback.md`
- `shared/protocol.md`

Only JSON is used for deterministic control (e.g. `nextAction`, agreement decision, evaluation verdict).

## Project Structure

```text
src/
  ai-provider/      # AI CLI adapters, runtime, strategies
  agent/            # cheap executor
  council/          # council engine (artifact protocol)
    config/
    contract/
    evaluator/
    orchestrator/
    runtime/
    stages/
  jira/             # ticket read/write helpers
  notification/     # JIRA + Slack reporting
  pipeline/         # end-to-end step orchestration + checkpoints
  prompt/           # prompt/context builders
  service/          # git + Azure DevOps PR helpers
  utils/            # config, logger, misc helpers
```

## Runtime Flow

1. Fetch + validate ticket.
2. Clone target repo + branch setup.
3. Build cheatsheet via council.
4. Execute cheatsheet.
5. Validate output.
6. Create/update PR.
7. Notify JIRA + Slack.

## Configuration

Main config lives in `config.json`.
See `config.example.json` for full schema.

Important sections:
- `jira`
- `azureDevOps`
- `services`
- `agent`
- `aiProvider`
- `council`
- `prReviewCouncil`

## Commands

```bash
pnpm start                    # daemon mode
pnpm run single -- JCP-123    # process one ticket
pnpm run dry-run              # inspect only, no changes
pnpm run resume -- JCP-123 --from-step=5
```

## Artifacts

All per-ticket artifacts live under:
- `.pipeline-state/<TICKET_KEY>/`

Council workspace lives under:
- `.pipeline-state/<TICKET_KEY>/council/`

Logs live under:
- `logs/YYYY-MM-DD/*.log`

## Design Principles

- Deterministic control flow.
- File-backed auditability.
- Minimal hidden state.
- Fail closed when plan quality is insufficient.
