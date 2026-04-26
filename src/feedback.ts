/**
 * Syrin SDK — Session feedback primitives.
 *
 * Provides per-session positive/negative rating plus a convenience
 * `onCompletion` helper that auto-rates based on a success predicate.
 */

import { AlreadyRatedError, SessionNotFoundError, ValidationError } from '@/errors.js';
import type { SyrinConfig } from '@/types.js';

export type FeedbackRating = 'positive' | 'negative';

export interface FeedbackOptions {
  reason?: string;
  /** Identifier of the human or system that cast this vote. */
  voterId?: string;
}

const VALID_RATINGS: ReadonlySet<string> = new Set(['positive', 'negative']);

/**
 * Send a feedback rating for a session to the Syrin backend.
 *
 * @internal — used by SessionFeedback and the `sessions` namespace.
 */
export async function sendFeedback(
  config: SyrinConfig,
  sessionId: string,
  rating: FeedbackRating,
  options?: FeedbackOptions,
): Promise<void> {
  if (!VALID_RATINGS.has(rating)) {
    throw new ValidationError(`Invalid rating value: "${String(rating)}". Must be "positive" or "negative".`);
  }

  const body: Record<string, unknown> = { rating };
  if (options?.reason !== undefined) {
    body['reason'] = options.reason;
  }
  if (options?.voterId !== undefined) {
    body['voter_id'] = options.voterId;
  }

  const response = await fetch(
    `${config.backendUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/feedback`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    },
  );

  if (response.ok) return;

  switch (response.status) {
    case 409:
      throw new AlreadyRatedError(sessionId);
    case 404:
      throw new SessionNotFoundError(sessionId);
    case 422:
      throw new ValidationError(`Invalid feedback payload for session ${sessionId}`);
    default:
      throw new Error(`Feedback request failed with HTTP ${response.status}`);
  }
}

/**
 * Fluent feedback handle attached to a session handle returned by
 * `sdk.sessions.start()`.
 */
export class SessionFeedback {
  constructor(
    private readonly sessionId: string,
    private readonly config: SyrinConfig,
  ) {}

  /** Record a positive rating for this session. */
  async positive(options?: FeedbackOptions): Promise<void> {
    await sendFeedback(this.config, this.sessionId, 'positive', options);
  }

  /** Record a negative rating for this session. */
  async negative(options?: FeedbackOptions): Promise<void> {
    await sendFeedback(this.config, this.sessionId, 'negative', options);
  }

  /**
   * Auto-rate the session based on `successFn`.
   * Calls `positive()` when `successFn(result)` returns `true`, otherwise `negative()`.
   */
  async onCompletion<T>(result: T, successFn: (result: T) => boolean): Promise<void> {
    const success = successFn(result);
    if (success) {
      await this.positive();
    } else {
      await this.negative();
    }
  }
}
