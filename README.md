# Meeting2Prompt Codex Plugin

Meeting2Prompt captures local demo-review conversations and page-focus evidence, then lets the user's own Codex model inspect the repository and translate only the discussed changes into implementation tasks.

It is intentionally thin:

- no hosted LLM;
- no plugin-owned model key;
- no server-side requirement generation;
- no bundled Skill;
- five narrow constraints that keep the model grounded in what the user actually said.

## Install from the Codex marketplace

```bash
codex plugin marketplace add Gusgoooo/meeting2prompt
codex plugin add meeting2prompt@meeting2prompt
```

Start a new Codex task after installation, open the repository you want to review, and ask:

```text
Start a demo review for this repository.
```

See [the plugin README](./plugins/meeting2prompt/README.md) for usage, privacy, and development details.

## Repository layout

```text
.agents/plugins/marketplace.json
plugins/meeting2prompt/
  .codex-plugin/plugin.json
  .mcp.json
  mcp/
  web/
  tests/
```

## How task generation stays focused

When a review finishes, Meeting2Prompt returns raw transcript, notes, page-focus segments, repository context, and these constraints:

1. Every task needs meeting evidence.
2. Only implementation- and verification-critical details may be added.
3. Scope stays on the mentioned page, element, and behavior.
4. Material ambiguity becomes an open question.
5. Codex must inspect the real repository and avoid unrelated changes.

The active Codex model performs all semantic interpretation and code analysis.
