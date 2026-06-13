/**
 * Interactions helpers — convenience layer that composes A1a
 * (`beginInteraction`) and the approvals primitive into a small,
 * domain-agnostic vocabulary: paste / pick / confirm.
 *
 * Dormant: not imported by `src/modules/index.ts`. Consumers import
 * the helpers directly.
 */
export { pastePlain, type PastePlainOptions, type PasteResult } from './paste-plain.js';
export { pastePgp, type PastePgpOptions, type PastePgpResult } from './paste-pgp.js';
export { pickFromButtons, type PickFromButtonsOptions, type PickOption, type PickResult } from './pick-from-buttons.js';
export { confirmAction, type ConfirmActionOptions, type ConfirmResult } from './confirm-action.js';
