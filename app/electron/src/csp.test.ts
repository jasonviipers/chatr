// Run with: bun run test   (Node's built-in test runner, no extra dependency)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCsp } from './csp.ts';

const scheme = 'capacitor-electron';

describe('buildCsp', () => {
  it('lets the app reach its API: connect-src is set explicitly, not left to default-src', () => {
    for (const isDev of [true, false]) {
      const csp = buildCsp({ customScheme: scheme, isDev });
      assert.match(csp, /(^|; )connect-src /);
      assert.match(csp, /connect-src [^;]*capacitor-electron:\/\/\*/);
    }
  });

  it('development talks plain http and ws to a local API', () => {
    const csp = buildCsp({ customScheme: scheme, isDev: true });
    assert.match(csp, /connect-src [^;]*\bhttp:/);
    assert.match(csp, /connect-src [^;]*\bws:/);
    assert.match(csp, /connect-src [^;]*\bhttps:/);
    assert.match(csp, /connect-src [^;]*\bwss:/);
  });

  it('a packaged app only talks https and wss', () => {
    const connect = /connect-src ([^;]*)/.exec(buildCsp({ customScheme: scheme, isDev: false }))?.[1] ?? '';
    assert.match(connect, /\bhttps:/);
    assert.match(connect, /\bwss:/);
    assert.doesNotMatch(connect, /(^|\s)http:/);
    assert.doesNotMatch(connect, /(^|\s)ws:/);
  });

  it('keeps everything else as strict as before: no remote scripts, no eval outside development', () => {
    const production = buildCsp({ customScheme: scheme, isDev: false });
    assert.match(production, /default-src capacitor-electron:\/\/\* 'unsafe-inline' data:/);
    assert.doesNotMatch(production, /unsafe-eval|devtools:/);
    assert.doesNotMatch(production, /script-src/);

    const development = buildCsp({ customScheme: scheme, isDev: true });
    assert.match(development, /'unsafe-eval'/);
    assert.match(development, /devtools:\/\/\*/);
  });
});
