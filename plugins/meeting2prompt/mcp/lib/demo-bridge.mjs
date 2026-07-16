import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { atomicWriteFile, pathExists, safeRelative } from "./utils.mjs";

const START_MARKER = "<!-- meeting2prompt:bridge:start -->";
const END_MARKER = "<!-- meeting2prompt:bridge:end -->";

function javascriptString(value) {
  return JSON.stringify(String(value))
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export async function installDemoBridge({ repoPath, serverUrl, indexFile }) {
  const resolvedRepoPath = path.resolve(repoPath);
  const canonicalRepoPath = await realpath(resolvedRepoPath).catch(() => {
    throw new Error(`Repository path does not exist: ${resolvedRepoPath}`);
  });
  const explicitIndexPath = indexFile ? path.resolve(canonicalRepoPath, indexFile) : null;
  if (explicitIndexPath) safeRelative(canonicalRepoPath, explicitIndexPath);
  const candidates = indexFile
    ? [explicitIndexPath]
    : [path.join(canonicalRepoPath, "index.html"), path.join(canonicalRepoPath, "public", "index.html")];
  const candidatePath = await firstExisting(candidates);
  const targetPath = candidatePath ? await realpath(candidatePath) : null;
  if (targetPath) safeRelative(canonicalRepoPath, targetPath);
  const normalizedServerUrl = String(serverUrl).replace(/\/+$/, "");
  const scriptUrl = /\/embed\.js(?:[?#]|$)/.test(normalizedServerUrl)
    ? normalizedServerUrl
    : `${normalizedServerUrl}/embed.js`;
  const snippet = `${START_MARKER}
<script type="module" data-meeting2prompt-bridge>
  const meeting2promptLocalHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);
  if (meeting2promptLocalHosts.has(window.location.hostname) || window.location.hostname.endsWith(".localhost")) {
    import(${javascriptString(scriptUrl)}).catch(() => {});
  }
</script>
${END_MARKER}`;

  if (!targetPath) {
    const snippetPath = path.join(canonicalRepoPath, ".meeting2prompt", "bridge-snippet.html");
    await atomicWriteFile(snippetPath, `${snippet}\n`, { encoding: "utf8" });
    return {
      installed: false,
      strategy: "manual",
      snippet_file: snippetPath,
      server_url: serverUrl,
      instructions: "This stack has no root index.html. Add the generated script tag to the app's root layout before </body>.",
    };
  }

  const original = await readFile(targetPath, "utf8");
  const markerPattern = new RegExp(`${START_MARKER}[\\s\\S]*?${END_MARKER}`, "g");
  let next;
  let alreadyInstalled = false;
  if (markerPattern.test(original)) {
    next = original.replace(markerPattern, snippet);
    alreadyInstalled = next === original;
  } else if (/<\/body\s*>/i.test(original)) {
    next = original.replace(/<\/body\s*>/i, `  ${snippet}\n</body>`);
  } else {
    next = `${original.trimEnd()}\n${snippet}\n`;
  }
  if (next !== original) await atomicWriteFile(targetPath, next, { encoding: "utf8" });

  return {
    installed: true,
    changed: next !== original,
    already_installed: alreadyInstalled,
    strategy: "html-script",
    index_file: targetPath,
    server_url: serverUrl,
  };
}

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}
