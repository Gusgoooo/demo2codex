import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_FILES = 2_500;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_TARGETS_PER_MAPPING = 4;
const SOURCE_EXTENSIONS = new Set([
  ".astro", ".c", ".cc", ".cpp", ".cs", ".css", ".dart", ".go", ".graphql",
  ".gql", ".h", ".hpp", ".html", ".java", ".js", ".jsx", ".json", ".kt",
  ".kts", ".less", ".md", ".mdx", ".mjs", ".mm", ".php", ".py", ".rb",
  ".rs", ".sass", ".scss", ".svelte", ".swift", ".ts", ".tsx", ".vue", ".xml",
  ".yaml", ".yml",
]);
const IGNORED_SEGMENTS = new Set([
  ".demo2codex", ".git", ".idea", ".next", ".nuxt", ".output", ".turbo",
  ".venv", ".vscode", "build", "coverage", "dist", "generated", "node_modules",
  "out", "target", "vendor",
]);
const IGNORED_FILE_NAMES = new Set([
  "bun.lock", "bun.lockb", "composer.lock", "package-lock.json", "pnpm-lock.yaml",
  "poetry.lock", "yarn.lock",
]);
const COMMON_SOURCE_ROOTS = [
  "app", "apps", "client", "components", "frontend", "lib", "packages", "pages",
  "server", "src", "ui", "web",
];
const LANGUAGE_BY_EXTENSION = {
  ".astro": "Astro",
  ".c": "C",
  ".cc": "C++",
  ".cpp": "C++",
  ".cs": "C#",
  ".css": "CSS",
  ".dart": "Dart",
  ".go": "Go",
  ".html": "HTML",
  ".java": "Java",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".mjs": "JavaScript",
  ".php": "PHP",
  ".py": "Python",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".scss": "SCSS",
  ".svelte": "Svelte",
  ".swift": "Swift",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".vue": "Vue",
};
const FRAMEWORK_DEPENDENCIES = [
  ["next", "Next.js"],
  ["nuxt", "Nuxt"],
  ["react", "React"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["@angular/core", "Angular"],
  ["@remix-run/react", "Remix"],
  ["astro", "Astro"],
  ["vite", "Vite"],
  ["@nestjs/core", "NestJS"],
  ["express", "Express"],
];

export const TASK_GROUNDING_CONTRACT = Object.freeze({
  public_todo_fields: [
    "content",
  ],
  internal_grounding_fields: [
    "meeting_evidence",
    "module_candidates",
    "scope",
    "acceptance_criteria",
    "open_questions",
  ],
  rules: [
    "Cite the transcript event, note, or focus segment that supports each TODO.",
    "Use the module index to identify the most relevant page, feature area, component, and repository paths, then inspect the real code before proposing or applying a change.",
    "Treat module paths as navigation clues rather than exact edit instructions; do not place them inside the user-facing TODO content.",
    "If the relevant module remains ambiguous, mark it unresolved instead of guessing or expanding the scope.",
    "Generate the user-facing review summary and each direct TODO instruction in Chinese.",
  ],
});

export async function captureRepositoryProfile(repoPath) {
  const filePaths = await listRepositoryFiles(repoPath);
  return repositoryProfile(repoPath, filePaths);
}

export async function buildEvidenceCodeContext({
  repoPath,
  repository,
  focusSegments = [],
  transcript = [],
  notes = [],
}) {
  const index = await buildRepositoryIndex(repoPath);
  const profile = repository?.context || await repositoryProfile(repoPath, index.filePaths);
  const focusMappings = focusSegments.map((segment) => mapEvidenceToCode(index, {
    focus_id: segment.focus_id,
    page: segment.page,
    focus: segment.focus,
    transcript: segment.transcript || [],
    transcript_event_ids: segment.transcript_event_ids || [],
  }));
  const focusedEventIds = new Set(
    focusSegments.flatMap((segment) => segment.transcript_event_ids || []),
  );
  const unscopedTranscript = transcript.filter((event) => !focusedEventIds.has(event.id));
  const unscopedEvidence = [
    ...unscopedTranscript.map((event) => ({
      kind: "transcript",
      id: event.id,
      text: event.text,
    })),
    ...notes.map((note) => ({
      kind: "note",
      id: note.id,
      text: note.text,
    })),
  ].filter((item) => item.text?.trim());
  const unscopedMapping = unscopedEvidence.length
    ? mapEvidenceToCode(index, {
      focus_id: null,
      page: null,
      focus: null,
      transcript: unscopedEvidence.map((item) => item.text),
      transcript_event_ids: unscopedEvidence.map((item) => item.id),
      evidence: unscopedEvidence,
    })
    : null;

  return {
    schema_version: 1,
    status: "ready",
    strategy: "deterministic-local-code-index",
    generated_at: new Date().toISOString(),
    repository_profile: {
      ...profile,
      indexed_file_count: index.records.length,
      indexed_bytes: index.indexedBytes,
      index_truncated: index.truncated,
    },
    focus_mappings: focusMappings,
    unscoped_mapping: unscopedMapping,
    grounding_contract: TASK_GROUNDING_CONTRACT,
  };
}

async function buildRepositoryIndex(repoPath) {
  const filePaths = await listRepositoryFiles(repoPath);
  const prioritized = [...filePaths].sort(compareFilePriority).slice(0, MAX_FILES);
  const records = [];
  let indexedBytes = 0;
  let truncated = filePaths.length > prioritized.length;

  for (const relativePath of prioritized) {
    const absolutePath = path.join(repoPath, relativePath);
    const info = await stat(absolutePath).catch(() => null);
    if (!info?.isFile() || info.size > MAX_FILE_BYTES) continue;
    if (indexedBytes + info.size > MAX_INDEX_BYTES) {
      truncated = true;
      break;
    }
    const content = await readFile(absolutePath, "utf8").catch(() => null);
    if (content === null || content.includes("\0")) continue;
    indexedBytes += Buffer.byteLength(content);
    records.push({
      path: normalizeRelativePath(relativePath),
      basename: path.basename(relativePath),
      extension: path.extname(relativePath).toLowerCase(),
      content,
      lowerContent: content.toLowerCase(),
    });
  }

  return {
    repoPath,
    filePaths,
    records,
    indexedBytes,
    truncated,
  };
}

async function repositoryProfile(repoPath, filePaths) {
  const manifestPaths = filePaths.filter((filePath) => [
    "Cargo.toml", "Gemfile", "Package.swift", "go.mod", "package.json", "pom.xml",
    "pyproject.toml", "requirements.txt",
  ].includes(path.basename(filePath))).slice(0, 30);
  const packageManifestPaths = manifestPaths.filter((filePath) => path.basename(filePath) === "package.json");
  const packageManifests = (await Promise.all(
    packageManifestPaths.map(async (filePath) => ({
      path: filePath,
      value: await readJson(path.join(repoPath, filePath)),
    })),
  )).filter((manifest) => manifest.value);
  const dependencies = Object.assign(
    {},
    ...packageManifests.map((manifest) => ({
      ...(manifest.value.dependencies || {}),
      ...(manifest.value.devDependencies || {}),
    })),
  );
  const frameworks = FRAMEWORK_DEPENDENCIES
    .filter(([dependency]) => dependency in dependencies)
    .map(([, framework]) => framework);
  const languageCounts = new Map();
  for (const filePath of filePaths) {
    const language = LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()];
    if (language) languageCounts.set(language, (languageCounts.get(language) || 0) + 1);
  }
  const languages = [...languageCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([name, files]) => ({ name, files }));
  const sourceRoots = uniqueStrings(filePaths.flatMap((filePath) => {
    const segments = filePath.split("/");
    return segments.flatMap((segment, index) => (
      COMMON_SOURCE_ROOTS.includes(segment)
        ? [segments.slice(0, index + 1).join("/")]
        : []
    ));
  })).slice(0, 24);
  const projectRoots = uniqueStrings(manifestPaths.map((filePath) => (
    path.posix.dirname(filePath) === "." ? "." : path.posix.dirname(filePath)
  ))).slice(0, 24);
  const scriptNames = uniqueStrings(packageManifests.flatMap((manifest) => (
    Object.keys(manifest.value.scripts || {})
  ))).slice(0, 30);

  return {
    frameworks,
    languages,
    source_roots: sourceRoots,
    project_roots: projectRoots,
    manifests: manifestPaths,
    package_manager: await detectPackageManager(repoPath),
    script_names: scriptNames,
    candidate_file_count: filePaths.length,
  };
}

