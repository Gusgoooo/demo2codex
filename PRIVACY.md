# Privacy

Demo2Codex is a local-first Codex plugin.

- The MCP server, recorder UI, session metadata, audio, transcript, and generated artifacts are stored on the user's machine.
- The plugin does not call an LLM API and does not include a publisher-owned model credential.
- When Codex interprets review evidence, model processing follows the user's active Codex account, workspace, model, and data controls.
- Browser speech recognition may be processed by the browser vendor. Users can disable it without affecting audio recording.
- The page-focus bridge sends only selected element metadata and page location to the local Demo2Codex service.
- The local code index excludes dependency, build, generated, environment, and secret-key files. It returns approximate module names, paths, confidence, and match reasons to the user's active Codex task, without line numbers or code excerpts.
- Meeting data is not transmitted to the plugin publisher.

Questions and security reports can be filed through the repository's GitHub issues.
