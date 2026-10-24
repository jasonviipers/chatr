import { describe, expect, it } from 'vitest';
import {
  buildMeetingLockPayload,
  MeetingRegistry,
} from '../src/realtime/meetings.ts';

describe('MeetingRegistry', () => {
  it('leaves a meeting open until its host registers it, whoever asks', () => {
    const meetings = new MeetingRegistry();
    expect(meetings.isLocked('hostAAAA1')).toBe(false);
    expect(meetings.admits('hostAAAA1', null)).toBe(true);
    expect(meetings.admits('hostAAAA1', 'someone01')).toBe(true);
    expect(meetings.blocks('someone01', 'hostAAAA1')).toBe(false);
    meetings.addMember('hostAAAA1', 'someone01'); // not registered: nobody is remembered
    meetings.setLocked('hostAAAA1', true);
    expect(meetings.admits('hostAAAA1', 'someone01')).toBe(false);
  });

  it('remembers who was there before the lock and lets only them (and the host) in afterwards', () => {
    const meetings = new MeetingRegistry();
    meetings.setLocked('hostAAAA1', false);
    meetings.addMember('hostAAAA1', 'member001');
    meetings.addMember('hostAAAA1', 'member002');
    meetings.setLocked('hostAAAA1', true);
    meetings.addMember('hostAAAA1', 'late00001'); // too late: the meeting is locked

    expect(meetings.isLocked('hostAAAA1')).toBe(true);
    expect(meetings.admits('hostAAAA1', 'member001')).toBe(true);
    expect(meetings.admits('hostAAAA1', 'hostAAAA1')).toBe(true);
    expect(meetings.admits('hostAAAA1', 'late00001')).toBe(false);
    expect(meetings.admits('hostAAAA1', null)).toBe(false); // not identified
    expect(meetings.admits('hostBBBB2', 'late00001')).toBe(true); // another meeting is not affected
  });

  it('treats somebody who left or was removed as a newcomer again', () => {
    const meetings = new MeetingRegistry();
    meetings.setLocked('hostAAAA1', false);
    meetings.addMember('hostAAAA1', 'member001');
    meetings.addMember('hostAAAA1', 'member002');
    meetings.forget('hostAAAA1', 'member001');
    meetings.forget('hostBBBB2', 'member002'); // another meeting: no effect
    meetings.setLocked('hostAAAA1', true);

    expect(meetings.admits('hostAAAA1', 'member001')).toBe(false);
    expect(meetings.blocks('member001', 'hostAAAA1')).toBe(true);
    expect(meetings.admits('hostAAAA1', 'member002')).toBe(true);
    expect(meetings.blocks('member001', 'member002')).toBe(true);
  });

  it('blocks calls from strangers to the host and to members, and nothing else', () => {
    const meetings = new MeetingRegistry();
    meetings.setLocked('hostAAAA1', false);
    meetings.addMember('hostAAAA1', 'member001');
    meetings.setLocked('hostAAAA1', true);

    expect(meetings.blocks('stranger1', 'hostAAAA1')).toBe(true);
    expect(meetings.blocks('stranger1', 'member001')).toBe(true);
    expect(meetings.blocks('member001', 'hostAAAA1')).toBe(false);
    expect(meetings.blocks('hostAAAA1', 'member001')).toBe(false);
    expect(meetings.blocks('member001', 'stranger1')).toBe(false); // members may call out
    expect(meetings.blocks('stranger1', 'stranger2')).toBe(false); // nothing to do with the meeting

    meetings.setLocked('hostAAAA1', false);
    expect(meetings.blocks('stranger1', 'hostAAAA1')).toBe(false);
    expect(meetings.blocks('stranger1', 'member001')).toBe(false);
  });

  it('keeps the people it remembers within a limit, and the meetings too', () => {
    const small = new MeetingRegistry({ maxMeetings: 2, maxMembers: 2 });
    expect(small.setLocked('hostAAAA1', false)).toBe(true);
    expect(small.setLocked('hostBBBB2', true)).toBe(true);
    expect(small.setLocked('hostCCCC3', true)).toBe(false); // no room for a third
    expect(small.setLocked('hostAAAA1', true)).toBe(true); // a known one still can change
    small.setLocked('hostAAAA1', false);
    for (const id of ['member001', 'member002', 'member003'])
      small.addMember('hostAAAA1', id);
    small.setLocked('hostAAAA1', true);
    expect(small.admits('hostAAAA1', 'member002')).toBe(true);
    expect(small.admits('hostAAAA1', 'member003')).toBe(false);
  });

  it('forgets meetings nobody has touched for a long time', () => {
    let now = 0;
    const meetings = new MeetingRegistry({ idleMs: 1000, now: () => now });
    meetings.setLocked('hostAAAA1', false);
    meetings.addMember('hostAAAA1', 'member001');
    meetings.setLocked('hostAAAA1', true);
    now = 900;
    meetings.sweep();
    expect(meetings.isLocked('hostAAAA1')).toBe(true);
    now = 5000;
    meetings.sweep();
    expect(meetings.size).toBe(0);
    expect(meetings.blocks('stranger1', 'member001')).toBe(false);
  });
});

describe('buildMeetingLockPayload', () => {
  it('takes the switch from the client and the sender from the server', () => {
    expect(
      buildMeetingLockPayload('hostAAAA1', { locked: true, from: 'forged' }),
    ).toEqual({ from: 'hostAAAA1', locked: true });
    expect(buildMeetingLockPayload(null, { locked: true })).toBeNull();
    for (const data of [
      null,
      undefined,
      'yes',
      {},
      { locked: 1 },
      { locked: 'true' },
    ])
      expect(buildMeetingLockPayload('p', data)).toBeNull();
  });
});
