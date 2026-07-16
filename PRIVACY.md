# Privacy

Meeting2Prompt is a local-first Codex plugin.

- The MCP server, recorder UI, session metadata, audio, transcript, and generated artifacts are stored on the user's machine.
- The plugin does not call an LLM API and does not include a publisher-owned model credential.
- When Codex interprets review evidence, model processing follows the user's active Codex account, workspace, model, and data controls.
- Browser speech recognition may be processed by the browser vendor. Users can disable it and enter notes manually.
- The page-focus bridge sends only selected element metadata and page location to the local Meeting2Prompt service.
- Meeting data is not transmitted to the plugin publisher.

Questions and security reports can be filed through the repository's GitHub issues.
