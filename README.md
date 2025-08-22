# Motion Canvas WebCodecs

A blazingly fast* Motion Canvas exporter that leverages WebCodecs API for native browser rendering. The exporter has customizable options such as codecs, bitrate, and audio support. No extra back-end, no ffmpeg, just a small 10 kB package.

*maybe someone could provide comparisons here :P

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

<img width="389" height="365" alt="image" src="https://github.com/user-attachments/assets/55daacd6-bb73-44fa-b24e-8c3fe4cb7a46" />

## License

MIT
