import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EngagementTracker,
  FIRST_CLASS_PARAMS,
  MAX_URL_LENGTH,
  attachToPlayer,
  buildBeaconUrl,
  createClient,
  createSessionId,
} from '../js/data-collection.js';

/**
 * A player that looks enough like Video.js for attachToPlayer(), and records
 * what was bound to it.
 *
 * @return {Object}
 */
function createFakePlayer() {
  /** @type {Map<string, Function[]>} */
  const handlers = new Map();
  let time = 0;
  let duration = 100;
  let ended = false;
  let paused = false;
  let error = null;

  return {
    on(type, handler) {
      const list = handlers.get(type) || [];
      list.push(handler);
      handlers.set(type, list);
    },
    off(type, handler) {
      const list = handlers.get(type) || [];
      handlers.set(
        type,
        list.filter((existing) => existing !== handler),
      );
    },
    emit(type) {
      for (const handler of handlers.get(type) || []) {
        handler({ type });
      }
    },
    listenerCount(type) {
      return (handlers.get(type) || []).length;
    },
    currentTime: () => time,
    duration: () => duration,
    ended: () => ended,
    paused: () => paused,
    error: () => error,
    videoWidth: () => 1280,
    videoHeight: () => 720,
    currentWidth: () => 960,
    currentHeight: () => 540,
    tech: () => ({
      el: () => ({
        getVideoPlaybackQuality: () => ({ droppedVideoFrames: 3 }),
      }),
    }),
    // Test helpers.
    seekTo(value) {
      time = value;
    },
    setDuration(value) {
      duration = value;
    },
    setEnded(value) {
      ended = value;
    },
    setPaused(value) {
      paused = value;
    },
    setError(value) {
      error = value;
    },
  };
}

/**
 * A client that records beacons instead of sending them.
 *
 * @param {Object} [options]
 * @return {{client: Object, beacons: string[], params: () => Object[]}}
 */
function createRecordingClient(options = {}) {
  const beacons = [];
  const client = createClient({
    account: '123',
    session: 'session-1',
    now: () => 1700000000000,
    destination: () => 'https://example.com/watch?a=1&b=2',
    source: () => 'https://example.com/search?q=a b',
    dispatch: (url) => beacons.push(url),
    ...options,
  });

  return {
    client,
    beacons,
    params: () => beacons.map((url) => Object.fromEntries(new URL(url).searchParams)),
  };
}

