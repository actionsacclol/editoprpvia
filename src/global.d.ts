/// <reference types="vite/client" />
import type { KryptApi } from '@shared/types';

declare global {
  interface Window {
    krypt: KryptApi;
  }
}

// Vite asset-URL imports (e.g. the ONNX runtime wasm/mjs for captions).
declare module '*?url' {
  const url: string;
  export default url;
}

export {};