function mapEvidenceToCode(index, segment) {
  const signals = buildSignals(index.repoPath, segment);
  const candidates = index.records
    .map((record) => scoreRecord(record, signals))
    .filter((candidate) => candidate.score >= 15)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, MAX_TARGETS_PER_MAPPING);
  const exactSource = candidates.some((candidate) => (
    candidate.reasons.some((reason) => reason.kind === "captured_source")
  ));
  const locationStatus = exactSource
    ? "exact"
    : candidates.length
      ? "candidate"
      : "unresolved";

  return {
    focus_id: segment.focus_id,
    page: compactPage(segment.page),
    element: compactFocus(segment.focus),
    meeting_evidence: segment.evidence || (segment.transcript || []).map((text, index) => ({
      kind: "transcript",
      id: segment.transcript_event_ids?.[index] || null,
      text,
    })),
    location_status: locationStatus,
    module_candidates: candidates,
    ...(candidates.length ? {} : {
      unresolved_reason: signals.length
        ? "No repository module matched the captured source, component, route, selector, or visible text strongly enough."
        : "No page-focus or module-identifying evidence was captured for this discussion.",
    }),
  };
}

function buildSignals(repoPath, segment) {
  const focus = segment.focus || {};
  const signals = [];
  const sourceCandidates = sourcePathCandidates(repoPath, focus.source);
  for (const value of sourceCandidates) {
    signals.push({ kind: "captured_source", value, weight: 100, match: "source" });
  }
  const components = uniqueStrings([
    focus.component,
    ...(Array.isArray(focus.componentStack) ? focus.componentStack : []),
  ]);
  for (const value of components) {
    signals.push({ kind: "component", value, weight: 50, match: "component" });
  }
  const route = focus.route || segment.page?.pathname;
  if (route) {
    signals.push({ kind: "route", value: route, weight: 32, match: "route" });
  }
  for (const value of selectorTerms(focus)) {
    signals.push({ kind: "selector", value, weight: 24, match: "content" });
  }
  for (const value of uniqueStrings([focus.ariaLabel, focus.label, focus.text]).slice(0, 3)) {
    if (meaningfulText(value)) {
      signals.push({ kind: "visible_text", value, weight: 22, match: "content" });
    }
  }
  for (const value of evidenceTerms(segment.transcript || [])) {
    signals.push({ kind: "meeting_term", value, weight: 12, match: "content" });
  }
  return signals;
}

