# Demo2Codex

Demo2Codex is a local-first Codex plugin for reviewing a running product demo. It records the conversation, associates transcript intervals with selected page elements, and returns a raw evidence package to the user's active Codex model.

The plugin does not call an LLM API. Requirement interpretation, repository inspection, task generation, and any code changes are performed by the model and account already active in Codex.

## Model-visible actions

- `start_review` starts a local review, returns the recorder URL, and installs the optional page-focus bridge.
- `review_status` reports recording state, the current page focus, and saved files.
- `finish_review` returns transcript, notes, focus segments, repository and Git context, audio location, and five narrow translation constraints.
- `save_review_result` stores the summary and tasks produced by Codex without changing their meaning.

Codex can defer custom MCP tools in some tasks. Demo2Codex therefore also exposes `demo2codex://start-review`, `demo2codex://review-status`, and `demo2codex://finish-review` as standard MCP resources. These resources invoke the same local implementation and prevent a missing custom-tool surface from turning into a reinstall loop.

The constraints tell Codex to:

1. Create tasks only from captured evidence.
2. Add only details necessary for implementation and verification.
3. Keep changes limited to the mentioned page, element, and behavior.
4. Preserve material ambiguity as an open question.
5. Inspect the repository, preserve existing conventions, and avoid unrelated changes.

## Requirements

- Codex with local plugin support
- Node.js 20 or newer
- A browser with microphone access
- A writable HTML entry file when page-focus capture is desired

## Use

Open the demo repository in Codex, type `@Demo2Codex` so the composer inserts the plugin mention, and ask:

```text
@Demo2Codex Start a demo review for this repository.
```

Open the returned recorder URL, grant microphone permission, and start recording. If the page-focus bridge was installed, refresh the local demo and use the Demo2Codex toolbar to select the element being discussed.

At the end, ask:

```text
Finish the review and turn only the discussed changes into tasks.
```

Codex receives the evidence and constraints, inspects the actual repository, and prepares the focused TODOs. It can then call `save_review_result` to keep the summary, transcript, evidence, and structured tasks under `.demo2codex/reviews/`.

## Privacy and cost

- The recorder, session store, audio, and artifacts run locally.
- Demo2Codex does not contain an OpenAI API key and does not make model API calls.
- Model usage follows the account and model selected by the user in Codex.
- Browser speech recognition may use the browser vendor's online speech service.
- The demo bridge can submit page-focus events only; it cannot read transcripts, upload audio, or finish a review.

## Development

```bash
npm test
npm run check
```

The MCP server uses stdio. The recorder UI is plain HTML, CSS, and JavaScript and requires no frontend build.

## Migrating from Meeting2Prompt

Do not keep the old and new plugin installed together. Remove the old plugin and marketplace, install Demo2Codex, and start a new Codex task:

```bash
codex plugin remove meeting2prompt@personal
codex plugin remove meeting2prompt@meeting2prompt
codex plugin marketplace add Gusgoooo/demo2codex
codex plugin add demo2codex@demo2codex
```

Remove whichever old selector exists; a “not installed” error for the other selector is harmless. Run `codex plugin list` and confirm that only `demo2codex@demo2codex` remains for this product.

Demo2Codex contains no Skill and does not depend on a separately loaded workflow. Its recorder actions are exposed directly by the plugin MCP server as both tools and standard resources. If Codex defers the custom tools, it must read `demo2codex://start-review` before reporting that the recorder is unavailable; a missing custom tool alone is not a reason to reinstall. Existing sessions recorded under `.meeting2prompt/` are loaded for compatibility; new sessions use `.demo2codex/`.
