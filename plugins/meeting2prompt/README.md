# Meeting2Prompt

Meeting2Prompt is a local-first Codex plugin for reviewing a running product demo. It records the conversation, associates transcript intervals with selected page elements, and returns a raw evidence package to the user's active Codex model.

The plugin does not call an LLM API. Requirement interpretation, repository inspection, task generation, and any code changes are performed by the model and account already active in Codex.

## Model-visible tools

- `start_review` starts a local review, returns the recorder URL, and installs the optional page-focus bridge.
- `review_status` reports recording state, the current page focus, and saved files.
- `finish_review` returns transcript, notes, focus segments, repository and Git context, audio location, and five narrow translation constraints.
- `save_review_result` stores the summary and tasks produced by Codex without changing their meaning.

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

Open the demo repository in Codex and ask:

```text
Start a demo review for this repository.
```

Open the returned recorder URL, grant microphone permission, and start recording. If the page-focus bridge was installed, refresh the local demo and use the Meeting2Prompt toolbar to select the element being discussed.

At the end, ask:

```text
Finish the review and turn only the discussed changes into tasks.
```

Codex receives the evidence and constraints, inspects the actual repository, and prepares the focused TODOs. It can then call `save_review_result` to keep the summary, transcript, evidence, and structured tasks under `.meeting2prompt/reviews/`.

## Privacy and cost

- The recorder, session store, audio, and artifacts run locally.
- Meeting2Prompt does not contain an OpenAI API key and does not make model API calls.
- Model usage follows the account and model selected by the user in Codex.
- Browser speech recognition may use the browser vendor's online speech service.
- The demo bridge can submit page-focus events only; it cannot read transcripts, upload audio, or finish a review.

## Development

```bash
npm test
npm run check
```

The MCP server uses stdio. The recorder UI is plain HTML, CSS, and JavaScript and requires no frontend build.
