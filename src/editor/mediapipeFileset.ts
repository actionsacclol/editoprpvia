import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';

/**
 * MediaPipe's WASM runtime, bundled with the app: the packaged CSP only runs
 * our own scripts, so the CDN copy FilesetResolver would fetch is blocked.
 * Shared by background removal (segmenter.ts) and auto reframe (reframe.ts).
 */
export const MEDIAPIPE_FILESET = { wasmLoaderPath, wasmBinaryPath };
