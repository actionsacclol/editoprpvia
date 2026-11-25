import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/**
 * pdf.js, loaded only when a slide deck is imported (slides.ts imports this
 * file dynamically, so the library stays out of the main bundle). The fonts,
 * character maps and decoders it fetches on demand are copied next to the app
 * by the build (vite.config.ts → pdfjs/).
 */
GlobalWorkerOptions.workerSrc = workerUrl;

const assetDir = (dir: string): string => new URL(`pdfjs/${dir}/`, document.baseURI).href;

export interface PdfLine {
  text: string;
  /** Type size in PDF points: the biggest line on a slide is usually its title. */
  size: number;
}

export interface PdfPage {
  page: number;
  width: number;
  height: number;
  png: Uint8Array;
  lines: PdfLine[];
}

export interface OpenPdf {
  pages: number;
  /** Render page n (1-based) about `height` pixels tall and read its text. */
  render: (n: number, height: number) => Promise<PdfPage>;
  close: () => Promise<void>;
}

const MAX_SIDE = 4096;

export async function openPdf(data: Uint8Array): Promise<OpenPdf> {
  const task = getDocument({
    data,
    cMapUrl: assetDir('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assetDir('standard_fonts'),
    wasmUrl: assetDir('wasm'),
    iccUrl: assetDir('iccs'),
  });
  const doc = await task.promise;
  return {
    pages: doc.numPages,
    render: async (n, height) => {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(height / base.height, MAX_SIDE / base.width, MAX_SIDE / base.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      // Slides with no page background are white on paper; keep them so.
      await page.render({ canvas, viewport, background: '#ffffff' }).promise;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error(`Could not render page ${n}.`);
      const png = new Uint8Array(await blob.arrayBuffer());

      const content = await page.getTextContent();
      const lines: PdfLine[] = [];
      let text = '';
      let size = 0;
      const flush = (): void => {
        if (text.trim()) lines.push({ text: text.replace(/\s+/g, ' ').trim(), size });
        text = '';
        size = 0;
      };
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str;
        if (item.str.trim()) size = Math.max(size, item.height || Math.abs(item.transform[3] as number) || 0);
        if (item.hasEOL) flush();
      }
      flush();
      const out: PdfPage = { page: n, width: canvas.width, height: canvas.height, png, lines };
      page.cleanup();
      canvas.width = canvas.height = 0;
      return out;
    },
    close: async () => {
      await task.destroy();
    },
  };
}
