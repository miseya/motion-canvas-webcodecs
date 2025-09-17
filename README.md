# Motion Canvas WebCodecs

A blazingly fast Motion Canvas exporter that leverages WebCodecs API for native browser rendering. The exporter has customizable options such as codecs, bitrate, and audio support. No extra back-end, no ffmpeg, just a small 10 kB package.

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
  import audio from '../assets/hanabi.mp3'

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

## License

MIT
