/**
 * @module data-collection
 *
 * A dependency-free client for the Brightcove Analytics **Data Collection API
 * v2**, for players that Brightcove does not instrument itself.
 *
 * If you are using a Brightcove Player or one of the Native SDKs, do not use
 * this: those already send these beacons, and sending your own duplicates
 * every view.
 *
 * The three layers below can be used together or on their own:
 *
 * - {@link buildBeaconUrl} turns a parameter object into a collector URL. Pure,
 *   so it is easy to unit test.
 * - {@link createClient} owns the session, consent and transport.
 * - {@link attachToPlayer} binds a player to the client and turns playback
 *   events into the v2 events. It expects a Video.js-shaped player; for
 *   anything else, drive {@link EngagementTracker} and `client.send()` yourself.
 *
 * @see https://apis.support.brightcove.com/data-collection/getting-started/overview-data-collection-api-v2.html
 */

/**
 * Production collector endpoint.
 *
 * QA and staging collectors exist (`metrics.juju.qa.brightcove.com` and
 * `metrics.juju.staging.brightcove.com`, both with the same `/v2/tracker`
 * path) but are only reachable from inside Brightcove.
 *
 * @type {string}
 */
export const ENDPOINT = 'https://metrics.brightcove.com/v2/tracker';

/**
 * The longest beacon URL that can be relied on. Older proxies and browsers
 * truncate long URLs, and the collector answers 400 for a request line it
 * cannot parse.
 *
 * @type {number}
 */
export const MAX_URL_LENGTH = 4000;

/**
 * Parameters worth keeping when a beacon is too long.
 *
 * Anything not listed here is dropped first, because the engagement and QoE
 * numbers are what reports are built from, while things like `tags` and
 * `custom_fields` are conveniences. `usage=lbu` is added so Brightcove can
 * count how often this happens.
 *
 * @type {ReadonlySet<string>}
 */
export const FIRST_CLASS_PARAMS = new Set([
  'account',
  'delivery_type',
  'destination',
  'domain',
  'dropped_frames',
  'error_code',
  'event',
  'feature',
  'file_size_bytes',
  'forward_buffer_seconds',
  'load_time_ms',
  'media_type',
  'measured_bps',
  'platform',
  'platform_version',
  'player',
  'player_height',
  'player_name',
  'player_width',
  'range',
  'rebuffering_count',
  'rebuffering_seconds',
  'rendition_height',
  'rendition_indicated_bps',
  'rendition_mime_type',
  'rendition_width',
  'response_time_ms',
  'session',
  'start_time_ms',
  'source',
  'time',
  'usage',
  'video',
  'video_duration',
  'video_name',
  'video_seconds_viewed',
]);

/**
 * Value of the `usage` parameter added when a beacon URL had to be shortened.
 *
 * @type {string}
 */
const LONG_BEACON_USAGE = 'lbu';

/**
 * The events this sample sends. The collector also understands
 * `catalog_request`, `catalog_response`, `ad_mode_begin` and
 * `ad_mode_complete`. Those describe a player's own ad insertion and catalog
 * calls, they are not exposed in the Analytics module or the Analytics API, so
 * a player that just plays a URL has nothing to report for them.
 *
 * @type {ReadonlySet<string>}
 */
export const EVENTS = new Set([
  'player_load',
  'error',
  'play_request',
  'video_impression',
  'video_view',
  'video_engagement',
]);

/**
 * @typedef {Object} BeaconParams
 * @property {string} account Video Cloud account id.
 * @property {string} domain Always `videocloud`.
 * @property {string} event One of {@link EVENTS}.
 * @property {number} time Event timestamp, epoch milliseconds.
 * @property {string} session Session id, constant for the life of the page.
 * @property {string} [video] Video Cloud video id. Never a reference id.
 * @property {string} [video_name] Video name at the time of the event.
 * @property {number} [video_duration] Duration in seconds. VOD only.
 * @property {string} [range] Viewed range, `start..end` in whole seconds.
 * @property {number} [video_seconds_viewed] Watched seconds, for live.
 * @property {string} [destination] URI of the page holding the player.
 * @property {string} [source] URI that sent the viewer to the destination.
 */

