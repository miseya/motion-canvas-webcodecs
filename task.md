# Task: Parallel Batch Rendering for Motion Canvas

## Phase 1: Research & Planning
- [x] Explore codebase structure (packages: core, ffmpeg, player, 2d, etc.)
- [x] Read Renderer.ts - understand range-based rendering
- [x] Read PlaybackManager.ts - understand seek/progress/recalculate
- [x] Read Stage.ts - DOM canvas + WebGL constraints
- [x] Read Scene.ts / GeneratorScene.ts - scene lifecycle
- [x] Read Exporter.ts / FFmpegExporterClient.ts - exporter interface
- [x] Read bootstrap.ts / Project.ts - project loading
- [x] Read SharedWebGLContext.ts - WebGL DOM dependencies
- [x] Write implementation plan and request review

## Phase 2: Core Infrastructure
- [x] Create batch render orchestrator (job scheduler + segment splitter) → [batch-renderer.ts](file:///home/seya/code/motion-canvas/motion-canvas-webcodecs/src/batch-renderer.ts)
- [x] Create segment exporter → [segment-exporter.ts](file:///home/seya/code/motion-canvas/motion-canvas-webcodecs/src/segment-exporter.ts)
- [x] Create worker contract types → [batch-types.ts](file:///home/seya/code/motion-canvas/motion-canvas-webcodecs/src/batch-types.ts)
- [x] Integrate BatchRenderer into WebCodecsExporter UI
- [ ] HeadlessStage / OffscreenCanvas abstraction (Phase 4)

## Phase 3: Worker Architecture
- [ ] Implement RenderWorker (loads project, renders [start,end] range)
- [ ] Implement job input/output contracts (TypeScript types)
- [ ] Wire project artifact loading in worker context
- [ ] Handle asset access in worker contexts (font, images, audio)

## Phase 4: Audio Strategy
- [ ] Implement per-segment audio collection
- [x] Implement centralized audio mux step

## Phase 5: Segment Stitching
- [x] Implement segment validator / orderer
- [ ] Implement container-level concat or remux step
- [ ] Implement final output writer using mediabunny

## Phase 6: Testing
- [ ] Correctness test: single worker == sequential output
- [ ] Correctness test: multi-worker == single-worker
- [ ] Determinism test: same range renders identically across runs
- [ ] Stress test: heavy animations, audio, scene transitions
