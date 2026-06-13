/**
 * Event category — controls consumer behavior and message formatting.
 * Open by design: extended in place as features add new kinds.
 */
export type InteractionEventKind = 'notification' | 'oauth-start' | 'oauth-refresh' | 'device-code';

export type InteractionState = 'queued' | 'active' | 'completed' | 'failed' | 'removed';

export interface InteractionEvent {
  state: InteractionState;
  eventType: InteractionEventKind;
  explanation: string;
  timestamp: number;
}
