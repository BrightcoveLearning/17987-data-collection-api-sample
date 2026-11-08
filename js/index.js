/* global videojs */

/**
 * Demo page for {@link module:data-collection}.
 *
 * It plays two videos from a Video Cloud account with Video.js, and sends the
 * Data Collection API v2 events that a Brightcove Player would send. Swap
 * Video.js for your own player and `attachToPlayer()` for the matching glue,
 * and the beacons are identical.
 */

import { attachToPlayer, createClient } from './data-collection.js';

/**
 * Account the demo videos live in. These are Brightcove's public sample
 * videos, so the beacons this page sends land in that account's analytics.
 * Point this at your own account when you adapt the sample.
 *
 * @type {string}
 */
const ACCOUNT = '1752604059001';

/**
 * A public player on that account, used only to read its policy key. Playback
 * API requests need a policy key, and a player's config is where a web page
 * legitimately gets one.
 *
 * @type {string}
 */
const PLAYER_CONFIG = `https://players.brightcove.net/${ACCOUNT}/default_default/config.json`;

/**
 * Playback API root.
 *
 * @type {string}
 */
const PLAYBACK_API = `https://edge.api.brightcove.com/playback/v1/accounts/${ACCOUNT}/videos`;

/**
 * The videos the demo cycles through. Media URLs are fetched at runtime
 * instead of being hardcoded: Dynamic Delivery URLs are signed and expire, so
 * a hardcoded one stops working within days.
 *
 * @type {Array<{id: string, name: string}>}
 */
const VIDEOS = [
  { id: '1813004333199906787', name: 'EarthSample' },
  { id: '1813179710869239477', name: 'Navigating Video Cloud Studio' },
];

const logElement = document.querySelector('#event-log');
const statsElement = document.querySelector('#stats');
const titleElement = document.querySelector('#current-video');
const dryRunToggle = document.querySelector('#dry-run');
const changeVideoButton = document.querySelector('#change-video');

/** @type {Record<string, number>} */
const counts = {};

const player = videojs('player', {
  controls: true,
  preload: 'metadata',
  fluid: true,
  playbackRates: [0.5, 1, 1.5, 2],
});

/**
 * Adds a line to the event log.
 *
 * @param {string} name
 * @param {string} detail
 * @param {string} [kind]
 */
function appendRow(name, detail, kind = 'beacon') {
  const row = document.createElement('div');
  row.className = `event event--${kind}`;

  const heading = document.createElement('span');
  heading.className = 'event__name';
  heading.textContent = name;

  const body = document.createElement('code');
  body.className = 'event__url';
  body.textContent = detail;

  row.append(heading, body);
  logElement.prepend(row);
}

/**
 * Renders one beacon in the event log and keeps the counters up to date.
 *
 * @param {string} url
 */
function onBeacon(url) {
  const params = new URL(url).searchParams;
  const event = params.get('event') || 'unknown';
  const time = Number(params.get('time'));
  const clock = new Date(time).toLocaleTimeString([], { hour12: false });

  counts[event] = (counts[event] || 0) + 1;

  // Show the query exactly as it went out, minus percent-encoding.
  const rawQuery = url.slice(url.indexOf('?') + 1);
  let query = rawQuery;
  try {
    query = decodeURIComponent(rawQuery);
  } catch {
    // A malformed escape is not worth losing the line over.
  }

  appendRow(`${clock}  ${event}`, query);
  statsElement.textContent = Object.entries(counts)
    .map(([name, value]) => `${name}: ${value}`)
    .join('  ·  ');
}

/**
 * @param {string} message
 */
function logError(message) {
  appendRow('error', message, 'error');
}

const client = createClient({ account: ACCOUNT, onBeacon });

// One session per page load. This has to come before any video event.
client.send('player_load');

/** @type {ReturnType<typeof attachToPlayer>|null} */
let binding = null;

/** @type {Promise<string>|null} */
let policyKeyPromise = null;

/**
 * @return {Promise<string>} The account's policy key.
 */
function getPolicyKey() {
  if (!policyKeyPromise) {
    policyKeyPromise = fetch(PLAYER_CONFIG)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`player config: HTTP ${response.status}`);
        }
        return response.json();
      })
      .then((config) => config.video_cloud.policy_key);
  }
  return policyKeyPromise;
}

/**
 * Picks a source Video.js can play: adaptive HLS if the account offers it,
 * otherwise the progressive MP4.
 *
 * @param {Array<Object>} sources
 * @return {{src: string, type: string}}
 */
function pickSource(sources) {
  const playable = sources.filter((source) => source.src.startsWith('https://'));
  const hls = playable
    .filter((source) => source.type === 'application/x-mpegURL')
    .sort((a, b) => Number(b.ext_x_version || 0) - Number(a.ext_x_version || 0))[0];

  if (hls) {
    return { src: hls.src, type: hls.type };
  }

  const mp4 = playable.find((source) => source.container === 'MP4');
  if (mp4) {
    return { src: mp4.src, type: 'video/mp4' };
  }

  throw new Error('no playable source');
}

/**
 * @param {{id: string, name: string}} video
 * @return {Promise<Object>} Playback API response.
 */
async function fetchVideo(video) {
  const policyKey = await getPolicyKey();
  const response = await fetch(`${PLAYBACK_API}/${video.id}`, {
    headers: { 'BCOV-Policy': policyKey },
  });

  if (!response.ok) {
    throw new Error(`Playback API: HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Loads a video into the player and rebinds the collector to it.
 *
 * @param {number} index
 */
async function showVideo(index) {
  const video = VIDEOS[index];
  titleElement.textContent = video.name;

  try {
    const metadata = await fetchVideo(video);

    if (metadata.poster) {
      player.poster(metadata.poster);
    }

    // Rebind before the new source starts loading, so the first loadstart is
    // seen by the binding.
    if (binding) {
      binding.destroy();
    }
    binding = attachToPlayer(player, client, {
      video: metadata.id,
      videoName: metadata.name,
    });

    player.src(pickSource(metadata.sources));
    player.play().catch(() => {
      // Autoplay can be refused; the viewer can press play.
    });
  } catch (error) {
    logError(error.message);
  }
}

player.ready(() => {
  showVideo(0);
});

let current = 0;
changeVideoButton.addEventListener('click', () => {
  current = (current + 1) % VIDEOS.length;
  showVideo(current);
});

dryRunToggle.addEventListener('change', () => {
  client.setDryRun(dryRunToggle.checked);
  document.body.classList.toggle('is-dry-run', dryRunToggle.checked);
});

// Flush the open engagement range before the page goes away.
window.addEventListener('pagehide', () => {
  if (binding) {
    binding.sendFinalEngagement();
  }
});
