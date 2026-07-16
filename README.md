# Demo2Codex

Demo2Codex turns a demo conversation into focused Chinese TODOs grounded in the current repository.

The model does not guess where to start. A local deterministic index gives the user's active Codex model approximate page, feature, component, and repository-path clues. It does not provide line numbers, code excerpts, or exact edit instructions.

The user flow has three stages:

1. Start recording.
2. View the read-only transcript when needed; it is collapsed by default.
3. Edit the Chinese meeting summary and TODOs.

Each TODO is one short instruction, similar to a prompt the user would write directly to Codex. Code information stays out of the TODO text. A small location icon reveals the approximate module on hover.

Demo2Codex has no hosted LLM, publisher model key, or bundled Skill. Interpretation and code inspection use the model and account already selected by the user in Codex.

## Install

```bash
codex plugin marketplace add Gusgoooo/demo2codex
codex plugin add demo2codex@demo2codex
```

Open the repository in Codex and ask:

```text
@Demo2Codex Use start_review or read demo2codex://start-review. If unavailable, stop. Do not audit, build, run, or edit the repository.
```

The recorder actions are exposed as both MCP tools and standard MCP resources, so the workflow can still start when custom tools are deferred.

## Grounding rules

Demo2Codex keeps the model focused with five constraints:

1. Only create TODOs supported by captured discussion.
2. Add only details needed to implement and verify the stated change.
3. Do not expand beyond the mentioned page, element, or behavior.
4. Keep material ambiguity as an open question.
5. Use the module index to inspect the real code, then write a short Chinese TODO without code details.

## Repository layout

```text
.agents/plugins/marketplace.json
plugins/demo2codex/
  .codex-plugin/plugin.json
  .mcp.json
  mcp/
  web/
  tests/
```

## Migrating from Meeting2Prompt

Remove the old plugin before installing Demo2Codex:

```bash
codex plugin remove meeting2prompt@personal
codex plugin remove meeting2prompt@meeting2prompt
codex plugin marketplace add Gusgoooo/demo2codex
codex plugin add demo2codex@demo2codex
```

Existing sessions under `.meeting2prompt/` remain readable. New sessions are stored under `.demo2codex/`.