/**
 * Percent-encodes a single parameter value.
 *
 * `encodeURIComponent` leaves `!'()*` alone; none of those break a query
 * string, so the result is safe as-is.
 *
 * @param {string|number} value
 * @return {string}
 */
const encodeValue = (value) => encodeURIComponent(String(value));

/**
 * Serializes parameters into a query string, dropping `null`, `undefined` and
 * empty values.
 *
 * @param {Object<string, *>} params
 * @return {string}
 */
const toQueryString = (params) =>
  Object.keys(params)
    .filter((key) => params[key] !== null && params[key] !== undefined && params[key] !== '')
    .map((key) => `${encodeValue(key)}=${encodeValue(params[key])}`)
    .join('&');

/**
 * Builds a collector URL from a parameter object.
 *
 * If the result is longer than {@link MAX_URL_LENGTH}, non-essential
 * parameters are dropped and `usage=lbu` is added, mirroring what the
 * Brightcove Player does.
 *
 * @param {Object<string, *>} params
 * @param {string} [endpoint=ENDPOINT]
 * @return {string}
 * @throws {TypeError} If `account`, `domain` or `event` is missing.
 */
export function buildBeaconUrl(params, endpoint = ENDPOINT) {
  for (const required of ['account', 'domain', 'event']) {
    if (params[required] === null || params[required] === undefined || params[required] === '') {
      throw new TypeError(`the "${required}" parameter is required`);
    }
  }

  const url = `${endpoint}?${toQueryString(params)}`;
  if (url.length <= MAX_URL_LENGTH) {
    return url;
  }

  /** @type {Object<string, *>} */
  const essential = {};
  for (const [key, value] of Object.entries(params)) {
    if (FIRST_CLASS_PARAMS.has(key)) {
      essential[key] = value;
    }
  }
  essential.usage = LONG_BEACON_USAGE;

  return `${endpoint}?${toQueryString(essential)}`;
}

/**
 * Returns a random RFC 4122 version 4 id, used as the analytics session id.
 *
 * The session is one page or app view, and must be identical on every event
 * sent during it. Collisions are not fatal, but two sessions the collector
 * cannot tell apart may be discarded.
 *
 * @return {string}
 */
