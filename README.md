# 17987-data-collection-api-sample

Send Brightcove Analytics events for video played **outside** a Brightcove
Player, using the [Data Collection API v2](https://apis.support.brightcove.com/data-collection/getting-started/overview-data-collection-api-v2.html).

> **Do not use this with a Brightcove Player or a Brightcove Native SDK.** They
> already send these beacons. Adding your own duplicates every view, impression
> and second watched.

## Run it

```bash
npm start          # serves the page on http://localhost:8080
npm test           # unit tests, no dependencies, Node 18+
```

The page has to be served over HTTP: it fetches its video from the Playback
API, and `fetch()` does not work from a `file://` page.

Playing the videos writes analytics to account `1752604059001`, which is
Brightcove's public sample account. Tick **Dry run** to watch the requests
without sending them, and point `ACCOUNT` in `js/index.js` at your own account
when you adapt the sample.

## Files

| File | Description |
| --- | --- |
| `js/data-collection.js` | The client. Dependency-free ES module, no build step, JSDoc types. |
| `js/index.js` | Demo wiring: Video.js 8, Playback API, event log. |
| `index.html` | The sample as a working page. |
| `css/style.css` | Styles for the page. Not needed to send beacons. |
| `test/data-collection.test.js` | Unit tests for the URL builder, the range tracker and the event sequence. |

`js/data-collection.js` imports nothing and expects nothing but a browser, so
it can be copied into any project as-is. It is deliberately plain JavaScript
with JSDoc rather than TypeScript, matching how the analytics plugin inside the
Brightcove Player is written; `tsc` can emit `.d.ts` files from the JSDoc if you
want types in a TypeScript project.

## The events

One session per page load, one `session` id on every beacon, and this order per
video:

| Event | Sent when | Extra parameters |
| --- | --- | --- |
| `player_load` | Once, before the first video. | |
| `video_impression` | The player knows the video's duration (`loadedmetadata`). | `video`, `video_name`, `video_duration` |
| `play_request` | Playback is requested, by the viewer or by autoplay (`play`). | `video`, `video_duration` |
| `video_view` | The first frame is rendered (`playing`), and the player is not paused. Sent once per video. | `video`, `video_name`, `video_duration` |
| `video_engagement` | Every 10 seconds of playback, on pause, on seek, on `ended` and on `pagehide`. | `video`, `range`, `video_duration`, plus QoE |
| `error` | The player reports a fatal error. | `video`, `error_code` |

`video_engagement` also carries the QoE parameters Studio's Quality of
Experience report reads: `rebuffering_count`, `rebuffering_seconds`,
`rendition_width`, `rendition_height`, `player_width`, `player_height` and
`dropped_frames`.

Ranges are `start..end` with both ends inclusive, so ten seconds of playback
from the start is `0..9`, not `0..10`. Pauses, seeks and source changes each
close the current range and open a new one, so a seek never counts as watched
time, and a range never exceeds the 20 seconds the collector accepts.

Live streams send `video_seconds_viewed` instead of `range` and
`video_duration`. That happens automatically when the player reports an
infinite duration; pass `isLive: true` to `attachToPlayer()` if yours does not.

## Parameters

Every beacon carries these:

| Parameter | Value |
| --- | --- |
| `account` | Video Cloud account id. |
| `player` | Id of the player, if you configured one. Optional, but Player reports stay empty without it. |
| `domain` | `videocloud`. |
| `event` | The event name. |
| `time` | Epoch milliseconds. |
| `session` | Random UUID, constant for the page. |
| `destination` | `location.href`. |
| `source` | `document.referrer`. Omitted when empty, which the collector reads as direct traffic. |

`video` is always the **video id**, never a reference id. The collector stores
whatever it is given, so a reference id there produces a video that exists in
analytics and nowhere else. Resolve it first with the Playback API
(`/videos/ref:{reference_id}`) or the CMS API (`?q=reference_id:{value}`).

Beacons longer than 4000 characters are shortened: parameters that are not
essential are dropped and `usage=lbu` is added, so Brightcove can count how
often it happens.

## Using another player

`attachToPlayer()` expects a Video.js-shaped player: `on`, `off`,
`currentTime()`, `duration()`. For anything else, drive the two lower layers
yourself.

```js
import { createClient, EngagementTracker } from './data-collection.js';

const client = createClient({ account: '1234567890', player: 'my-player' });
const tracker = new EngagementTracker();

client.send('player_load');

myPlayer.addEventListener('loadedmetadata', () => {
  client.send('video_impression', { video: '9876543210', video_duration: myPlayer.duration });
});

myPlayer.addEventListener('playing', () => {
  tracker.start(myPlayer.currentTime);
  client.send('video_view', { video: '9876543210' });
});

myPlayer.addEventListener('timeupdate', () => {
  const engagement = tracker.tick(myPlayer.currentTime);
  if (engagement) {
    client.send('video_engagement', {
      video: '9876543210',
      range: engagement.range,
      video_duration: myPlayer.duration,
    });
  }
});

myPlayer.addEventListener('pause', () => {
  const engagement = tracker.stop(myPlayer.currentTime);
  if (engagement) {
    client.send('video_engagement', {
      video: '9876543210',
      range: engagement.range,
      video_duration: myPlayer.duration,
    });
  }
});
```

`createClient()` also takes `dryRun`, `consent`, `onBeacon` (called with every
URL, sent or not) and `dispatch`, which is what the tests use instead of a real
image request.

`attachToPlayer()` captures the video id and name when it is created, so create
one per video: call `destroy()` before loading the next one. `destroy()` sends
the range still open on the old video first.

## License

MIT. See [LICENSE](LICENSE).
