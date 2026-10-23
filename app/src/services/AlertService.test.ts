import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import store from '../store';
import AlertService from './AlertService';

describe('AlertService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    AlertService.pull();
    vi.useRealTimers();
  });

  it('shows a message and clears it by itself after 5 seconds', () => {
    AlertService.push('Hello');
    expect(store.getState().alert.message).toBe('Hello');

    vi.advanceTimersByTime(5000);
    expect(store.getState().alert.message).toBe('');
  });

  it('keeps a confirmation open until it is pulled', () => {
    const proceed = vi.fn();
    AlertService.push('Are you sure?', proceed);

    vi.advanceTimersByTime(10000);
    expect(store.getState().alert.message).toBe('Are you sure?');
    expect(store.getState().alert.handleProceed).toBe(proceed);

    AlertService.pull();
    expect(store.getState().alert.message).toBe('');
    expect(store.getState().alert.handleProceed).toBeNull();
  });
});