export function createSessionId() {
  const crypto = globalThis.crypto;

  if (crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  if (crypto && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/**
 * @typedef {Object} Engagement
 * @property {string} range Viewed range, `start..end`, both inclusive.
 * @property {number} start First viewed second of the range.
 * @property {number} end Last viewed second of the range.
 * @property {number} seconds Viewed seconds in the range.
 */

/**
 * Turns continuous playback into the `range` values a `video_engagement`
 * event needs.
 *
 * The collector discards any range longer than 20 seconds, and reports built
 * from a single long range are wrong, so this closes a range every
 * `period` seconds of playback. Pauses, seeks and source changes each close
 * the current range and start a new one, which is what keeps a seek from
 * being counted as watched time.
 *
 * All times are media time, in seconds, as reported by the player. The class
 * has no timer of its own: call {@link EngagementTracker#tick} from the
 * player's `timeupdate`.
 */
export class EngagementTracker {
  /**
   * @param {Object} [options]
   * @param {number} [options.period=10] Seconds of playback per range.
   * @param {number} [options.maxRange=20] Longest range the collector accepts.
   */
  constructor({ period = 10, maxRange = 20 } = {}) {
    this.period = Math.min(period, maxRange);
    this.maxRange = maxRange;

    /** @type {boolean} */
    this.active = false;
    /** @type {number} */
    this.rangeStart = 0;
    /** @type {number} */
    this.lastTime = 0;
  }

  /**
   * Begins a range at the given media time. No-op if already tracking.
   *
   * @param {number} time
   * @return {null} Always null; `start()` closes nothing.
   */
  start(time) {
    if (this.active) {
      return null;
    }
    this.active = true;
    this.rangeStart = time;
    this.lastTime = time;
    return null;
  }

  /**
   * Records playback progress, returning a range when one is complete.
   *
   * Playback that runs past `period` seconds closes the range; playback that
   * runs past `maxRange` is cut at `maxRange`, because the collector discards
   * longer ranges. A rewind is treated as a discontinuity even when the player
   * sent no `seeking` event, so a restart never counts the skipped seconds.
   *
   * A gap longer than `maxRange` means `timeupdate` did not run for that long,
   * which in practice means a throttled background tab. The part past the cap
   * is dropped rather than reported: the sample cannot know whether it was
   * watched, and guessing would inflate the numbers.
   *
   * @param {number} time Current media time.
   * @return {Engagement|null}
   */
  tick(time) {
    if (!this.active || !Number.isFinite(time)) {
      return null;
    }

    if (time < this.lastTime) {
      const closed = this.close();
      this.rangeStart = time;
      this.lastTime = time;
      return closed;
    }

    this.lastTime = time;

    if (time - this.rangeStart >= this.period) {
      return this.close();
    }

    return null;
  }

  /**
   * Closes the current range because playback stopped.
   *
   * @param {number} [time] Media time at which playback stopped.
   * @return {Engagement|null}
   */
  stop(time) {
    if (!this.active) {
      return null;
    }
    if (Number.isFinite(time)) {
      this.lastTime = time;
    }
    this.active = false;
    return this.close();
  }

  /**
   * Closes the current range and starts another at the new position, so the
   * skipped part is never counted as watched.
   *
   * @param {number} time Media time after the seek.
   * @return {Engagement|null} The range before the seek, if it was worth sending.
   */
  seek(time) {
    if (!this.active) {
      return null;
    }
    const closed = this.close();
    this.rangeStart = time;
    this.lastTime = time;
    return closed;
  }

  /**
   * @private
   * @return {Engagement|null}
   */
  close() {
    const start = Math.floor(this.rangeStart);
    const lastPlayedSecond = Math.floor(this.lastTime) - 1;

    // The collector reads `start..end` as inclusive, so ten seconds of
    // playback from 0 is `0..9`, not `0..10`.
    const end = Math.min(lastPlayedSecond, start + this.maxRange - 1);

    this.rangeStart = this.lastTime;

    if (end < start) {
      return null;
    }

    return { range: `${start}..${end}`, start, end, seconds: end - start + 1 };
  }
}

/**
 * @typedef {Object} ClientOptions
 * @property {string} account Video Cloud account id. Required.
 * @property {string} [player] Id of the player, if you have one. Optional for
 *   a non-Brightcove player, but without it the Player dimension and per-player
 *   QoE reports stay empty.
 * @property {string} [session] Session id. Defaults to a new GUID.
 * @property {string} [endpoint=ENDPOINT] Collector endpoint.
 * @property {() => number} [now] Clock, for tests.
 * @property {() => string} [destination] Page URL, for tests.
 * @property {() => string} [source] Referrer, for tests.
 * @property {(url: string) => void} [dispatch] Transport, for tests.
 * @property {(url: string) => void} [onBeacon] Called for every beacon, sent or not.
 * @property {boolean} [dryRun=false] Log beacons without sending them.
 * @property {boolean} [consent=true] Whether the viewer agreed to analytics.
 */

/**
 * Whether this page is inside a frame.
 *
 * @return {boolean}
 */
function isEmbedded() {
  try {
    return globalThis.window.top !== globalThis.window.self;
  } catch {
    return true;
  }
}

/**
 * The page the video is actually watched on.
 *
 * Inside a frame the player's own URL is an implementation detail, so the
 * embedding page is the destination. Mirrors what the Brightcove Player does.
 *
 * @return {string|undefined}
 */
function defaultDestination() {
  const document = globalThis.document;
  if (!document) {
    return undefined;
  }
  return isEmbedded() ? document.referrer : document.location.href;
}

/**
 * The page that sent the viewer to the destination.
 *
 * @return {string|null|undefined}
 */
function defaultSource() {
  const document = globalThis.document;
  if (!document) {
    return undefined;
  }
  if (!isEmbedded()) {
    return document.referrer;
  }
  try {
    return globalThis.window.parent.document.referrer || null;
  } catch {
    // The parent is on another domain, so its referrer cannot be read.
    return null;
  }
}

/**
 * @typedef {Object} Client
 * @property {string} session Session id used by every beacon.
 * @property {(event: string, params?: Object, sendOptions?: Object) => string|null} send
 * @property {(granted: boolean) => string[]} setConsent
 * @property {() => boolean} getConsent
 * @property {(value: boolean) => void} setDryRun
 * @property {() => boolean} getDryRun
 * @property {number} queueLength Beacons held back waiting for consent.
 */

/**
 * Creates the object that actually talks to the collector.
 *
 * Each `send()` produces one beacon. Beacons are sent as an image request,
 * which needs no CORS and no `fetch` keep-alive, exactly as the documentation
 * recommends. `sendBeacon` is used instead when a beacon is fired while the
 * page is being unloaded.
 *
 * @param {ClientOptions} options
 * @return {Client} The client.
 */
export function createClient(options) {
  const {
    account,
    player,
    session = createSessionId(),
    endpoint = ENDPOINT,
    now = Date.now,
    destination = defaultDestination,
    source = defaultSource,
    dispatch = defaultDispatch,
    onBeacon = () => {},
    dryRun = false,
    consent = true,
  } = options || {};

  if (!account) {
    throw new TypeError('createClient requires an account id');
  }

  /** @type {BeaconParams[]} */
  const queued = [];

  let hasConsent = consent;
  let isDryRun = dryRun;

  /**
   * Sends one beacon and returns its URL.
   *
   * @param {string} event
   * @param {Object<string, *>} [params]
   * @param {Object} [sendOptions]
   * @param {boolean} [sendOptions.unload=false] Use `sendBeacon` if available.
   * @return {string|null} The beacon URL, or null when it was queued.
   */
  function send(event, params = {}, { unload = false } = {}) {
    if (!EVENTS.has(event)) {
      throw new TypeError(`unknown event "${event}"`);
    }

    /** @type {BeaconParams} */
    const beacon = {
      account,
      player,
      domain: 'videocloud',
      event,
      time: now(),
      session,
      destination: destination(),
      source: source(),
      ...params,
    };

    if (!hasConsent) {
      queued.push(beacon);
      return null;
    }

    return emit(beacon, unload);
  }

  /**
   * @param {BeaconParams} beacon
   * @param {boolean} unload
   * @return {string}
   */
  function emit(beacon, unload) {
    const url = buildBeaconUrl(beacon, endpoint);

    onBeacon(url);

    if (!isDryRun) {
      if (unload && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(url);
      } else {
        // Without sendBeacon the image request is used even while unloading.
        // It can delay the unload, but losing the last range costs a video's
        // engagement tail, which is worse than a few extra milliseconds.
        dispatch(url);
      }
    }

    return url;
  }

  return {
    session,
    send,

    /**
     * Records the viewer's decision. Turning consent on flushes everything
     * that was held back; turning it off discards nothing already sent but
     * stops future beacons.
     *
     * @param {boolean} granted
     * @return {string[]} URLs sent by the flush.
     */
    setConsent(granted) {
      hasConsent = Boolean(granted);
      if (!hasConsent) {
        return [];
      }
      const pending = queued.splice(0, queued.length);
      return pending.map((beacon) => emit(beacon, false));
    },

    /**
     * @return {boolean}
     */
    getConsent() {
      return hasConsent;
    },

    /**
     * Switches between sending beacons and only reporting them. Use it to try
     * an integration before it starts writing to your analytics.
     *
     * @param {boolean} value
     */
    setDryRun(value) {
      isDryRun = Boolean(value);
    },

    /**
     * @return {boolean}
     */
    getDryRun() {
      return isDryRun;
    },

    /**
     * @return {number} Beacons held back waiting for consent.
     */
    get queueLength() {
      return queued.length;
    },
  };
}

/**
 * Sends a beacon by pointing an image at it. Returns nothing: the collector
 * answers with a 1x1 GIF, and no response body is ever read.
 *
 * @param {string} url
 */
function defaultDispatch(url) {
  const image = new Image(1, 1);
  image.alt = '';
  image.src = url;
}

/**
 * @typedef {Object} PlayerLike
 * @property {(type: string, handler: Function) => void} on
 * @property {(type: string, handler: Function) => void} off
 * @property {() => number} currentTime
 * @property {() => number} duration
 * @property {() => boolean} [paused]
 * @property {() => boolean} [ended]
 * @property {() => {code: number|string, message: string}|null} [error]
 * @property {() => number} [videoWidth]
 * @property {() => number} [videoHeight]
 * @property {() => number} [currentWidth]
 * @property {() => number} [currentHeight]
 * @property {(safe: boolean) => {el: () => HTMLVideoElement}} [tech]
 */

/**
 * @typedef {Object} AttachOptions
 * @property {string} video Video Cloud video id.
 * @property {string} [videoName] Video name.
 * @property {boolean} [isLive=false] Live streams send `video_seconds_viewed`.
 * @property {boolean} [qos=true] Add rebuffering and rendition data to engagement events.
 * @property {number} [engagementPeriod=10] Seconds of playback per engagement event.
 * @property {() => number} [now] Clock, for tests.
 */

/**
 * @typedef {Object} PlayerBinding
 * @property {() => string|null} sendFinalEngagement
 * @property {() => void} destroy
 */

/**
 * Binds a player to a client, translating playback into the v2 event
 * sequence: `video_impression`, `play_request`, `video_view`, and a
 * `video_engagement` every ten seconds of playback.
 *
 * Send `player_load` yourself, once per session, before the first video.
 * It marks the start of the session, so it does not belong to a per-video
 * binding.
 *
 * The player must look like a Video.js player. For another player, use
 * {@link EngagementTracker} and `client.send()` directly.
 *
 * **One binding per video.** The video id and name are captured when the
 * binding is created, so a player that loads a second video needs a new
 * binding: call `destroy()` first, which sends the range still open on the old
 * video, then attach again.
 *
 * @param {PlayerLike} player
 * @param {Client} client
 * @param {AttachOptions} options
 * @return {PlayerBinding}
 */
export function attachToPlayer(player, client, options) {
  const {
    video,
    videoName,
    isLive = false,
    qos = true,
    engagementPeriod = 10,
    now = Date.now,
  } = options || {};

  if (!video) {
    throw new TypeError('attachToPlayer requires a video id');
  }

  const tracker = new EngagementTracker({ period: engagementPeriod });

  /** @type {Map<string, Function>} */
  const handlers = new Map();

  let impressionSent = false;
  let playRequested = false;
  let viewSent = false;
  let lastDuration = 0;
  let rebufferingStartedAt = 0;
  let rebufferingCount = 0;
  let rebufferingSeconds = 0;

  /**
   * @param {string} type
   * @param {Function} handler
   */
  const on = (type, handler) => {
    player.on(type, handler);
    handlers.set(type, handler);
  };

  /**
   * A stream is live when the player has no finite duration. Checking the
   * duration as well as the option keeps a live stream from being reported as
   * VOD when the caller forgot to set `isLive`: the collector classifies any
   * request without `video_duration` as live.
   *
   * @return {boolean}
   */
  function isLiveStream() {
    if (isLive) {
      return true;
    }
    return player.duration() === Infinity;
  }

  /**
   * Returns the duration in whole seconds.
   *
   * `player.duration()` is `NaN` between a source change and the new
   * `loadedmetadata`, and an engagement sent in that window would be
   * classified as live, so the last known duration is used instead.
   *
   * @return {number|undefined} Undefined for live.
   */
  function mediaDuration() {
    if (isLiveStream()) {
      return undefined;
    }
    const duration = player.duration();
    if (Number.isFinite(duration) && duration > 0) {
      lastDuration = duration;
    }
    return lastDuration > 0 ? Math.floor(lastDuration) : undefined;
  }

  /**
   * @return {Object<string, number>} Player and rendition metrics.
   */
  function qosParams() {
    /** @type {Object<string, number>} */
    const params = {};

    const width = player.videoWidth && player.videoWidth();
    const height = player.videoHeight && player.videoHeight();
    if (Number.isFinite(width) && width > 0) {
      params.rendition_width = width;
    }
    if (Number.isFinite(height) && height > 0) {
      params.rendition_height = height;
    }

    const playerWidth = player.currentWidth && player.currentWidth();
    const playerHeight = player.currentHeight && player.currentHeight();
    if (Number.isFinite(playerWidth) && playerWidth > 0) {
      params.player_width = Math.round(playerWidth);
    }
    if (Number.isFinite(playerHeight) && playerHeight > 0) {
      params.player_height = Math.round(playerHeight);
    }

    if (rebufferingCount > 0) {
      params.rebuffering_count = rebufferingCount;
      if (rebufferingSeconds > 0) {
        // One decimal: the collector averages this, and whole seconds lose
        // every stall shorter than a second.
        params.rebuffering_seconds = Math.round(rebufferingSeconds * 10) / 10;
      }
    }

    const droppedFrames = readDroppedFrames();
    if (droppedFrames !== null) {
      params.dropped_frames = droppedFrames;
    }

    return params;
  }

  /**
   * @return {number|null}
   */
  function readDroppedFrames() {
    try {
      const tech = typeof player.tech === 'function' ? player.tech(true) : null;
      const element = tech && typeof tech.el === 'function' ? tech.el() : null;
      if (element && typeof element.getVideoPlaybackQuality === 'function') {
        return element.getVideoPlaybackQuality().droppedVideoFrames;
      }
    } catch {
      // A tech that is not an HTML5 video element has no playback quality.
    }
    return null;
  }

  /**
   * The impression carries the metadata, so it is sent once the player knows
   * the duration. Brightcove's own player already has it from the catalog at
   * `loadstart`; a generic player only learns it at `loadedmetadata`.
   */
  function sendImpression() {
    if (impressionSent) {
      return;
    }
    impressionSent = true;

    /** @type {Object<string, *>} */
    const params = { video };
    if (videoName) {
      params.video_name = videoName;
    }
    const duration = mediaDuration();
    if (duration !== undefined) {
      params.video_duration = duration;
    }

    client.send('video_impression', params);
  }

  /**
   * @param {Engagement} engagement
   * @return {Object<string, *>} Parameters for a `video_engagement` event.
   */
  function engagementParams(engagement) {
    /** @type {Object<string, *>} */
    const params = { video };

    if (isLiveStream()) {
      params.video_seconds_viewed = engagement.seconds;
    } else {
      params.range = engagement.range;
      params.video_duration = mediaDuration();
    }

    if (qos) {
      Object.assign(params, qosParams());
    }

    return params;
  }

  /**
   * Sends the current range as a `video_engagement` event and starts a new
   * measurement period, so rebuffering is counted once.
   *
   * @param {Engagement|null} engagement
   * @param {boolean} [unload=false]
   * @return {string|null}
   */
  function sendEngagement(engagement, unload = false) {
    if (!engagement) {
      return null;
    }

    const url = client.send('video_engagement', engagementParams(engagement), { unload });

    rebufferingCount = 0;
    rebufferingSeconds = 0;

    return url;
  }

  on('loadstart', () => {
    // A source change ends the previous video's measurement period. The id and
    // the duration both still describe the old video here, which is what the
    // range belongs to.
    sendEngagement(tracker.stop());
    impressionSent = false;
    playRequested = false;
    viewSent = false;
    lastDuration = 0;
    rebufferingStartedAt = 0;
    rebufferingCount = 0;
    rebufferingSeconds = 0;
  });

  on('loadedmetadata', () => {
    sendImpression();
  });

  on('play', () => {
    // A programmatic play() can beat loadedmetadata, so make sure the
    // impression is never sent after the view.
    sendImpression();

    if (!playRequested) {
      playRequested = true;
      client.send('play_request', { video, video_duration: mediaDuration() });
    }
  });

  /**
   * Ends the stall that is in progress, if any, adding the time it took.
   * The stall itself was counted when `waiting` fired.
   */
  function endStall() {
    if (!rebufferingStartedAt) {
      return;
    }
    rebufferingSeconds += (now() - rebufferingStartedAt) / 1000;
    rebufferingStartedAt = 0;
  }

  on('playing', () => {
    endStall();

    sendImpression();

    // Safari fires `playing` with `paused` still true when autoplay is
    // refused, and a view for a video that never started is a phantom view.
    if (typeof player.paused === 'function' && player.paused()) {
      return;
    }

    tracker.start(player.currentTime());

    if (!viewSent) {
      viewSent = true;
      client.send('video_view', { video, video_name: videoName, video_duration: mediaDuration() });
    }
  });

  on('waiting', () => {
    // Repeated `waiting` events describe one stall, so keep the first start.
    // The count goes up here, not when playback resumes, so a viewer who seeks
    // out of a stall still counts as having stalled.
    if (!rebufferingStartedAt) {
      rebufferingStartedAt = now();
      rebufferingCount += 1;
    }
  });

  on('timeupdate', () => {
    sendEngagement(tracker.tick(player.currentTime()));
  });

  on('seeking', () => {
    // A seek ends the stall in progress. The count was taken when `waiting`
    // fired, so a viewer who seeks out of a stall still counts as having
    // stalled.
    endStall();
    sendEngagement(tracker.seek(player.currentTime()));
  });

  on('pause', () => {
    // A stall that ends in a pause would otherwise be charged the whole
    // paused interval when playback resumes.
    endStall();

    if (typeof player.ended === 'function' && player.ended()) {
      return;
    }
    sendEngagement(tracker.stop(player.currentTime()));
  });

  on('ended', () => {
    sendEngagement(tracker.stop(player.duration()));
  });

  on('error', () => {
    const error = typeof player.error === 'function' ? player.error() : null;
    client.send('error', {
      video,
      error_code: errorCode(error),
    });
  });

  return {
    /**
     * Sends whatever range is still open, using `sendBeacon` so it survives
     * the page going away. Call it from a `pagehide` listener.
     *
     * @return {string|null}
     */
    sendFinalEngagement() {
      return sendEngagement(tracker.stop(player.currentTime()), true);
    },

    /**
     * Unbinds the player. Any open range is sent first: swapping sources
     * through `destroy()` must not lose the seconds watched on the old one.
     */
    destroy() {
      sendEngagement(tracker.stop(player.currentTime()));

      for (const [type, handler] of handlers) {
        player.off(type, handler);
      }
      handlers.clear();
    },
  };
}

/**
 * Maps a `MediaError.code` to the name the collector expects.
 *
 * @param {{code: number|string}|null} error
 * @return {string}
 */
function errorCode(error) {
  if (!error || error.code === undefined || error.code === null) {
    return 'UNKNOWN';
  }

  const names = {
    1: 'MEDIA_ERR_ABORTED',
    2: 'MEDIA_ERR_NETWORK',
    3: 'MEDIA_ERR_DECODE',
    4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
  };

  return names[error.code] || String(error.code);
}


