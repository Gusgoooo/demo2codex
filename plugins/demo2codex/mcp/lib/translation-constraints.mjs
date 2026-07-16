export const TRANSLATION_CONSTRAINTS = Object.freeze([
  "Only create tasks that are supported by the transcript, a user note, or captured page-focus evidence.",
  "Add only details that are necessary to implement and verify the user's stated change; do not introduce new features or design directions.",
  "Keep the scope limited to the page, element, and behavior the user mentioned; do not expand the change to adjacent pages, similar components, or global systems.",
  "When an ambiguity could materially change product behavior or implementation scope, record it as an open question instead of choosing for the user.",
  "Use the repository module index to identify the relevant page, feature area, component, and paths; inspect the actual code before acting, preserve existing conventions, avoid unrelated changes, and write each TODO as one short, direct Chinese instruction without code paths or implementation details.",
]);
