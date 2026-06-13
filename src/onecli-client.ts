/**
 * The single shared OneCLI client for the whole host. There is exactly one
 * OneCLI connection (same `ONECLI_URL` / `ONECLI_API_KEY`); both consumers — the
 * credential broker (`providers/onecli-broker.ts`) and the approval bridge
 * (`modules/approvals/onecli-approvals.ts`) — use this accessor rather than each
 * constructing their own. Lazily built so importing this module stays
 * side-effect-free (and so tests can run without an OneCLI connection).
 */
import { OneCLI } from '@onecli-sh/sdk';

import { ONECLI_API_KEY, ONECLI_URL } from './config.js';

let instance: OneCLI | undefined;

export function getOneCli(): OneCLI {
  if (!instance) {
    instance = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });
  }
  return instance;
}