function scoreRecord(record, signals) {
  let score = 0;
  const reasons = [];
  const lowerPath = record.path.toLowerCase();
  const baseWithoutExtension = path.basename(record.path, record.extension).toLowerCase();

  for (const signal of signals) {
    const value = String(signal.value || "").trim();
    if (!value) continue;
    const lowerValue = value.toLowerCase();
    let points = 0;
    let detail;

    if (signal.match === "source") {
      const normalized = normalizeRelativePath(value).toLowerCase();
      if (lowerPath === normalized) {
        points = signal.weight;
        detail = "Browser framework metadata points directly to this file.";
      } else if (lowerPath.endsWith(`/${normalized}`) || normalized.endsWith(`/${lowerPath}`)) {
        points = Math.round(signal.weight * 0.85);
        detail = "The captured source path suffix matches this repository file.";
      } else if (path.basename(lowerPath) === path.basename(normalized)) {
        points = Math.round(signal.weight * 0.5);
        detail = "The captured source filename matches this repository file.";
      }
    } else if (signal.match === "component") {
      const normalizedComponent = lowerValue.replace(/[^a-z0-9_$-]/g, "");
      if (normalizedComponent && baseWithoutExtension.replace(/[^a-z0-9_$-]/g, "") === normalizedComponent) {
        points = signal.weight;
        detail = `Filename matches captured component ${value}.`;
      } else if (normalizedComponent && lowerPath.includes(normalizedComponent)) {
        points = Math.round(signal.weight * 0.65);
        detail = `Path matches captured component ${value}.`;
      } else if (containsIdentifier(record.content, value)) {
        points = Math.round(signal.weight * 0.5);
        detail = `File defines or references captured component ${value}.`;
      }
    } else if (signal.match === "route") {
      const routeTokens = routeTerms(value);
      const pathMatches = routeTokens.filter((token) => lowerPath.split(/[/_.-]+/).includes(token)).length;
      if (pathMatches) {
        points += Math.min(signal.weight, pathMatches * 14);
        detail = `Path matches route ${value}.`;
      }
      if (record.lowerContent.includes(lowerValue)) {
        points += 16;
        detail = `File references route ${value}.`;
      }
    } else if (record.lowerContent.includes(lowerValue)) {
      points = signal.weight;
      detail = signal.kind === "selector"
        ? `File contains selector or stable element identifier ${value}.`
        : signal.kind === "visible_text"
          ? `File contains captured visible text ${truncate(value, 64)}.`
          : `File contains a code-like term from the meeting evidence: ${truncate(value, 64)}.`;
    }

    if (!points) continue;
    score += points;
    reasons.push({
      kind: signal.kind,
      evidence: value,
      detail,
    });
  }

  if (isTestOrStoryPath(record.path)) score -= 12;
  return {
    module: moduleLabel(record.path),
    paths: [record.path],
    confidence: confidenceFor(score, reasons),
    score: Math.max(0, score),
    reasons: dedupeReasons(reasons).slice(0, 6),
  };
}

