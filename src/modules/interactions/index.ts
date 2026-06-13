/**
 * Interactions helpers — convenience layer that composes A1a
 * (`beginInteraction`) and the approvals primitive into a small,
 * domain-agnostic vocabulary: paste / pick / confirm.
 *
 * Dormant: not imported by `src/modules/index.ts`. Consumers import
 * the helpers directly.
 */
export {
  pastePlain,
  pastePlainOn,
  type PastePlainOptions,
  type PastePlainOnOptions,
  type PasteResult,
} from './paste-plain.js';
export {
  pastePgp,
  pastePgpOn,
  type PastePgpOptions,
  type PastePgpOnOptions,
  type PastePgpResult,
} from './paste-pgp.js';
export { pickFromButtons, type PickFromButtonsOptions, type PickOption, type PickResult } from './pick-from-buttons.js';
export { pickOptionOn, type PickOptionOnOptions, type PickOptionResult } from './pick-option.js';
export { confirmAction, type ConfirmActionOptions, type ConfirmResult } from './confirm-action.js';
