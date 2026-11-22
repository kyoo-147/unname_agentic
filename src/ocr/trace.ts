/**
 * Truthful local OCR execution trace and abstention contracts.
 *
 * A trace records what the runtime actually attempted, not an inferred quality
 * score. Abstention is explicit when there is no usable geometry, no local
 * engine result, or a bounded operation cannot be justified from evidence.
 */

export type OcrTraceStage = 'route' | 'plan' | 'recognize' | 'ground' | 'abstain';
export type OcrTraceStatus = 'started' | 'completed' | 'skipped' | 'failed' | 'aborted' | 'abstained';

export interface OcrTraceEvent {
  sequence: number;
  stage: OcrTraceStage;
  status: OcrTraceStatus;
  message: string;
  engine?: string;
  regionId?: string;
  observed: boolean;
}

export type OcrAbstentionCode =
  | 'no-uncertain-regions'
  | 'no-region-geometry'
  | 'empty-recognition'
  | 'offline-engine-unavailable'
  | 'budget-exhausted';

export interface OcrAbstention {
  code: OcrAbstentionCode;
  message: string;
  /** The concrete observation that prevented a claim, never a guessed result. */
  observed: string;
}

export function traceEvent(
  events: readonly OcrTraceEvent[],
  event: Omit<OcrTraceEvent, 'sequence'>,
): OcrTraceEvent[] {
  return [...events, { ...event, sequence: events.length + 1 }];
}

export function abstentionEvent(
  events: readonly OcrTraceEvent[],
  abstention: OcrAbstention,
): OcrTraceEvent[] {
  return traceEvent(events, {
    stage: 'abstain',
    status: 'abstained',
    message: abstention.message,
    observed: true,
  });
}
