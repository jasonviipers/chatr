import { describe, expect, it } from 'vitest';
import { forwardedFor } from '../src/lib/http.ts';

describe('forwardedFor', () => {
  it('takes the address the trusted proxy appended, not what the client claimed', () => {
    // the client sent "X-Forwarded-For: 6.6.6.6"; nginx appended the address it really saw
    expect(forwardedFor('6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
    expect(forwardedFor('203.0.113.9')).toBe('203.0.113.9');
  });

  it('copes with repeated headers and whitespace', () => {
    expect(forwardedFor([' 6.6.6.6 ', '203.0.113.9 '])).toBe('203.0.113.9');
  });

  it('returns nothing when there is no usable value', () => {
    expect(forwardedFor(undefined)).toBeUndefined();
    expect(forwardedFor('')).toBeUndefined();
    expect(forwardedFor('1.1.1.1,  ')).toBeUndefined();
  });
});
