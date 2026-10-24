import { afterEach, describe, expect, it } from 'vitest';
import { MeetingRegistry } from '../src/realtime/meetings.ts';
import { call, createTestApp } from './helpers.ts';
import { cleanupAll, person, startGateway } from './gateway-helpers.ts';

afterEach(cleanupAll);

const HOST = 'hostAAAA1';
const MEETING = `/mediaState/${HOST}`;
const LOCK = `/meetingLock/${HOST}`;
const CHAT = `/chat/${HOST}`;

/** A meeting with its host (registered, open) and one member who is in it. */
async function openMeeting() {
  const { gateway, port } = await startGateway();
  const host = await person(port, HOST);
  expect(await host.publish(LOCK, { locked: false })).toBe('ok'); // the host registers its meeting
  const member = await person(port, 'member001');
  for (const channel of [MEETING, CHAT, LOCK])
    expect(await member.subscribe(channel)).toBe('ok');
  return { gateway, port, host, member };
}

describe('a locked meeting', () => {
  it('lets only its host lock it, and tells the members', async () => {
    const { host, member, port } = await openMeeting();
    const stranger = await person(port, 'stranger1');

    expect(await stranger.publish(LOCK, { locked: true })).toBe('forbidden');
    expect(await member.publish(LOCK, { locked: true })).toBe('forbidden');
    expect(await host.publish(LOCK, { locked: 'yes' })).toBe('bad_message');

    expect(await host.publish(LOCK, { locked: true })).toBe('ok');
    const told = await member.socket.next(
      (m) => m['t'] === 'm' && m['c'] === LOCK,
    );
    expect(told['d']).toEqual({ from: HOST, locked: true });
  });

  it('keeps strangers out of its channels (chat, state, ...) but not the members or the host', async () => {
    const { host, member, port, gateway } = await openMeeting();
    expect(await host.publish(LOCK, { locked: true })).toBe('ok');
    expect(gateway.meetings.isLocked(HOST)).toBe(true);

    const stranger = await person(port, 'stranger1');
    for (const channel of [
      MEETING,
      CHAT,
      LOCK,
      `/whiteboardDrawingAdd/${HOST}`,
    ])
      expect(await stranger.subscribe(channel)).toBe('meeting_locked');
    expect(
      await stranger.publish(CHAT, { id: 'message-001', text: 'let me in' }),
    ).toBe('meeting_locked');

    // somebody who is not even identified is refused as well
    const { connect } = await import('./gateway-helpers.ts');
    const anonymous = await connect(port, '/socket');
    anonymous.send({ t: 'hi', sid: 'anonymous-session' });
    anonymous.send({ t: 'sub', c: CHAT });
    const refused = await anonymous.next((m) => m['t'] === 'err');
    expect(refused['code']).toBe('meeting_locked');

    // the people who are in keep talking, the host included
    expect(
      await member.publish(CHAT, { id: 'message-002', text: 'still here' }),
    ).toBe('ok');
    const heard = await host.subscribe(CHAT);
    expect(heard).toBe('ok');
    expect(
      await host.publish(CHAT, { id: 'message-003', text: 'welcome' }),
    ).toBe('ok');
    expect(stranger.socket.messages.some((m) => m['t'] === 'm')).toBe(false);
  });

  it('lets a member whose connection dropped come back, even while locked', async () => {
    const { host, member, port } = await openMeeting();
    expect(await host.publish(LOCK, { locked: true })).toBe('ok');

    member.socket.ws.terminate();
    const { connect } = await import('./gateway-helpers.ts');
    const again = await connect(port, '/socket');
    again.send({
      t: 'hi',
      sid: 'member001-socket-2',
      peerId: 'member001',
      token: member.token,
    });
    await again.next((m) => m['t'] === 'hi' && m['peer'] === true);
    again.send({ t: 'sub', c: CHAT });
    expect((await again.next((m) => m['t'] === 'ok'))['c']).toBe(CHAT);
  });

  it('does not let somebody back in whom the host removed or who left, but only they can say they left', async () => {
    const { host, member, port } = await openMeeting();
    const leaver = await person(port, 'leaver001');
    const kicked = await person(port, 'kicked001');
    const bystander = await person(port, 'bystand01');
    for (const who of [leaver, kicked, bystander])
      for (const channel of [MEETING, CHAT, LOCK])
        expect(await who.subscribe(channel)).toBe('ok');

    expect(await host.publish(`/memberRemove/${HOST}`, 'kicked001')).toBe('ok');
    expect(await leaver.publish(`/remoteDisconnect/${HOST}`, 'leaver001')).toBe(
      'ok',
    );
    // announcing somebody else's departure does not make them a newcomer
    expect(
      await bystander.publish(`/remoteDisconnect/${HOST}`, 'member001'),
    ).toBe('ok');
    expect(await host.publish(LOCK, { locked: true })).toBe('ok');

    expect(await kicked.subscribe(CHAT)).toBe('meeting_locked');
    expect(await leaver.subscribe(CHAT)).toBe('meeting_locked');
    expect(await member.subscribe(CHAT)).toBe('ok');
    expect(await bystander.subscribe(CHAT)).toBe('ok');
  });

  it('refuses a stranger who tries to call the host or a member, whatever app is used', async () => {
    const { host, member, port } = await openMeeting();
    expect(await host.publish(LOCK, { locked: true })).toBe('ok');
    const stranger = await person(port, 'stranger1');

    stranger.peer.send({ type: 'OFFER', dst: HOST, payload: { sdp: 'v=0' } });
    const refused = await stranger.peer.next((m) => m['type'] === 'ERROR');
    expect(refused['payload']).toEqual({ msg: 'This meeting is locked' });
    stranger.peer.send({
      type: 'OFFER',
      dst: 'member001',
      payload: { sdp: 'v=0' },
    });
    stranger.peer.send({
      type: 'CANDIDATE',
      dst: HOST,
      payload: { candidate: 'x' },
    });
    expect(
      await host.peer.sawWithin(
        (m) => m['type'] === 'OFFER' || m['type'] === 'CANDIDATE',
      ),
    ).toBe(false);
    expect(await member.peer.sawWithin((m) => m['type'] === 'OFFER')).toBe(
      false,
    );

    // members still call the host (a call that was lost is dialled again), and the host calls them
    member.peer.send({ type: 'OFFER', dst: HOST, payload: { sdp: 'v=0' } });
    expect((await host.peer.next((m) => m['type'] === 'OFFER'))['src']).toBe(
      'member001',
    );
    host.peer.send({
      type: 'OFFER',
      dst: 'member001',
      payload: { sdp: 'v=0' },
    });
    expect((await member.peer.next((m) => m['type'] === 'OFFER'))['src']).toBe(
      HOST,
    );
  });

  it('lets everybody in again when the host unlocks', async () => {
    const { host, port } = await openMeeting();
    expect(await host.publish(LOCK, { locked: true })).toBe('ok');
    const late = await person(port, 'late00001');
    expect(await late.subscribe(CHAT)).toBe('meeting_locked');

    expect(await host.publish(LOCK, { locked: false })).toBe('ok');
    expect(await late.subscribe(CHAT)).toBe('ok');
    expect(await late.subscribe(MEETING)).toBe('ok');
    late.peer.send({ type: 'OFFER', dst: HOST, payload: { sdp: 'v=0' } });
    expect((await host.peer.next((m) => m['type'] === 'OFFER'))['src']).toBe(
      'late00001',
    );
  });

  it('does nothing to meetings whose host never registered them', async () => {
    const { port } = await startGateway();
    const a = await person(port, 'aliceAAA1');
    const b = await person(port, 'bobBBBBB1');
    expect(await a.subscribe('/chat/someMeet01')).toBe('ok');
    expect(await b.subscribe('/chat/someMeet01')).toBe('ok');
    b.peer.send({ type: 'OFFER', dst: 'aliceAAA1', payload: { sdp: 'v=0' } });
    expect((await a.peer.next((m) => m['type'] === 'OFFER'))['src']).toBe(
      'bobBBBBB1',
    );
  });
});

describe('GET /meetings/:id', () => {
  it('says whether a meeting is locked, for anybody, and nothing else', async () => {
    const meetings = new MeetingRegistry();
    const { app } = createTestApp({}, { meetings });
    expect((await call(app, 'GET', `/meetings/${HOST}`)).json).toEqual({
      locked: false,
    });

    meetings.setLocked(HOST, true);
    const locked = await call(app, 'GET', `/meetings/${HOST}`);
    expect(locked.status).toBe(200);
    expect(locked.json).toEqual({ locked: true });

    expect((await call(app, 'GET', '/meetings/not%20an%20id')).status).toBe(
      400,
    );
    expect(
      (await call(app, 'GET', `/meetings/${'x'.repeat(100)}`)).status,
    ).toBe(400);
  });

  it('is limited per address like the other open questions', async () => {
    const { app } = createTestApp();
    let last = 200;
    for (let i = 0; i < 80; i++)
      last = (await call(app, 'GET', `/meetings/${HOST}`)).status;
    expect(last).toBe(429);
  });
});
