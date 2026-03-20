# Motion Canvas WebCodecs

A blazingly fast Motion Canvas exporter that leverages WebCodecs API with [Mediabunny](https://mediabunny.dev/) for native browser rendering. The exporter has customizable options such as codecs, bitrate, and audio support. No extra back-end, no ffmpeg, just a small 10 kB package.

Now works out of the box with programmable audios in Motion Canvas `v3.18.0-alpha.0` version!

<img width="584" height="219" alt="image" src="https://github.com/miseya/motion-canvas-webcodecs/blob/master/docs/review.webp?raw=true" />

## Usage

1. Install the package

   ```
   npm i motion-canvas-webcodecs
   ```

3. Import `WebCodecsExporter` to your projects `makeProject`.

   ```ts
   import { makeProject } from '@motion-canvas/core'
   import example from './scenes/example-scene?scene'
   import WebCodecsExporter from 'motion-canvas-webcodecs'
   import audio from '../assets/my-song.mp3'

   export default makeProject({
     plugins: [
       WebCodecsExporter(),
     ],
     scenes: [example],
     audio
   })
   ```

## Preview

By default, the video will be rendered with AVC (H.264) and OPUS for the audio. This setting is recommended for compatibility.

<img width="389" height="365" alt="image" src="https://github.com/miseya/motion-canvas-webcodecs/blob/master/docs/settings.webp?raw=true" />

## Batch Rendering (Experimental)

Batch rendering can split the target frame range into multiple segments and render
them in parallel before stitching a single final MP4.

Configure in exporter settings:

- `enable batch rendering`
- `max parallel segments`

Notes:

- Batch rendering is opt-in and disabled by default.
- Segment partitioning is computed automatically from animation duration and
  parallelism settings.
- Video stitching uses packet-level remux (no full decode/re-encode pass).
- Remux validation is strict; incompatible or corrupt segment outputs fail fast.
- Audio is mixed centrally during stitching for continuity across segment boundaries.
- Segment rendering currently runs in the browser tab (no worker isolation yet).

## Compatibility

This package targets both stable and alpha Motion Canvas cores.

- Stable core (`3.17.x`): project audio is supported; programmable scene sounds are
  not available and are skipped with a warning in batch mode.
- Alpha core (`3.18.0-alpha.0+`): project audio and programmable scene sounds are
  both included.

If a programmable-sound API is unavailable, rendering continues instead of failing.

## Programmable Audio

<img alt="image" src="https://github.com/miseya/motion-canvas-webcodecs/blob/master/docs/alpha.webp?raw=true" />

```ts
import { Rect, makeScene2D } from '@motion-canvas/2d';
import { all, createRef, easeInExpo, easeInOutExpo, sound, waitFor } from '@motion-canvas/core';
import bookAudio from '../audios/book.mp3';

const book = sound(bookAudio);

export default makeScene2D(function* (view) {
  const rect = createRef<Rect>();

  view.add(
    <Rect ref={rect} size={320} radius={80} smoothCorners fill={'#f3303f'} />,
  );

  yield* waitFor(0.3);
  yield* all(
    rect().rotation(90, 1, easeInOutExpo),
    rect().scale(2, 1, easeInOutExpo),
  );
  yield* rect().scale(1, 0.6, easeInExpo);
  rect().fill('#ffa56d');
  book.play();
  yield* all(rect().ripple(1), rect().fill('#f3303f', 1));
  yield* waitFor(2);
});
```

## Acknowledgements

Using the WebCodecs API won't be easier without [Mediabunny](https://mediabunny.dev/). Check it out!

## License

MIT
