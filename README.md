# Demo2Codex

Demo2Codex captures local demo-review conversations and page-focus evidence, then lets the user's own Codex model inspect the repository and translate only the discussed changes into implementation tasks.

It is intentionally thin:

- no hosted LLM;
- no plugin-owned model key;
- no server-side requirement generation;
- no bundled Skill;
- five narrow constraints that keep the model grounded in what the user actually said.

## Install from the Codex marketplace

```bash
codex plugin marketplace add Gusgoooo/demo2codex
codex plugin add demo2codex@demo2codex
```

Start a new Codex task after installation, open the repository you want to review, type `@Demo2Codex` so Codex inserts the plugin mention, and ask:

```text
@Demo2Codex Start a demo review for this repository.
```

Demo2Codex exposes the recorder workflow through both custom MCP tools and standard MCP resources. If Codex defers the custom tools, it can still start the review through `demo2codex://start-review`; missing custom tools alone must not trigger a reinstall error.

See [the plugin README](./plugins/demo2codex/README.md) for usage, privacy, migration, and development details.

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

## How task generation stays focused

When a review finishes, Demo2Codex returns raw transcript, notes, page-focus segments, repository context, and these constraints:

1. Every task needs meeting evidence.
2. Only implementation- and verification-critical details may be added.
3. Scope stays on the mentioned page, element, and behavior.
4. Material ambiguity becomes an open question.
5. Codex must inspect the real repository and avoid unrelated changes.

The active Codex model performs all semantic interpretation and code analysis.

## Migrating from Meeting2Prompt

The product and plugin ID changed in v0.3.0. Remove the old installation before installing Demo2Codex so a stale Meeting2Prompt skill cannot intercept the request:

```bash
codex plugin remove meeting2prompt@personal
codex plugin remove meeting2prompt@meeting2prompt
codex plugin marketplace add Gusgoooo/demo2codex
codex plugin add demo2codex@demo2codex
```

Remove whichever old selector exists; a “not installed” error for the other selector is harmless. Then run `codex plugin list` and confirm that only `demo2codex@demo2codex` remains for this product before starting a new Codex task.

Existing review sessions under `.meeting2prompt/` remain readable; new sessions are stored under `.demo2codex/`.
