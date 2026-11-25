# Third-Party Notices

Krypt Editor is free and open source (MIT) and is based on **OpenCut** (MIT).
It bundles and/or downloads the following third-party software and models. Each
is the property of its respective owner and is used under the license shown.

> This list covers the primary runtime dependencies. Run a full license audit
> (e.g. `npx license-checker --production --summary`) before each release to
> regenerate a complete manifest.

## Bundled libraries

| Component | License |
| --- | --- |
| React, React-DOM | MIT |
| Zustand | MIT |
| lucide-react | ISC |
| react-resizable-panels | MIT |
| @hello-pangea/dnd | Apache-2.0 |
| mediabunny (encode/decode/mux) | MPL-2.0 |
| three.js (the 3D character of the drawn visual styles) | MIT |
| onnxruntime-web | MIT |
| @huggingface/transformers (transformers.js) | Apache-2.0 |
| @mediapipe/tasks-vision | Apache-2.0 |
| pdf.js (`pdfjs-dist`, slide import) | Apache-2.0; ships with Adobe CMaps (BSD-3-Clause), the Foxit and Liberation standard fonts (BSD-3-Clause / SIL OFL 1.1), and the OpenJPEG (BSD-2-Clause), PDFium JBIG2 (BSD-3-Clause) and qcms (MIT) decoders. Their licence files are in `pdfjs/` beside the app's web files. |
| discord-rpc | MIT |
| zod (checks what an AI agent sends) | MIT |
| @modelcontextprotocol/server (the AI agent connection) | Apache-2.0 |
| CMU Pronouncing Dictionary (English pronunciations for text to speech; `src/editor/kokoro/cmudict.txt.deflate`) | BSD-style (Carnegie Mellon University; see `src/editor/kokoro/CMUDICT-LICENSE.txt`) |

The MPL-2.0 source for mediabunny is available from its project repository; per
MPL-2.0 the modified files (if any) and the license text accompany this build.

## AI models (downloaded on first use, then cached)

| Model | Source | License |
| --- | --- | --- |
| Whisper `whisper-base` / `whisper-base.en` (auto-captions) | Hugging Face (`Xenova/whisper-base*`) | MIT (OpenAI Whisper) |
| Kokoro-82M v1.0 and its 28 English voices (English text to speech) | Hugging Face (`onnx-community/Kokoro-82M-v1.0-ONNX`, pinned revision; SHA-256 checked) | Apache-2.0 (hexgrad) |
| MMS-TTS per-language voices (Spanish, French, German, Portuguese and Korean text to speech) | Hugging Face (`Xenova/mms-tts-*`) | CC-BY-NC-4.0 (Meta MMS) |
| MediaPipe Selfie Segmenter (AI background removal) | Google MediaPipe models | Apache-2.0 |
| MediaPipe Face Detector, BlazeFace short-range (auto reframe) | Google MediaPipe models | Apache-2.0 |
| DreamShaper 8 LCM, text encoder and UNet (pictures from words, the better model; downloaded only when you press Download in Settings) | Hugging Face (`skillsafeai/dreamshaper-8-lcm-onnx-webgpu`, pinned revision; SHA-256 checked) | CreativeML Open RAIL-M (DreamShaper 8 by Lykon, on Stable Diffusion 1.5; LCM distillation) |
| SDXS-512 DreamShaper, text encoder and UNet (pictures from words, the small model; downloaded only when you press Download in Settings) | Hugging Face (`skillsafeai/sdxs-512-dreamshaper-onnx-webgpu`, pinned revision; SHA-256 checked) | CreativeML Open RAIL++-M (SDXS by IDKiro) |
| TAESD decoder (turns either picture model's result into pixels) | the SDXS repository above | MIT (TAESD by madebyollin) |
| CLIP ViT-L/14 tokenizer vocabulary (`vocab.json`, `merges.txt`) | the two repositories above | MIT (OpenAI CLIP) |

The two picture models come with use restrictions that pass on to whoever uses
them, and so to you: the OpenRAIL licences forbid, among other things, making
pictures that break the law, that harm or exploit minors, that defame or harass
a person, or that spread personal information or false information meant to
harm. The pictures you make are yours to use, also in videos you earn from; the
licences ask nothing of the output beyond those restrictions. Read the full
terms at huggingface.co/spaces/CompVis/stable-diffusion-license and
huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md.

Pictures made by a service with your own key (OpenAI, Google, xAI or another)
are made under that service's terms, not these.

These models are fetched from the Hugging Face and Google CDNs only when you
invoke the corresponding feature (the picture models only when you press
Download), and are cached locally afterward. No analytics
or telemetry is collected by Krypt Editor itself.

## FFmpeg

Krypt Editor does not include FFmpeg. When an FFmpeg installation is found on
the computer, the app runs it as a separate program to convert footage it
cannot decode by itself. FFmpeg is licensed under the LGPL/GPL by its authors;
see https://ffmpeg.org/legal.html.

## Fonts

Chakra Petch, JetBrains Mono, and Press Start 2P (SIL Open Font License) are
bundled in `public/fonts` so the app renders identically offline.
