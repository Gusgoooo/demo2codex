# Demo2Codex

Demo2Codex is a local-first Codex plugin for turning demo conversations into concise Chinese TODOs.

## Product flow

1. Record the discussion.
2. Keep the read-only transcript collapsed unless it is needed.
3. Review and edit the Chinese summary and TODOs.

Each TODO contains one direct modification instruction. The TODO text never includes code paths, line numbers, excerpts, evidence metadata, or implementation commentary. When available, a location icon shows an approximate module and repository path on hover.

## Code grounding

The plugin combines:

- repository structure and framework metadata;
- the route, selected page element, component stack, and development source metadata;
- the transcript segment captured while that area was selected.

A bounded local index returns candidate module names and paths with confidence and match reasons. These are navigation clues for the user's active Codex model, not exact edit locations. The model must inspect the real code before acting.

Hidden grounding for each generated TODO contains:

- `meeting_evidence`
- `module_candidates`
- `scope`
- `acceptance_criteria`
- `open_questions`

The recorder result API exposes only the Chinese summary, TODO content, and a compact `module_hint` derived from those candidates. User edits cannot overwrite the hidden grounding or module hint.

## Model-visible actions

- `start_review`
- `review_status`
- `finish_review`
- `save_review_result`

Equivalent standard MCP resources are available for start, status, and finish when custom tools are deferred.

When `save_review_result` is deferred, `finish_review` returns a token-scoped local `result_submission` URL. Codex can POST the same JSON payload to that URL, so a missing custom-tool surface never requires fallback session scripts or reinstalling the plugin.

## Privacy and cost

- Recording, session data, transcript, repository index, and artifacts remain local.
- Secret-like files, dependencies, generated output, and build output are excluded from indexing.
- The plugin makes no LLM API call and contains no publisher-owned model credential.
- Model usage follows the account and model selected by the user in Codex.
- Browser speech recognition may use the browser vendor's online speech service.

## Development

```bash
npm test
npm run check
```

The recorder is static HTML, CSS, and JavaScript. Its interface follows shadcn/ui `new-york` tokens and component states without adding a frontend runtime dependency.

## Migrating from Meeting2Prompt

Do not keep both products installed:

```bash
codex plugin remove meeting2prompt@personal
codex plugin remove meeting2prompt@meeting2prompt
codex plugin marketplace add Gusgoooo/demo2codex
codex plugin add demo2codex@demo2codex
```

Demo2Codex contains no Skill. Existing `.meeting2prompt/` sessions are loaded for compatibility; new sessions use `.demo2codex/`.
