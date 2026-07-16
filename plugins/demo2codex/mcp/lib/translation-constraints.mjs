export const TRANSLATION_CONSTRAINTS = Object.freeze([
  "Only create tasks that are supported by the transcript, a user note, or captured page-focus evidence.",
  "Add only details that are necessary to implement and verify the user's stated change; do not introduce new features or design directions.",
  "Keep the scope limited to the page, element, and behavior the user mentioned; do not expand the change to adjacent pages, similar components, or global systems.",
  "When an ambiguity could materially change product behavior or implementation scope, record it as an open question instead of choosing for the user.",
  "Inspect the actual repository before naming files or implementation details, preserve the existing stack and conventions, and avoid unrelated changes.",
]);
