import { describe, expect, it } from 'vitest';
import { IceRestartCoordinator } from './IceRestart';
import type { SocketPort } from './IceRestart';

/** Just enough of RTCPeerConnection for the handshake. */
class FakePc {
  iceConnectionState = 'disconnected';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  log: string[] = [];
  /** candidates the "browser" gathers while a local description is being set (as real browsers do) */
  gatherOnSetLocal: string[] = [];
  private listeners = new Map<string, ((event: unknown) => void)[]>();

  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener),
    );
  }
  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  candidate(name: string) {
    this.emit('icecandidate', { candidate: { toJSON: () => ({ candidate: name }) } });
  }
  async createOffer(options?: { iceRestart?: boolean }) {
    this.log.push(`createOffer iceRestart=${options?.iceRestart}`);
    return { type: 'offer', sdp: 'v=0\r\nm=audio 9 RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=ice-ufrag:NEW\r\n' };
  }
  async createAnswer() {
    this.log.push('createAnswer');
    return { type: 'answer', sdp: 'v=0\r\nm=audio 9 RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=ice-ufrag:ANS\r\n' };
  }
  async setLocalDescription(description: { type: string; sdp: string }) {
    this.localDescription = description;
    this.log.push(`setLocal ${description.type}`);
    for (const name of this.gatherOnSetLocal) this.candidate(name);
  }
  async setRemoteDescription(description: { type: string; sdp: string }) {
    this.remoteDescription = description;
    this.log.push(`setRemote ${description.type}`);
  }
  async addIceCandidate(candidate: { candidate?: string }) {
    this.log.push(`addCandidate ${candidate.candidate}`);
  }
}

