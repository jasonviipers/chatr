/**
 * Lets the browser tests reach into the running app (trigger an ICE restart, drop a call, shorten a
 * timeout). Only present in dev and in the e2e test build, never in a production bundle.
 */
export function exposeForTests(name: string, value: unknown): void {
  if (!import.meta.env.DEV && import.meta.env.MODE !== 'e2e') return;
  const target = window as unknown as { __chatr?: Record<string, unknown> };
  target.__chatr = { ...target.__chatr, [name]: value };
}
