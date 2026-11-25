import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import rendererPlugin from 'vite-plugin-electron-renderer';
import path from 'node:path';
import fs from 'node:fs';

// Content-Security-Policy for the packaged app only (dev keeps Vite/HMR + React
// Fast Refresh working). Allows our own assets + the krypteditor:// scheme,
// wasm (onnxruntime/MediaPipe), and the CDNs the optional ML/font features use.
function cspPlugin(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' krypteditor: data: blob:",
    "media-src 'self' krypteditor: data: blob:",
    "connect-src 'self' krypteditor: https://huggingface.co https://*.huggingface.co https://cdn-lfs.huggingface.co https://cdn.jsdelivr.net https://storage.googleapis.com data: blob:",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');
  return {
    name: 'krypt-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('</head>', `    <meta http-equiv="Content-Security-Policy" content="${csp}" />\n  </head>`);
    },
  };
}

// pdf.js (slide import) fetches fonts, character maps and image decoders on
// demand. They ship next to the app as pdfjs/<dir>/, and the dev server hands
// them out from node_modules.
function pdfAssetsPlugin(): Plugin {
  const root = path.resolve(__dirname, 'node_modules/pdfjs-dist');
  const dirs = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];
  // The scripting sandbox is for interactive PDF forms; slides never run it.
  const wanted = (f: string): boolean => !/^quickjs/.test(f);
  return {
    name: 'krypt-pdf-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        const file = path.join(root, rel);
        if (!dirs.some((d) => rel.startsWith(`${d}/`)) || !file.startsWith(root) || !fs.existsSync(file)) return next();
        res.setHeader('Content-Type', 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const d of dirs) {
        for (const f of fs.readdirSync(path.join(root, d)).filter(wanted)) {
          this.emitFile({ type: 'asset', fileName: `pdfjs/${d}/${f}`, source: fs.readFileSync(path.join(root, d, f)) });
        }
      }
    },
  };
}

// Krypt Editor renders a single main UI window. The main process owns local
// media access (the krypteditor:// protocol streams clips into the renderer)
// and Discord presence. discord-rpc is a CommonJS dep that MUST stay external
// from Vite/Rollup or the bundler trips over its native-ish transport.

export default defineConfig({
  plugins: [
    cspPlugin(),
    pdfAssetsPlugin(),
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            sourcemap: true,
            rollupOptions: {
              external: ['discord-rpc'],
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload();
        },
        vite: { build: { outDir: 'dist-electron', sourcemap: true } },
      },
    ]),
    rendererPlugin(),
  ],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
      // Force the browser build of transformers.js. The renderer plugin adds
      // Node resolution, which would otherwise pull the Node build (onnxruntime-
      // node / sharp / fs) and crash captions in the browser renderer.
      '@huggingface/transformers': path.resolve(__dirname, 'node_modules/@huggingface/transformers/dist/transformers.web.js'),
      // transformers.js asks for ORT's new native WebGPU backend. The default
      // bundle's JS WebGPU backend (JSEP, what Kokoro runs on) is faster here:
      // measured on Electron 45, Whisper base 57-60 s vs 67 s for a 6-min clip,
      // large-v3-turbo the same (~88 s). It also runs the CPU path.
      'onnxruntime-web/webgpu': path.resolve(__dirname, 'node_modules/onnxruntime-web/dist/ort.bundle.min.mjs'),
    },
  },
  // It's a prebuilt browser bundle; skip dev pre-bundling (esbuild chokes on it).
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  // The caption worker dynamically imports transformers.js (code-splitting),
  // which the default iife worker format can't express.
  worker: { format: 'es' },
  build: {
    rollupOptions: {
      // Single renderer entry — the main editor UI.
      input: {
        main: path.resolve(__dirname, 'index.html'),
      },
    },
  },
  server: {
    port: 5182,
    strictPort: true,
  },
  clearScreen: false,
});
