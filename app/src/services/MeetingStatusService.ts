import { apiBaseUrl } from '../config';

/**
 * Asks the API whether a meeting is locked, before a call is placed into it. Anything that goes wrong (the API is
 * slow or down) answers "no": a join that can go ahead is never stopped by this check, and the server keeps
 * strangers out of a locked meeting anyway.
 */
export default class MeetingStatusService {
  static async isLocked(meetingId: string): Promise<boolean> {
    try {
      const response = await fetch(`${apiBaseUrl}/meetings/${encodeURIComponent(meetingId)}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(4_000),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { locked?: unknown };
      return body.locked === true;
    } catch {
      return false;
    }
  }
}

export const LOCKED_NOTICE = 'This meeting is locked: the host is not letting anybody new in.';