describe('buildBeaconUrl', () => {
  it('builds the v2 tracker URL with an encoded query string', () => {
    const url = buildBeaconUrl({
      account: '123',
      domain: 'videocloud',
      event: 'video_view',
      video: '456',
      time: 1700000000000,
    });

    assert.equal(
      url,
      'https://metrics.brightcove.com/v2/tracker?account=123&domain=videocloud&event=video_view&video=456&time=1700000000000',
    );
  });

  it('encodes destination and source exactly once', () => {
    const url = buildBeaconUrl({
      account: '123',
      domain: 'videocloud',
      event: 'video_view',
      destination: 'https://example.com/watch?a=1&b=2',
      source: 'https://example.com/search?q=a b',
    });

    assert.match(url, /destination=https%3A%2F%2Fexample\.com%2Fwatch%3Fa%3D1%26b%3D2/);
    assert.match(url, /source=https%3A%2F%2Fexample\.com%2Fsearch%3Fq%3Da%20b/);
    assert.doesNotMatch(url, /%25/);
  });

  it('drops null, undefined and empty parameters', () => {
    const url = buildBeaconUrl({
      account: '123',
      domain: 'videocloud',
      event: 'video_view',
      video_duration: null,
      video_name: undefined,
      source: '',
      video: '456',
    });

    assert.match(url, /video=456/);
    assert.doesNotMatch(url, /video_duration|video_name|source/);
  });

  it('refuses a beacon with no account', () => {
    assert.throws(
      () => buildBeaconUrl({ domain: 'videocloud', event: 'video_view' }),
      /the "account" parameter is required/,
    );
  });

  it('shortens an over-long beacon instead of letting it be truncated', () => {
    const url = buildBeaconUrl({
      account: '123',
      domain: 'videocloud',
      event: 'video_engagement',
      video: '456',
      range: '0..10',
      custom_fields: 'x'.repeat(6000),
    });

    assert.ok(url.length <= MAX_URL_LENGTH, `url was ${url.length} characters`);
    assert.match(url, /usage=lbu/);
    assert.match(url, /range=0\.\.10/);
    assert.doesNotMatch(url, /custom_fields/);
  });

  it('keeps every first-class parameter when shortening', () => {
    const params = {
      account: '123',
      domain: 'videocloud',
      event: 'video_engagement',
      video: '456',
      video_duration: 120,
      range: '0..9',
      session: 'session-1',
      time: 1700000000000,
      measured_bps: 1200000,
      junk: 'x'.repeat(5000),
    };

    const url = buildBeaconUrl(params);
    const query = Object.fromEntries(new URL(url).searchParams);

    for (const key of Object.keys(params)) {
      if (key === 'junk') {
        continue;
      }
      assert.ok(FIRST_CLASS_PARAMS.has(key), `${key} should be first class`);
      assert.equal(query[key], String(params[key]));
    }
  });

  it('leaves a URL of exactly the maximum length alone', () => {
    const base = {
      account: '123',
      domain: 'videocloud',
      event: 'video_view',
    };
    const baseLength = buildBeaconUrl(base).length;
    const padding = 'x'.repeat(MAX_URL_LENGTH - baseLength - '&pad='.length);

    const url = buildBeaconUrl({ ...base, pad: padding });

    assert.equal(url.length, MAX_URL_LENGTH);
    assert.match(url, /pad=xxx/);
    assert.doesNotMatch(url, /usage=lbu/);
  });

  it('shortens one character past the maximum length', () => {
    const base = {
      account: '123',
      domain: 'videocloud',
      event: 'video_view',
    };
    const baseLength = buildBeaconUrl(base).length;
    const padding = 'x'.repeat(MAX_URL_LENGTH - baseLength - '&pad='.length + 1);

    const url = buildBeaconUrl({ ...base, pad: padding });

    assert.ok(url.length <= MAX_URL_LENGTH);
    assert.match(url, /usage=lbu/);
  });
});