async function listRepositoryFiles(repoPath) {
  let files;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "-co", "--exclude-standard", "-z"],
      { cwd: repoPath, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
    );
    files = stdout.toString("utf8").split("\0").filter(Boolean);
  } catch {
    files = await walkFiles(repoPath);
  }
  return uniqueStrings(files.map(normalizeRelativePath))
    .filter(isIndexablePath)
    .sort();
}

async function walkFiles(rootPath) {
  const results = [];
  const queue = [""];
  while (queue.length && results.length < MAX_FILES * 2) {
    const relativeDirectory = queue.shift();
    const absoluteDirectory = path.join(rootPath, relativeDirectory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const relativePath = normalizeRelativePath(path.join(relativeDirectory, entry.name));
      if (entry.isDirectory()) {
        if (!IGNORED_SEGMENTS.has(entry.name)) queue.push(relativePath);
      } else if (entry.isFile()) {
        results.push(relativePath);
      }
    }
  }
  return results;
}

function isIndexablePath(filePath) {
  const normalized = normalizeRelativePath(filePath);
  const segments = normalized.split("/");
  const fileName = segments.at(-1);
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return false;
  if (!fileName || IGNORED_FILE_NAMES.has(fileName)) return false;
  if (/^\.env(?:\.|$)/.test(fileName) || /\.(pem|key|p12|pfx)$/i.test(fileName)) return false;
  return SOURCE_EXTENSIONS.has(path.extname(fileName).toLowerCase()) || [
    "Cargo.toml", "Gemfile", "Package.swift", "go.mod", "package.json",
    "pom.xml", "pyproject.toml", "requirements.txt",
  ].includes(fileName);
}

function compareFilePriority(left, right) {
  return filePriority(left) - filePriority(right) || left.localeCompare(right);
}