/** Two peers connected through an in-memory gateway that stamps `from`, like the real server does. */
function network() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const pending: Promise<void>[] = [];
  const sent: { from: string; kind: string; name?: string }[] = [];
  const portFor = (selfId: string): SocketPort => ({
    subscribe: (channel, handler) => void handlers.set(channel, handler),
    unsubscribe: (channel) => void handlers.delete(channel),
    publish: (channel, data) => {
      const message = data as { kind: string; candidate?: { candidate?: string } };
      sent.push({ from: selfId, kind: message.kind, ...(message.candidate?.candidate ? { name: message.candidate.candidate } : {}) });
      pending.push(Promise.resolve().then(() => handlers.get(channel)?.({ from: selfId, data })));
    },
  });
  const settle = async () => {
    for (let round = 0; round < 10; round++) {
      await Promise.all(pending.splice(0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  const caller = new IceRestartCoordinator(portFor('callerAA'));
  const callee = new IceRestartCoordinator(portFor('calleeBB'));
  caller.listen('callerAA');
  callee.listen('calleeBB');
  const callerPc = new FakePc();
  const calleePc = new FakePc();
  caller.register('calleeBB', 'conn1', callerPc as unknown as RTCPeerConnection, true);
  callee.register('callerAA', 'conn1', calleePc as unknown as RTCPeerConnection, false);
  return { caller, callee, callerPc, calleePc, settle, sent };
}

describe('ICE restart handshake', () => {
  it('renegotiates through offer and answer, with the voice optimisations kept', async () => {
    const { caller, callerPc, calleePc, settle } = network();
    await caller.restart('calleeBB', 'conn1');
    await settle();

    expect(callerPc.log).toEqual(['createOffer iceRestart=true', 'setLocal offer', 'setRemote answer']);
    expect(calleePc.log).toEqual(['setRemote offer', 'createAnswer', 'setLocal answer']);
    expect(calleePc.remoteDescription?.sdp).toContain('a=ice-ufrag:NEW'); // the callee received the restart offer
    expect(callerPc.remoteDescription?.sdp).toContain('a=ice-ufrag:ANS');
    expect(callerPc.localDescription?.sdp).toContain('useinbandfec=1'); // FEC survives the renegotiation
  });

  it('sends candidates gathered while the description was being set only after the offer / answer', async () => {
    const { caller, callerPc, calleePc, settle, sent } = network();
    callerPc.gatherOnSetLocal = ['caller-host', 'caller-srflx'];
    calleePc.gatherOnSetLocal = ['callee-host'];

    await caller.restart('calleeBB', 'conn1');
    await settle();

    const order = sent.map((message) => (message.name ? `${message.from}:${message.name}` : `${message.from}:${message.kind}`));
    expect(order.indexOf('callerAA:offer')).toBeLessThan(order.indexOf('callerAA:caller-host'));
    expect(order.indexOf('callerAA:offer')).toBeLessThan(order.indexOf('callerAA:caller-srflx'));
    expect(order.indexOf('calleeBB:answer')).toBeLessThan(order.indexOf('calleeBB:callee-host'));

    // and both sides ended up with every candidate of the other
    expect(calleePc.log).toEqual(expect.arrayContaining(['addCandidate caller-host', 'addCandidate caller-srflx']));
    expect(callerPc.log).toContain('addCandidate callee-host');
  });

  it('keeps candidates that arrive ahead of the offer and applies them once it is set', async () => {
    const { callee, calleePc, settle } = network();
    // the network delivered two candidates before the offer they belong to
    const deliver = (data: object) => (callee as unknown as { receive(payload: object): void }).receive({ from: 'callerAA', data });
    deliver({ kind: 'candidate', connectionId: 'conn1', candidate: { candidate: 'early-1' } });
    deliver({ kind: 'candidate', connectionId: 'conn1', candidate: { candidate: 'early-2' } });
    deliver({ kind: 'offer', connectionId: 'conn1', sdp: 'v=0\r\na=ice-ufrag:NEW\r\n' });
    await settle();

    const log = calleePc.log;
    expect(log.indexOf('setRemote offer')).toBeLessThan(log.indexOf('addCandidate early-1'));
    expect(log).toContain('addCandidate early-2');
  });

  it('forwards candidates during a restart but not before it', async () => {
    const { caller, callerPc, calleePc, settle } = network();
    callerPc.candidate('before-restart');
    await settle();
    expect(calleePc.log).toEqual([]);

    await caller.restart('calleeBB', 'conn1');
    callerPc.candidate('caller-1');
    await settle();
    calleePc.candidate('callee-1');
    await settle();

    expect(calleePc.log).toContain('addCandidate caller-1');
    expect(callerPc.log).toContain('addCandidate callee-1');
    expect(calleePc.log).not.toContain('addCandidate before-restart');
  });

  it('does not start a second restart while one is in flight', async () => {
    const { caller, callerPc, settle } = network();
    await Promise.all([caller.restart('calleeBB', 'conn1'), caller.restart('calleeBB', 'conn1')]);
    await settle();
    expect(callerPc.log.filter((entry) => entry.startsWith('createOffer'))).toHaveLength(1);
  });

  it('only the caller offers', async () => {
    const { callee, calleePc, settle } = network();
    await callee.restart('callerAA', 'conn1'); // callee is not the originator
    await settle();
    expect(calleePc.log).toEqual([]);
  });

  it('ignores messages for calls it does not know', async () => {
    const { caller, callerPc, calleePc, settle } = network();
    caller.unregister('calleeBB', 'conn1');
    await caller.restart('calleeBB', 'conn1');
    await settle();
    expect(callerPc.log).toEqual([]);
    expect(calleePc.log).toEqual([]);
  });

  it('stops forwarding candidates once the connection is back, and allows a later restart', async () => {
    const { caller, callerPc, calleePc, settle } = network();
    await caller.restart('calleeBB', 'conn1');
    await settle();
    callerPc.iceConnectionState = 'connected';
    callerPc.emit('iceconnectionstatechange', {});
    callerPc.candidate('late');
    await settle();
    expect(calleePc.log).not.toContain('addCandidate late');

    await caller.restart('calleeBB', 'conn1'); // not busy any more
    await settle();
    expect(callerPc.log.filter((entry) => entry.startsWith('createOffer'))).toHaveLength(2);
  });
});