describe('createSessionId', () => {
  it('returns a version 4 UUID', () => {
    assert.match(createSessionId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('returns a different id every time', () => {
    assert.notEqual(createSessionId(), createSessionId());
  });
});

describe('EngagementTracker', () => {
  it('closes a range every ten seconds of playback', () => {
    const tracker = new EngagementTracker();
    tracker.start(0);

    assert.equal(tracker.tick(5), null);
    assert.deepEqual(tracker.tick(10), { range: '0..9', start: 0, end: 9, seconds: 10 });
    assert.deepEqual(tracker.tick(20), { range: '10..19', start: 10, end: 19, seconds: 10 });
  });

  it('reports a range the collector reads as the seconds actually watched', () => {
    // The collector reads `start..end` as inclusive: 0..9 is ten seconds.
    const tracker = new EngagementTracker();
    tracker.start(0);
    const engagement = tracker.tick(10.4);

    assert.equal(engagement.range, '0..9');
    assert.equal(engagement.seconds, 10);
    assert.equal(engagement.end - engagement.start + 1, engagement.seconds);
  });

  it('does not send a range for a pause inside one second', () => {
    const tracker = new EngagementTracker();
    tracker.start(0.2);

    assert.equal(tracker.stop(0.9), null);
  });

  it('splits a range across a pause and resumes where it stopped', () => {
    const tracker = new EngagementTracker();
    tracker.start(0);

    assert.deepEqual(tracker.stop(4), { range: '0..3', start: 0, end: 3, seconds: 4 });

    tracker.start(4);
    assert.deepEqual(tracker.tick(14), { range: '4..13', start: 4, end: 13, seconds: 10 });
  });

  it('does not count the part skipped by a seek', () => {
    const tracker = new EngagementTracker();
    tracker.start(0);
    tracker.tick(5);

    assert.deepEqual(tracker.seek(60), { range: '0..4', start: 0, end: 4, seconds: 5 });
    assert.deepEqual(tracker.tick(70), { range: '60..69', start: 60, end: 69, seconds: 10 });
  });

  it('never reports a range longer than the collector accepts', () => {
    const tracker = new EngagementTracker({ period: 10, maxRange: 20 });
    tracker.start(0);

    const engagement = tracker.tick(120);

    assert.equal(engagement.range, '0..19');
    assert.equal(engagement.seconds, 20);
  });

  it('treats a rewind as a new range', () => {
    const tracker = new EngagementTracker();
    tracker.start(0);
    tracker.tick(5);

    assert.deepEqual(tracker.tick(2), { range: '0..4', start: 0, end: 4, seconds: 5 });
    assert.deepEqual(tracker.tick(12), { range: '2..11', start: 2, end: 11, seconds: 10 });
  });
});

describe('createClient', () => {
  it('sends one beacon per event with the session and page context', () => {
    const { client, params } = createRecordingClient();

    client.send('video_view', { video: '456' });

    assert.equal(params().length, 1);
    assert.deepEqual(params()[0], {
      account: '123',
      domain: 'videocloud',
      event: 'video_view',
      time: '1700000000000',
      session: 'session-1',
      destination: 'https://example.com/watch?a=1&b=2',
      source: 'https://example.com/search?q=a b',
      video: '456',
    });
  });

  it('keeps the same session for every beacon', () => {
    const { client, params } = createRecordingClient();

    client.send('player_load');
    client.send('video_view', { video: '456' });

    assert.equal(params()[0].session, params()[1].session);
  });

  it('rejects an event the collector does not know', () => {
    const { client } = createRecordingClient();

    assert.throws(() => client.send('video_played'), /unknown event/);
  });

  it('reports a beacon without sending it in dry-run mode', () => {
    const { client, beacons } = createRecordingClient({ dryRun: true });
    const seen = [];
    const reporting = createClient({
      account: '123',
      dryRun: true,
      dispatch: (url) => beacons.push(url),
      onBeacon: (url) => seen.push(url),
    });

    client.send('video_view', { video: '456' });
    reporting.send('video_view', { video: '456' });

    assert.equal(beacons.length, 0);
    assert.equal(seen.length, 1);
  });

  it('holds beacons until consent is granted, then sends them', () => {
    const { client, beacons } = createRecordingClient({ consent: false });

    client.send('player_load');
    client.send('video_view', { video: '456' });

    assert.equal(beacons.length, 0);
    assert.equal(client.queueLength, 2);
    assert.equal(client.getConsent(), false);

    const flushed = client.setConsent(true);

    assert.equal(flushed.length, 2);
    assert.equal(beacons.length, 2);
    assert.equal(client.queueLength, 0);
  });

  it('keeps beacons queued while consent is refused', () => {
    const { client, beacons } = createRecordingClient({ consent: false });

    client.send('player_load');
    client.setConsent(false);

    assert.equal(beacons.length, 0);
    assert.equal(client.queueLength, 1);
    assert.equal(client.getConsent(), false);
  });

  it('sends the player id on every beacon when one is configured', () => {
    const { client, params } = createRecordingClient({ player: 'my-player' });

    client.send('player_load');
    client.send('video_view', { video: '456' });

    assert.deepEqual(
      params().map((beacon) => beacon.player),
      ['my-player', 'my-player'],
    );
  });

  it('omits the player id when none is configured', () => {
    const { client, params } = createRecordingClient();

    client.send('player_load');

    assert.equal(params()[0].player, undefined);
  });
});

describe('attachToPlayer', () => {
  it('sends impression, play request and view in the documented order', () => {
    const player = createFakePlayer();
    const { client, params } = createRecordingClient();
    attachToPlayer(player, client, { video: '456', videoName: 'EarthSample' });

    player.setDuration(152.9);
    player.emit('loadedmetadata');
    player.emit('play');
    player.emit('playing');

    assert.deepEqual(
      params().map((beacon) => beacon.event),
      ['video_impression', 'play_request', 'video_view'],
    );
    assert.equal(params()[0].video_duration, '152');
    assert.equal(params()[0].video_name, 'EarthSample');
  });

  it('sends the impression before the view even when play beats metadata', () => {
    const player = createFakePlayer();
    const { client, params } = createRecordingClient();
    attachToPlayer(player, client, { video: '456' });

    player.emit('play');
    player.emit('playing');

    assert.deepEqual(
      params().map((beacon) => beacon.event),
      ['video_impression', 'play_request', 'video_view'],
    );
  });

  it('sends video_view once per video', () => {
    const player = createFakePlayer();
    const { client, params } = createRecordingClient();
    attachToPlayer(player, client, { video: '456' });

    player.emit('loadedmetadata');
    player.emit('playing');
    player.emit('pause');
    player.emit('playing');

    assert.equal(params().filter((beacon) => beacon.event === 'video_view').length, 1);
  });

  it('sends an engagement event every ten seconds of playback', () => {
    const player = createFakePlayer();
    const { client, params } = createRecordingClient();
    attachToPlayer(player, client, { video: '456' });

    player.emit('loadedmetadata');
    player.emit('playing');

    player.seekTo(10);
    player.emit('timeupdate');
    player.seekTo(20);
    player.emit('timeupdate');

    const engagements = params().filter((beacon) => beacon.event === 'video_engagement');

    assert.deepEqual(
      engagements.map((beacon) => beacon.range),
      ['0..9', '10..19'],
    );
    assert.equal(engagements[0].video_duration, '100');
  });

  it('adds rebuffering and rendition data to engagement events', () => {
    const player = createFakePlayer();
    const { client, params } = createRecordingClient();
    attachToPlayer(player, client, { video: '456' });

    player.emit('loadedmetadata');
    player.emit('playing');
    player.emit('waiting');
    player.emit('playing');

    player.seekTo(10);
    player.emit('timeupdate');

    const engagement = params().find((beacon) => beacon.event === 'video_engagement');

    assert.equal(engagement.rebuffering_count, '1');
    assert.equal(engagement.rendition_width, '1280');
    assert.equal(engagement.rendition_height, '720');
    assert.equal(engagement.player_width, '960');
    assert.equal(engagement.dropped_frames, '3');
  });

  it('sends watched seconds instead of a range for live', () => {
    const player = createFakePlayer();
    const { client, params } = createRecordingClient();
    attachToPlayer(player, client, { video: '456', isLive: true });

    player.emit('loadedmetadata');
    player.emit('playing');
    player.seekTo(10);
    player.emit('timeupdate');

    const engagement = params().find((beacon) => beacon.event === 'video_engagement');

    assert.equal(engagement.video_seconds_viewed, '10');
    assert.equal(engagement.range, undefined);
    assert.equal(engagement.video_duration, undefined);
  });

  it('reports a player error with its code', () => {
    const player = createFakePlayer();
    const { client, params } = createRecordingClient();
    attachToPlayer(player, client, { video: '456' });

    player.setError({ code: 'MEDIA_ERR_SRC_NOT_SUPPORTED', message: 'nope' });
    player.emit('error');

    const error = params().find((beacon) => beacon.event === 'error');

    assert.equal(error.error_code, 'MEDIA_ERR_SRC_NOT_SUPPORTED');
  });

  it('starts a new sequence when the player loads another source', () => {
    const player = createFakePlayer();
    const { client, params } = createRecordingClient();
    attachToPlayer(player, client, { video: '456' });

    player.emit('loadedmetadata');
    player.emit('play');
    player.emit('playing');
    player.emit('loadstart');
    player.seekTo(0);
    player.emit('loadedmetadata');
    player.emit('play');
    player.emit('playing');

    assert.deepEqual(
      params().map((beacon) => beacon.event),
      [
        'video_impression',
        'play_request',
        'video_view',
        'video_impression',
        'play_request',
        'video_view',
      ],
    );
  });

  it('flushes the open range when the page goes away', () => {
    const player = createFakePlayer();
    const { client, params } = createRecordingClient();
    const binding = attachToPlayer(player, client, { video: '456' });

    player.emit('loadedmetadata');
    player.emit('playing');
    player.seekTo(6);

    binding.sendFinalEngagement();

    const engagement = params().find((beacon) => beacon.event === 'video_engagement');

    assert.equal(engagement.range, '0..5');
  });

  it('sends the open range when the binding is destroyed', () => {
    const player = createFakePlayer();
    const { client, params } = createRecordingClient();
    const binding = attachToPlayer(player, client, { video: '456' });

    player.emit('loadedmetadata');
    player.emit('playing');
    player.seekTo(7);

    binding.destroy();

    const engagement = params().find((beacon) => beacon.event === 'video_engagement');

    assert.equal(engagement.range, '0..6');
  });

  it('does not count a view when autoplay is refused', () => {
    const player = createFakePlayer();
    const { client, params } = createRecordingClient();
    attachToPlayer(player, client, { video: '456' });

    // Safari fires `playing` with `paused` still true when play() is refused.
    player.setPaused(true);
    player.emit('loadedmetadata');
    player.emit('playing');

    assert.equal(params().filter((beacon) => beacon.event === 'video_view').length, 0);
  });

  it('reports a numeric MediaError as its documented name', () => {
    const player = createFakePlayer();
    const { client, params } = createRecordingClient();
    attachToPlayer(player, client, { video: '456' });

    player.setError({ code: 4, message: 'nope' });
    player.emit('error');

    assert.equal(params()[0].error_code, 'MEDIA_ERR_SRC_NOT_SUPPORTED');
  });

  it('closes a stall when playback pauses instead of charging the pause', () => {
    const player = createFakePlayer();
    const { client, params } = createRecordingClient();
    let clock = 1000;
    attachToPlayer(player, client, { video: '456', now: () => clock });

    player.emit('loadedmetadata');
    player.emit('playing');
    player.seekTo(3);
    player.emit('timeupdate');
    player.emit('waiting');
    clock += 400;
    player.emit('pause');

    const engagement = params().find((beacon) => beacon.event === 'video_engagement');

    assert.equal(engagement.range, '0..2');
    assert.equal(engagement.rebuffering_count, '1');
    assert.equal(engagement.rebuffering_seconds, '0.4');
  });

  it('counts one stall per waiting burst, not one per event', () => {
    const player = createFakePlayer();
    const { client, params } = createRecordingClient();
    let clock = 1000;
    attachToPlayer(player, client, { video: '456', now: () => clock });

    player.emit('loadedmetadata');
    player.emit('playing');
    player.seekTo(3);
    player.emit('timeupdate');
    player.emit('waiting');
    clock += 500;
    player.emit('waiting');
    clock += 500;
    player.emit('playing');
    player.seekTo(13);
    player.emit('timeupdate');

    const engagement = params().find((beacon) => beacon.event === 'video_engagement');

    assert.equal(engagement.rebuffering_count, '1');
    assert.equal(engagement.rebuffering_seconds, '1');
  });

  it('counts a stall the viewer seeks out of', () => {
    const player = createFakePlayer();
    const { client, params } = createRecordingClient();
    let clock = 1000;
    attachToPlayer(player, client, { video: '456', now: () => clock });

    player.emit('loadedmetadata');
    player.emit('playing');
    player.seekTo(3);
    player.emit('timeupdate');
    player.emit('waiting');
    clock += 2000;
    player.seekTo(40);
    player.emit('seeking');
    player.seekTo(50);
    player.emit('timeupdate');

    const engagement = params().find((beacon) => beacon.event === 'video_engagement');

    assert.equal(engagement.rebuffering_count, '1');
    assert.equal(engagement.rebuffering_seconds, '2');
  });

  it('treats a stream with no finite duration as live', () => {
    const player = createFakePlayer();
    player.setDuration(Infinity);
    const { client, params } = createRecordingClient();
    attachToPlayer(player, client, { video: '456' });

    player.emit('loadedmetadata');
    player.emit('playing');
    player.seekTo(10);
    player.emit('timeupdate');

    const engagement = params().find((beacon) => beacon.event === 'video_engagement');

    assert.equal(engagement.video_seconds_viewed, '10');
    assert.equal(engagement.video_duration, undefined);
  });

  it('unbinds every listener on destroy', () => {
    const player = createFakePlayer();
    const { client } = createRecordingClient();
    const binding = attachToPlayer(player, client, { video: '456' });

    assert.ok(player.listenerCount('timeupdate') > 0);
    binding.destroy();
    assert.equal(player.listenerCount('timeupdate'), 0);
  });
});