function filePriority(filePath) {
  const normalized = normalizeRelativePath(filePath);
  let priority = 20;
  if (/^(src|app|pages|components|client|frontend|web|ui)\//.test(normalized)) priority -= 12;
  if (/^(apps|packages)\//.test(normalized)) priority -= 8;
  if (isTestOrStoryPath(normalized)) priority += 10;
  if (/\.(json|md|yaml|yml)$/i.test(normalized)) priority += 5;
  return priority;
}

function sourcePathCandidates(repoPath, source) {
  if (!source) return [];
  let cleaned = String(source)
    .replace(/^file:\/\//, "")
    .replace(/^(webpack|vite):\/\/+/, "")
    .replace(/[?#].*$/, "")
    .replace(/:\d+(?::\d+)?$/, "");
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    // Keep the original source when it is not URL encoded.
  }
  const candidates = [];
  if (path.isAbsolute(cleaned)) {
    const relative = path.relative(repoPath, cleaned);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      candidates.push(relative);
    }
  }
  candidates.push(cleaned.replace(/^\.?\//, "").replace(/^\/+/, ""));
  for (const root of COMMON_SOURCE_ROOTS) {
    const marker = `/${root}/`;
    const index = cleaned.lastIndexOf(marker);
    if (index >= 0) candidates.push(cleaned.slice(index + 1));
  }
  return uniqueStrings(candidates.map(normalizeRelativePath).filter(Boolean));
}

function selectorTerms(focus) {
  const terms = [
    focus.componentId,
    focus.id,
    ...(Array.isArray(focus.classes) ? focus.classes : []),
  ];
  const selector = String(focus.selector || "");
  terms.push(...selector.match(/[a-zA-Z_][a-zA-Z0-9_-]{2,}/g) || []);
  return uniqueStrings(terms).filter((term) => term.length >= 3).slice(0, 8);
}

function evidenceTerms(texts) {
  const terms = [];
  for (const input of texts) {
    const text = String(input || "");
    terms.push(...text.match(/[`"'“”‘’]([^`"'“”‘’]{2,64})[`"'“”‘’]/g)?.map((value) => (
      value.replace(/^[`"'“”‘’]|[`"'“”‘’]$/g, "")
    )) || []);
    terms.push(...text.match(/\b[A-Za-z_$][A-Za-z0-9_$-]{2,}\b/g) || []);
    terms.push(...text.match(/\/[A-Za-z0-9_./:[\]-]{2,}/g) || []);
  }
  return uniqueStrings(terms).filter(meaningfulText).slice(0, 12);
}

function routeTerms(route) {
  return uniqueStrings(
    String(route)
      .toLowerCase()
      .split(/[/?#.[\]():_-]+/)
      .filter((term) => term.length >= 2 && !["http", "https", "localhost"].includes(term)),
  );
}

function compactPage(page) {
  if (!page) return null;
  return {
    pathname: page.pathname || null,
    title: page.title || null,
    href: page.href || null,
  };
}

function compactFocus(focus) {
  if (!focus) return null;
  return {
    label: focus.label || null,
    selector: focus.selector || null,
    component: focus.component || null,
    component_stack: focus.componentStack || [],
    captured_source: focus.source || null,
    route: focus.route || null,
  };
}

function confidenceFor(score, reasons) {
  if (reasons.some((reason) => reason.kind === "captured_source") || score >= 80) return "high";
  if (score >= 40) return "medium";
  return "low";
}

function moduleLabel(filePath) {
  const segments = normalizeRelativePath(filePath).split("/");
  const fileName = segments.pop() || filePath;
  const base = path.basename(fileName, path.extname(fileName));
  const parent = segments.at(-1);
  return parent && !COMMON_SOURCE_ROOTS.includes(parent)
    ? `${parent}/${base}`
    : base;
}

function containsIdentifier(content, identifier) {
  const escaped = String(identifier).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`, "i").test(content);
}

function isTestOrStoryPath(filePath) {
  return /(^|\/)(__tests__|test|tests|stories)(\/|$)|\.(spec|test|stories)\.[^.]+$/i.test(filePath);
}

function meaningfulText(value) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length >= 3 && normalized.length <= 180;
}

function normalizeRelativePath(value) {
  return String(value || "").split(path.sep).join("/").replace(/^\.\//, "");
}

async function detectPackageManager(repoPath) {
  const candidates = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ];
  for (const [fileName, manager] of candidates) {
    if (await stat(path.join(repoPath, fileName)).then((info) => info.isFile()).catch(() => false)) {
      return manager;
    }
  }
  return null;
}

function dedupeReasons(reasons) {
  const seen = new Set();
  return reasons.filter((reason) => {
    const key = `${reason.kind}:${reason.evidence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    if (value === undefined || value === null) continue;
    const normalized = String(value).trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function truncate(value, length) {
  const text = String(value);
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}
