# src/editor

The editor core (originally seeded from OpenCut, MIT — now substantially its
own code). The shell mounts it from `src/pages/Editor.tsx`.

Map:

- `timelineStore.ts` — the document: tracks, clips (media/text/shape/draw),
  keyframes, transitions, undo history, and the pure evaluation helpers
  (`clipLayout`, `activeVisualLayers`, `transitionPart`, `textAnim`, …) shared
  by preview and export. Clip animation (`animIn` / `animOut` / `motion`) is
  evaluated here at render time, not baked into keyframes: add a new one in
  `animPart` / `motionPart` and both renderers get it.
- `mediaStore.ts` — the session media bin; timeline clips reference bin
  entries by media id.
- `Preview.tsx` — live DOM/CSS compositor (one layer per visible clip; WebGL
  passes for chroma key / shader effects / background removal).
- `Timeline.tsx` — tracks, clip blocks, filmstrips/waveforms, snapping,
  marquee select, transition seams.
- `Inspector.tsx` — the properties panel, including keyframe sliders.
- `export.ts` — renders the timeline frame-by-frame onto a canvas and encodes
  via mediabunny/WebCodecs (decoded VideoFrames are drawn directly; a scratch
  canvas only when an effect needs pixels); audio is mixed in an
  OfflineAudioContext (speed-changed clips are pitch-preserved via
  `stretch.ts`), decoding only the span each file is used for.
- `passthrough.ts` — the export shortcut: one untouched H.264 clip covering
  the whole timeline at the source's size and frame rate has its packets
  copied into the MP4 instead of being decoded and re-encoded.
- `previewSync.ts` — how a preview element follows the playhead: paused =
  exact seek (one at a time, newest wins); playing = small playback-rate
  steering for drift under 0.3 s, a hard seek past it. Pure and unit-tested.
- `ingest.ts` / `electron/system/convert.ts` — import check and conversion.
  `probe.ts` must see a decoded first frame *and* ask the export decoder
  (`canDecode`), because preview (media element) and export (WebCodecs)
  decode through different paths. What fails is converted by an FFmpeg found
  on the computer (never bundled) into `userData/MediaCache/Converted`; the
  bin entry keeps its id and gains `sourcePath`.
- `proxy.ts` — preview copies for video above 1080p (1280 long side, keyframe
  every 0.5 s, same timestamps), built one at a time with mediabunny into
  `userData/MediaCache/Proxies`. Preview and filmstrips use them; export
  never does.
- `audioFx.ts` / `previewAudio.ts` / `LevelMeter.tsx` — per-clip EQ, low cut,
  compressor and pan. One chain builder serves both the preview's Web Audio
  graph and the export's offline mix, so they can't disagree. The meter reads
  the mix before the monitor volume.
- `syncSound.ts` — sync by sound: loudness-rhythm envelopes of both clips,
  FFT cross-correlation at 10 ms, refined to 1 ms. A match must stand well
  above the field *and* clear of the runner-up (`soundMatches`), since
  unrelated recordings always produce some peak. A moved clip hops to a free
  track when its own is taken at the new spot.
- `audioDecode.ts` — streaming audio decode (mediabunny) with a polyphase
  windowed-sinc resampler: mono 16 kHz for Whisper, 48 kHz AudioBuffers for
  the export mix, and single-pass waveform peaks + loudness envelope. Holds
  only the output, never the whole file decoded (`decodeAudioData` couldn't
  open multi-GB recordings); falls back to it for formats mediabunny can't read.
- `probe.ts` / `thumbs.ts` / `peaks.ts` — media metadata, filmstrip frames,
  audio waveforms.
- `autoEdit.ts` / `AutoEditDialog.tsx` — auto edit: loudness envelope, the
  adaptive silence detector, the pure cut planner (ripple across tracks,
  alternating punch-in zoom), presets, and the floating dialog that paints the
  pending cuts on the timeline; `speechAnalysis.ts` caches per-file Whisper
  transcripts for its speech mode (filler words, retakes, captions).
- `agentTools.ts` / `AiPanel.tsx` — the AI agents (MCP) dropdown in the top bar and the renderer side
  of the agent tools: each call from `electron/mcp` (server, client installers,
  stdio bridge in `resources/mcp`) runs here against the stores, serialized,
  one undo step per edit. Schemas live in `electron/mcp/tools.ts`.
- `agentCursors.ts` / `agentCursorPlan.ts` — the AI cursors: a crew of five coloured cursors acts
  each agent call out (clicks the button, drags the file from the bin, taps the cuts; new clips pop
  in when a cursor lands). The plan file says which cursor owns which tool and where it goes (a new
  tool needs an entry in `TOOL_SPECS`); targets are found by `data-agent`, `data-clip-id` and
  `data-media-id`. A call waits at most 0.6 s for its cursor; off switch in the AI agents panel.
  Between calls the crew keeps moving but makes nothing up (`patrol`): each cursor goes back over
  the edits the agent really made (its own kind first, a small ring instead of a click), fast for
  9 s after a call and slower after; the lead says "Thinking". Trails are one canvas, redrawn
  whole every frame.
- `montage.ts` — montages cut to music (the gaming-montage style; tools `detect_beats`,
  `find_highlights`, `build_montage`). Beats: spectral-flux onsets at 100 Hz, tempo by
  autocorrelation, beats by dynamic programming, bar starts from the bass, drops from a jump in
  level. Highlights are heard, not seen: where a file's loudness jumps out of its own background
  (the tool returns frames so the agent can look). `planMontage` solves each clip's in point so
  its moment lands on a beat through the speed ramp.
- `compare.ts` — before / after comparisons (tool `before_after`, style before-after): wipe,
  slider, split, cut. The after lies in front of the before, cropped to its side of a divider and
  placed so its pixels stay where they would be uncropped; moving the divider is a keyframed crop
  (`cropLeft` / `cropTop`, read by `withKeyframes`) plus position. Divider, handle and labels are
  ordinary shape and text clips that ride the same path.
- `ArtPicker.tsx` / `longformExamples.ts` — how people find the above. The dialog's Visuals cards are
  drawn live by `sceneDrawer` (the build's own renderer; a card plays on hover, its resting frame is
  kept for the session, the 3D stages are let go when the dialog closes). `LONGFORM_EXAMPLES` has a
  short script per format (an untouched example follows the format), `agentPrompt` /
  `AGENT_VIDEO_PROMPTS` are what the dialog and the AI agents panel offer to copy for an agent that
  writes the script too. The start screen has its own Longform button: the toolbar is not there
  until a project has media.
- `webCapture.ts` / `WebCaptureDialog.tsx` / `electron/system/webCapture.ts` — filming a web page
  (tool `capture_web`; dialog reached from the Record dialog). Main opens an **offscreen**
  `BrowserWindow` in a throwaway session partition (sandboxed, permissions denied, downloads
  cancelled, new windows loaded in place, http/https only), sized picture ÷ density so it fits any
  screen and painted at `offscreen.deviceScaleFactor` (Electron 45; the installed typings are older,
  hence the cast). A page script (`PAGE_JS`) draws the pointer, lists what can be clicked and finds
  targets by the words on them; steps are done with `sendInputEvent` along an eased path. `paint`
  frames go to the editor window as JPEG and are encoded there (mediabunny, constant 30 fps); the
  clicks are written as the same `.pointer.json` a recording gets, so `product_demo` works on the
  film unchanged. The renderer file is pure apart from `filmWeb`/`captureWeb`: `cleanSteps` (agent
  steps), `parseSteps` (the dialog's lines), `webAddress`, `webSize`. A failed step keeps nothing and
  returns the page as it looks, so the caller can fix the step.
- `electron/system/agentCapture.ts` / `resources/pointer/input-win.ps1` — another app's window for
  an agent (tool `record_window`). `request` finds one window by title (titles that do not match are
  never returned), shows the approval prompt from the main process (the renderer and the agent cannot
  answer it) and keeps the grant for ten minutes; "for this session" is kept by title and what was
  allowed, and a yes to more covers less. `shot` and `input` refuse a source without a grant. The
  recording itself is the ordinary recorder (`beginRecording` with that source), so the Record dialog
  shows it and Stop works. It records with `fromTool`: the recorder then leaves the product demo to
  the tool, because tools run one at a time (`runAgentTool`'s chain) and a recorder that queued
  `product_demo` from inside a running tool would wait for the tool that is waiting for it. Nothing
  called from a handler may go through `runAgentTool`. Input is a PowerShell helper fed commands on stdin (places are 0..1 of
  the window's drawn frame, which is what a window capture of another app shows): it checks before
  every action that the pointer is where it left it, that the window's process is in front and is
  the one under the pointer, and exits on the first failure. Windows only; macOS records without
  input. Dev-only switches for tests (ignored when packaged): `KRYPT_EDITOR_TEST_ALLOW_WINDOW`
  (skip the prompt for that exact title), `KRYPT_EDITOR_TEST_INPUT_DRY=1` (describe, do not act).
- `src/utils/guides.ts` / `src/utils/launch.ts` / `src/pages/Guides.tsx` /
  `src/components/MakeVideoDialog.tsx` — the Guides page and the top bar's "Make a video with AI".
  `guides.ts` is data only (`GUIDES`: id, length, chapters, what "try it" opens; `MAKE_WAYS`: the
  chooser's four cards) and is checked by `test/guides.test.mjs` against the files in
  `resources/guides` (every guide has its `<id>.mp4` and `<id>.jpg`, nothing else is in the folder,
  chapters are in order). The files are served by the app's own protocol,
  `krypteditor://guides/<name>` (`electron/system/mediaProtocol.ts`: only names matching
  `GUIDE_FILE`, only from that folder). The dialogs the buttons open live on the editor page, which
  is not mounted while another page shows, so a request waits in the `useLaunch` store (`want`, `go`)
  until the shell has switched page and the editor takes it; the agents panel is in the top bar and
  is opened by the `krypt:open-agents` event; `play` makes a guide asked for by name start playing.
  The chooser is rendered by the shell, not the top bar: the bar's backdrop blur would otherwise be
  the box a `fixed` dialog is laid out in.
  How the guide videos were made, for when the interface changes and they need making again: two
  private copies of the app with their own profiles and agent pipes, both moved off-screen. One is
  filmed through the DevTools protocol (`Page.startScreencast` at 1280×720 ×1.5, a drawn pointer,
  `Input.dispatch*` events, so no real mouse and nothing of the real screen) into a 1080p film per
  step plus a `.pointer.json` of the drawn pointer's clicks. The other puts a guide together with
  the app's own tools: `build_longform` (format `tutorial`, one section per step with its film as
  the picture, narrated by the built-in voice), `product_demo` on every film (`frame: false`, zoom
  1.6) and `export_video` at 1080p, −14 LUFS. A film must be at least as long as its section minus
  the step card (about 2.9 s), or it loops. The export is then re-encoded small for shipping
  (`ffmpeg -c:v libx264 -preset slow -crf 28 -g 120 -c:a aac -b:a 96k -movflags +faststart`, about
  4–6 MB a minute-long guide) and a frame of the title card is the poster. The Record dialog lists
  the windows open on the computer: before it is opened for a film, a style rule hides every tile
  but the one made-up window being recorded.
- `shared/imageSearch.ts` / `electron/system/images.ts` / `images.ts` / `ImageFinderDialog.tsx` —
  pictures from the web for a video (tools `find_images`, `save_images`; the media library's Find
  button; "Find pictures" in the Longform script box). Three sources, each read only through the
  door it publishes for programs: the Wikimedia Commons API, the Openverse API (licences cc0, pdm,
  by, by-sa only, asked for and checked again on the answer), and for Pinterest a board's or
  profile's RSS feed (`/<user>/<board>.rss`, `/<user>/feed.rss`: its newest 25 pins) and a pin's
  oEmbed. Pinterest's search has no such door, so words on the Pinterest tab get a sentence saying
  so; nothing is scraped and nothing is signed in. `shared/imageSearch.ts` is the part with no I/O
  (addresses, parsing, credit lines; tested in `test/images.test.mjs` on answers written out in the
  services' shapes). Main fetches in a session of its own (`krypt-images`: no cache, no cookies, a
  user agent that names the app), https only, never a local address, size caps, and a busy search
  (502/503/504) is asked once more. A search returns ids; `thumb(id)` gives a preview as a data:
  address (the page's CSP allows no remote images) and `save(ids)` downloads only what a search in
  this session returned, so the editor never passes an address to download. Files go to
  `<working folder>/Images/<title>-<id>.<ext>` (what the bytes are decides the extension) with a
  `<name>.credit.json` beside each; `resolveMediaFile` reads it into `MediaFile.credit`, which is
  how the credit follows the picture through projects and restarts. `creditsInUse()` lists the
  credits of what is on the timeline: `get_chapters` appends them, the dialog copies them. For an
  agent the results come back as one numbered contact sheet (`contactSheet`), not twenty images.
  Titles and descriptions are other people's words: shown, never followed (said in the tool text).
  Commons originals above 2600 px are taken as the 1920-wide copy (a listed thumbnail size).
- `longform.ts` / `LongformDialog.tsx` — whole long videos from a script (tools `list_formats`,
  `build_longform`; styles explainer, documentary, video-essay, top-list, clean-tutorial, lecture).
  `LONGFORM_FORMATS` say how each format opens, what starts a section (card, lower third, stinger
  and number card) and how pictures move; `planLongform` is pure and lays everything out from the
  measured narration: cards, pictures re-framed every few seconds, key points beside them
  (`makeRoom`), a section's own sentences as on-screen text when it has no pictures, captions,
  the music bed with duck keyframes, chapter marks. Fourteen narrated formats (plus trailer and quiz, below); what the later ones add is a
  flag each on the format record, drawn by the same planner: `framed` (pictures as windows:
  `cornerRadius`/`shadow`, `plan.backdrop` for the caller to put behind them), `split` (pairs of
  visuals side by side, the right one on the presenter lane, names from `comparisonSides`, a mark
  on `section.winner`), `rundown` (headings as key points under the hook), `figures`
  (`section.figure` is the card), `whole` (never crop), `progress` (a bar per section),
  `speakers` (`speakerNames`/`speakerTurns`: "Name:" turns in two voices, `SpokenLine.speaker`
  shown over the line), plus `section.kicker` and a script-level `presenter` that carries on
  through its recording. The dialog's script takes `Date:` / `Figure:` / `Winner:` lines under
  a heading. `buildLongform` in `agentTools.ts` does the
  impure part: Kokoro speaks one sentence at a time (so sentence times are exact, not estimated),
  `joinSpoken` makes one WAV per block, and `storeTranscript` seeds the transcript cache so
  captions and `get_transcript` never run Whisper on it. Supplied recordings are transcribed and
  `alignLines` matches the script to the heard words (LCS, gaps shared by word weight). Caption
  word timings carry their leading space, the way Whisper writes them (`transcriptOf`): the
  renderer joins words without adding any. The dialog parses a small markdown-like script
  (`parseScript`) and calls the same tool the agents do.
- `tilt.ts` — a clip leaning back in space (`MediaClip.tiltX` / `tiltY`, degrees, keyframeable; Inspector
  *Tilt back* / *Tilt sideways*, `update_clip` `tilt_x` / `tilt_y`). The preview does it in CSS
  (`perspective() rotate() rotateX() rotateY()`); the export canvas has no perspective, so `drawClip`
  paints the box flat (shadow and rounded corners included) on a scratch canvas and `warpTilted` lays
  it onto the frame as one quad through WebGL, from the same numbers (`tiltPoint`, `TILT_EYE`). Without
  WebGL the clip is exported flat. Checked by eye against the preview at the same playhead.
- The `cascade` text entrance (*Word by word*): `cascadeProgress` / `cascadeWord` in `timelineStore.ts`;
  the preview wraps each word in a span, the export draws word by word. Text only, like typewriter.
- A trailer's movement (`trailer.ts`): a window's whole path through a scene is one `Pose` function of
  time (`posed` turns it into keyframes, close together where it moves fast, because a keyframe's own
  easing is only quadratic). In at an angle and face on in `TRAILER_MOVE.enter`; then, with a `focus`
  on the visual, in on that part by cropping (the same share off width and height, so the window
  keeps its place and shape and the headline stays readable), else it rests at a slight angle. The
  opening lines sit over the features' recordings (or `hook_visuals`) leaning far back at half
  opacity. No full-frame colour cards: a feature's headline is over its recording from the first beat.
  `AppVideoDialog` passes a step's click as the focus when it is in the body of the picture
  (`TRAILER_EDGE`), not on a sidebar or a menu.
- `trailer.ts` / `quiz.ts` — the two formats that lay themselves out instead of following a narration
  (`LongformFormat.layout`; `buildLongform` dispatches to `planTrailer` / `planQuiz`, which return the
  same `LongformPlan`). Both are pure. Things that shaped them: text and shapes draw above every video
  track, so a full-frame rectangle hides pictures and logos — a trailer therefore uses the project
  background (`backdropFree`; when the project keeps a background of its own the cards bring a
  rectangle and the logo is left out, with a note), and a quiz builds its background as four
  rectangles around the picture. Overlay keyframes are x, y and opacity only, so the quiz countdown
  bar is "drained" by a cover in the background's colour sliding over it. Every trailer boundary is a
  beat (`TrailerGrid`, `beatTime`): the built-in 120 BPM grid, or the user's song through
  `detectBeats` when its tempo is clear. With no song the trailer is planned, `trailerMusic(plan.score)`
  writes a WAV to those cuts (chords and single echoing notes under the opening, a hit on the name; over
  the features a kick on every beat, clap, hats, an off-beat bass, held chords that dip with the kick
  and a plucked line in eighths; a rush of air at the window cuts; a held chord at the end), and it is
  planned again with the file. It is balanced by measurement, since nobody listens while it is made:
  the level falls about 2.5 dB per octave from 120 Hz up, so it survives a phone speaker (the first
  version was 23 dB down above 1 kHz and played as muffled thumps; a test now holds the share above
  300 Hz). `quizTicks` / `quizDing` are made the same way. Sounds are synthesised, not shipped.
  `evenLines` re-breaks a large line so no single word is left under it (`balanceLines` from
  `thumbnail.ts`). `outro.note` is the end card's small print. Tests: `test/trailer.test.mjs`.
- `appVideo.ts` / `AppVideoDialog.tsx` — a video about an app from one recording of it (toolbar
  *App video*, the chooser's "From an app on your screen", the `find_steps` tool). `findMoments`
  reads the recording's pointer track: clicks under 4 s apart are one step, a step runs from 1.2 s
  before its first click to 2.2 s after its last, steps never overlap, more than twelve are joined
  closest first; with what was said (`listen`) every step starts at a pause and runs to the next; no
  clicks and no resting pointer means an even split marked `guessed`. `appVideoArgs` turns named
  steps into `build_longform` arguments: a guide is `tutorial`, a product demo
  `product-walkthrough`, a trailer `trailer`. Nothing new is laid out: three small additions to the
  longform build carry it. (1) `LongformVisual.outPoint` (`out_point`): exactly that stretch plays
  once, fitted to its slot at 0.5× to 2.5× (`STRETCH`), the last frame held (`freezeAt`) when even
  half speed runs out; and a part that shows such stretches lasts at least their length ÷ 1.25, so
  a short line does not rush the footage. (2) `silent: true`: a `Narration` with an empty
  `mediaId` takes its time from the stretch (or from reading time) and its lines are the captions.
  (3) After the commit, every screen recording among the visuals that has a pointer track gets
  `productDemo({ frame: false })` in the same undo step: zooms, highlights and click sounds on the
  clips the planner placed (their slow drift is switched off first; `demo: false` skips it).
  `productDemo` now places a held frame at the camera's transform for that moment instead of
  skipping it. The dialog sends the person to Record or Film a web page and reopens on what landed
  (`appWaits` in `pages/Editor.tsx`). Tests: `test/appvideo.test.mjs`.
- A video from a recording (`build_longform` with `recording`; narrated formats only). The file is
  transcribed once, `heardLines` keeps the word times, `snapToPause` moves each section's `from` /
  `to` to a sentence end within 1.5 s (else out of a word), and `narrationSlice` hands the planner
  that stretch as a `Narration` with `inPoint` / `sourceDuration`, so the section plays the file
  itself. A filmed recording is the picture of any section that names nothing else (filling the
  frame; a screen recording, known by its pointer track, is shown whole).
- Comic panels (`longform.ts`, `art/bake.ts`; format `comic-story`, `build_longform` with
  `scene_mode: "panels"`, the Longform dialog's *Comic panels* box). A drawn section is not one
  acted-out video but a panel per beat: `panelSlots` decides which beats get one (a beat under
  `MIN_PANEL` shares the panel before it, so the planner never has a slot too short to show),
  `scenePanels` draws each as a JPEG at `panelTime` (once the pose has landed) and hands them to the
  planner as visuals with `at`. A slot of `panel_motion_after` seconds or more (the format's `hold`,
  4 by default) is baked as a short video of that stretch instead (`SceneJob.from`), which is what
  "slight animation on a held panel" means here: the drawing itself moves. In the planner
  `VisualInfo.panel` (and any still in a format with `panels`) means one framing, a cut instead of a
  dissolve, and `motion` only when the slot is at least `panelMoveAfter` long, capped at a small
  amount. `LongformFormat.visualStyle` lets a format bring its drawing style; the dialog sends
  `visual_style: "none"` when *My pictures* is chosen, so what the cards show is what is built.
- `shared/imageGen.ts` / `electron/system/pictures.ts` / `pictures.ts` / `pictureMath.ts` /
  `pictureWorker.ts` / `PictureSetupCard.tsx` / `MakePicturesPane.tsx` — pictures made from words
  (tool `generate_images`; `build_longform` with `pictures: "auto"` or `pictures` on a section; the
  Find dialog's *Make from words* tab; the Longform checkbox; Settings → Pictures from words). Two
  sources behind one call, `makePictures(subjects, options)`:
  - **A service with the user's key** (`openai`, `google`, `xai`, or `custom`: any address that
    speaks the OpenAI picture format). `shared/imageGen.ts` (pure) builds the request and reads the
    answer (`pictureRequest`, `pictureAnswer`, `pictureFailure`); the main process sends it from its
    own session without cookies and without following redirects. The key lives in
    `electron/system/secrets.ts` (Electron `safeStorage`, `userData/secrets.json`), is read only in
    main and never returned: the page and agents see `hasKey` and the last four characters. No agent
    tool can set a key or an address. Provider error text is quoted with the key replaced by
    `[key]`. A daily limit (`pictures.dailyLimit`, counted in `userData/pictures-made.json`,
    in-flight orders included) covers dialogs and agents alike. The named providers' request shapes
    were written from their documentation in November 2026 and are covered by unit tests only; model
    names are editable in Settings because they change.
  - **A model on this computer**, in a worker on onnxruntime-web/WebGPU (`shader-f16` required):
    DreamShaper 8 LCM (four passes) or SDXS (one pass), both fixed at 512 × 512 by their files.
    `pictureMath.ts` (pure) has the CLIP tokenizer, the seeded noise, both samplers and `localCrop`
    (a wide picture is cut from above the middle of the square, where the faces are).
    `electron/system/modelFiles.ts` (`PinnedModel`) downloads with resume and checks every file's
    SHA-256 against a pinned revision. Both models are decoded by TAESD: DreamShaper's own decoder
    took 3 to 8 s a picture, swung graphics memory by gigabytes and got the device removed on a
    busy card. Measured on an RTX 3080: LCM about 1.25 s a picture and 4.2 GB of graphics memory,
    SDXS about 0.2 s and 2.1 GB. One picture at a time (`queue`); the worker is dropped after 90 s
    idle, or at once when the caller passes `release` (Longform does, before the voice loads). A
    pass that does not come back in time (`Stalled`) or a lost device (`Lost`) drops the worker;
    the smaller model is tried if installed, and when no device can be had any more (`cardAlive`)
    the user is told to restart instead of failing every picture.
  `PICTURE_LOOKS` and `picturePrompt` put one look around every description, plus a *keep* line for
  what must stay the same; `pictureBeats` turns narration into one picture about every twelve words.
  Tested in `test/pictures.test.mjs`.
- `drawing.ts` / `drawingRender.ts` / `drawings.ts` — pictures a connected agent draws itself, as
  SVG (tool `draw_images`; `drawings` / `hook_drawings` in `build_longform`). `drawing.ts` (pure)
  has the rules and the movement: what a drawing may contain (`DRAWING_ELEMENTS`,
  `drawingAttributeOk`: nothing that runs, nothing that points outside the drawing), the twelve
  moves (`DRAWING_MOVES`, `moveAt`: each a pure function of time, all slight) and the line wobble
  (`boilSeed`: one of five displacement noises, changed eight times a second). `drawingRender.ts`
  needs a browser: `readDrawing` parses (strictly, then the way a page reads inline SVG when that
  fails, so an attribute given twice or an open tag is repaired and said so), cleans, wraps every
  `data-move` element in a `<g>` of its own (the CSS transform goes on the wrapper, with
  `transform-box: fill-box`, so the element's own transform and a pivot given as "bottom left" both
  work without measuring anything) and puts everything but the background through the wobble
  filter; `drawingStill` gives the PNG, `bakeDrawing` an H.264 clip of it moving. A drawing is only
  ever shown through an `<img>` from a `data:` address, where no script runs and nothing loads.
  `drawings.ts` keeps one (PNG in the Images folder with the cleaned `.svg` beside it, via
  `pictures.keepDrawing`) and finds the SVG of a library picture again (`drawingOf`: this session's
  map, else `pictures.drawingSource`, which only reads `drawn-*.svg` in the Images folder). In
  `buildLongform` a drawing is `VisualInfo.panel` + `drawing` (one framing, cut in; key points push
  it aside, since nothing was left clear in it). The video is planned twice: the first plan says
  how long each drawing is up, those held `panel_motion_after` seconds or longer are baked for
  exactly that long and swapped in, then it is planned again. The agent gets a numbered sheet back,
  as with found and made pictures. Tested in `test/drawing.test.mjs` (the pure part); the rest
  live. The drawing guide for agents is the description of `draw_images` in `electron/mcp/tools.ts`.
- `thumbnail.ts` / `thumbnailSource.ts` / `ThumbnailDialog.tsx` — thumbnails (tool `make_thumbnail`,
  the toolbar's Thumbnail button). `thumbnail.ts` is the layout and the drawing: `thumbWords`
  (stars mark the accent words; without stars the figure or the last word), `balanceLines` and
  `fitThumb` (every way of breaking a one-line headline is tried, the largest letters win; `measure`
  is passed in, so it is tested without a canvas), `drawThumbnail`. `thumbnailSource.ts` gets what
  is behind the words: one frame of a drawn scene (`sceneFrame`, with the engine's `inset` keeping
  the left clear), a frame of the timeline without its captions (`renderStills`), or a library
  picture; main keeps the JPEG in `<working folder>/Thumbnails`. Trap: a canvas *on the page*
  inherits the page's `font-feature-settings`, which make Impact stack "TH" and "ED"; the saved
  file is drawn off the page without them, so the dialog's canvases switch the features off.
- `shared/channelStudy.ts` / `electron/system/channel.ts` / `channel.ts` / `ChannelDialog.tsx` — a
  YouTube channel as the example (tool `study_channel`, the toolbar's Channel button). Only what
  YouTube publishes for programs is read: the channel's video feed (`feeds/videos.xml`, its newest
  15 uploads with titles, dates, views and descriptions), the feed link a channel page announces in
  its head (to turn an @handle into that feed), a video's oEmbed (to find the channel of a video
  link) and the 320×180 thumbnails of the videos the feed listed, by id. Requests go to
  www.youtube.com and i.ytimg.com only, without cookies; no video is downloaded.
  `studyChannel` counts what the titles have in common, `titleHabits` says only what most of them
  do (or never do), `paletteOf` finds the colours the thumbnails lean on (vivid ones outweigh
  greys), and `describeStudy` ends by saying it is for the shape, not the words. Video lengths are
  not in the feed, so pacing is not studied. Tested on a feed written out in YouTube's shape
  (`test/comic.test.mjs`).
- `art/` — drawn visual styles for long videos (`build_longform` with `visual_style`). Two renderers
  ported from Krypt Marketo, each a pure function of time: `stickman.ts` (canvas 2D stick figures,
  poses, faces and props; five looks) and `char3d.ts` (a three.js character in clay, toon and
  low-poly art; loaded only when a 3D style is asked for). The rule of the port: the figure and
  prop drawing is Marketo's code unchanged, the scene around it (beats, camera, frame shape) is
  ours, at the bottom of `stickman.ts` and in `mascot.ts`. The stage is 1080 × 1920 units; a wide
  frame shows the band the figures stand in. `art.ts` (pure) has the style catalogue and the
  director: one beat per sentence, the pose read from the words (`RULES`), a figure in the line as
  the big word, the script's cues laid over that (`directBeats`). `bake.ts` draws a scene frame by
  frame into an H.264 file (mediabunny `CanvasSource`), as long as its narration, so it reaches the
  timeline as an ordinary video; in the plan it is one clip played as it is (`VisualInfo.generated`).
  A section with key points is drawn with the left 42% of a wide frame clear, and the panel lies
  over it instead of sliding the picture.
- `marketo.ts` / `MarketoDialog.tsx` / `electron/system/marketo.ts` — upload through Krypt
  Marketo (tools `send_to_marketo`, `marketo`). Main is an MCP client of Marketo's hub: it reads
  `%APPDATA%/Krypt Marketo/mcp.json` (pipe, token, exe), says hello with the token, then speaks
  newline JSON-RPC, starting the app when it is closed. Only Marketo's long-video tools are relayed
  (`MARKETO_TOOLS`): an agent connected to a video editor does not get to drive the user's social
  accounts through it. `handoffArgs` builds the entry from the last export and the script
  `build_longform` recorded (`useHandoffStore`), with the chapters appended to the description.
  In development `KRYPT_MARKETO_MCP_CONFIG` points at another connection file, for a stand-in hub.
- `styles.ts` — edit styles (built-in + saved) in the agent tools' own
  vocabulary, plus the active style, the user's notes and the reference video
  (localStorage, and `ai` in the project file). `scenes.ts` — pure builders for
  what agents compose: title cards (`fitText` breaks lines itself, because the
  export canvas doesn't wrap), `insertGap`, stingers, `planTransitions`, key
  points (`buildKeyPoints`: left-anchored text clips sharing a `group`, plus
  `makeRoom` to slide the footage aside) and `markChapters`.
- Chapters are a `chapter` title on a clip ("a chapter starts where this clip
  starts"), so ripple edits carry them; `chaptersOf` / `chapterList` in
  `timelineStore.ts` derive the list (pieces of a cut clip count once).
- `slides.ts` / `pdfLoader.ts` — slide decks: pdf.js renders each PDF page to a
  PNG in the media cache and keeps its text; `alignSlides` times the slides
  against the transcript (ordered DP over spoken lines, rare and title words
  weighted, boundaries at pauses, text-free slides sharing their neighbour's
  time). pdf.js's cmaps / fonts / wasm are copied to `dist/pdfjs` by
  `pdfAssetsPlugin` in `vite.config.ts`; `pdfLoader.ts` is loaded on demand
  and kept out of the test bundle.
- Linked clips (`timelineStore.ts`) — a video with sound is added as a
  picture clip (muted) and a sound clip on an audio track sharing a `link`
  id (`addMedia`, `soundOf`, `freeTrack`; `probe.ts` reads the container to
  know whether there is sound at all). Selection is NOT widened to the
  partner (the inspector stays on the clicked clip); instead every edit asks
  `linkedIds` for the clips it applies to: delete, ripple delete, split,
  copy / paste, duplicate, close gap, trim (same delta for both, stopped by
  the tighter one), speed and speed curves (`syncSpeed`), freeze frame. Alt
  sets `soloSelect` (one side alone) and a locked track keeps its clips out.
  Planners that slice clips (auto edit, cut ranges, scenes) go through
  `commitClips`, where `relinkPieces` pairs the pieces up again by overlap.
  `carriedSound` lets the preview play an in-step pair from the picture's
  own `<video>` (no second element to drift); a slipped or re-timed sound
  gets its own `<audio>`. Detectors listen through `listenableClips` /
  `voiceTrack`, which skip a picture whose sound is its own clip and files
  known to be silent. Agent tools follow the same rules (`only_these` opts
  out); `update_clip` sends volume / muted / denoise asked of a picture to
  its sound clip.
- `demo.ts` / `DemoDialog.tsx` / `electron/system/pointer.ts` — Product demo (tool `product_demo`).
  While a screen or window is recorded with the option on, main keeps a pointer track: positions and
  presses relative to the recorded picture, in recording seconds with pauses left out, written as
  `<screen file>.pointer.json`. On Windows a PowerShell helper (`resources/pointer/pointer-win.ps1`,
  started before the countdown because it takes about a second to come up) reports the pointer, the
  mouse buttons and the recorded window's place. On macOS Electron gives the position and a script
  run by the system's osascript (`pointer-mac.js`: `NSEvent.pressedMouseButtons` and the window's
  bounds, no permission needed) gives the presses and the window's place; `pointer-mac.js test` is
  its self-check, run on the Mac runner in release.yml. Elsewhere, or when the script fails, Electron
  gives positions on a recorded screen only, and the planner falls back to where the pointer rests
  (`settles`). `demo.ts` is pure:
  `planCamera` groups clicks into visits (in before the first click, a move only when a click or the
  pointer would leave the view, out after the last), `clipKeys` turns the camera into scale and
  position keyframes per clip so pieces left by cuts agree, `clipClicks` places each click on the
  canvas under the camera at that moment, `clickSound` synthesizes the click. Everything made is
  tagged `group: demo:<media id>` so a second run replaces it. The window frame is the clip made
  smaller plus two clip settings drawn by both renderers from one helper (`cornerRadius`, `shadow`,
  `boxDecor` in timelineStore.ts: CSS in Preview, a clip path and an outside-only shadow in export),
  on the project background. What the frame changed is kept on the clip (`demoRest`) so taking it
  off is exact. A framed picture zooms as a scene (`DemoFrame.scene`, `reachAt`): near an edge the
  frame and backdrop come into view instead of the picture stopping flush with the canvas.
- `recorder.ts` / `recordingPlan.ts` / `RecordDialog.tsx` — recording a
  screen or window, a camera and a microphone. Capture is `getDisplayMedia` /
  `getUserMedia` in the renderer (main answers the display request with the
  source picked in the dialog: `electron/system/capture.ts`), encoded live
  with WebCodecs through mediabunny's `MediaStream*TrackSource`. While
  recording, every track goes into ONE fragmented MP4 (`…-unfinished.mp4`):
  in sync by construction, one stream of writes, and still a playable file
  after a crash. On stop the tracks are copied (no re-encode) into ordinary
  files, one per thing worth editing alone (`planOutputs`: screen, camera
  with the voice, or the voice on its own when the screen file carries the
  computer's sound), found by the track names written at record time, and
  `planRecordingClips` lands them on the timeline. The session lives in the
  module (a zustand store), not the dialog: leaving the editor page unmounts
  the dialog and the stop shortcut fires while the window is hidden. The
  computer's sound is routed through an `AudioContext` so it is a steady
  stream even in silence; the fragmenting muxer waits for every track before
  it writes, so a track that stalls would hold the whole file in memory.
- Long projects: `get_project` counts captions instead of listing them past 40
  and takes `from` / `to`; an agent client caps a tool result at roughly 25k
  tokens, and a 30-minute captioned edit was four times that.
  `reference.ts` — reference-video analysis: frames sampled at 5 fps,
  histogram cut detection, tone, a suggested style, and stills for the agent
  to read captions and titles from.
- `captions.ts` / `captionWorker.ts` — on-device Whisper transcription +
  SRT/VTT parse/serialize. Long silences are cut out before Whisper and the
  times mapped back; the rest is sliced at quiet points over a worker pool —
  two WebGPU workers (for Whisper base, encoder on the GPU and decoder on the
  CPU) or one per core budget on the CPU. The ONNX runtime is the JSEP build (alias in
  `vite.config.ts`), measured faster here than ORT's native WebGPU build. `whisperTimestamps.ts` replaces transformers.js's word
  alignment with an identical typed-array version (it was ~half the time).
  `SpeechModelCard.tsx` is the Fast/Accurate choice in Settings.
- `tts.ts` / `kokoro/` — text to speech. English is Kokoro-82M, ported from
  Krypt Studio's analyzer: `g2p.ts` (text → phonemes with the bundled CMU
  dictionary, no eSpeak), `kokoroWorker.ts` (ONNX Runtime, WebGPU else WASM);
  main installs the model (`electron/system/kokoro.ts`, copied from Studio
  when it has it). Other languages use MMS-TTS (`ttsWorker.ts`).
- `modelCache.ts` — where both workers keep downloaded Hugging Face models:
  files in userData/models/speech through `krypteditor://models/`. Chromium
  rejects Cache API writes from a file:// page, so the browser cache would
  download them again on every launch.
- `transcriptEdit.ts` / `TranscriptPanel.tsx` — edit by transcript: timeline
  words from the cached Whisper transcript (re-mapped through the clips on
  every edit), the cuts that delete a selection, find, the playing word.
- `reframe.ts` / `ReframeDialog.tsx` — auto reframe: face samples (MediaPipe
  face detector on frames from mediabunny) → a held/panned camera path →
  fill scale + posX keyframes per clip; sets the canvas in the same undo step.
- `ducking.ts` / `DuckDialog.tsx` — auto duck: voice ranges (transcript words
  or loudness) → bridged spans → eased volume keyframes on the other tracks.
- `loudness.ts` — BS.1770 integrated loudness, look-ahead limiter, and the
  export's normalize-to-target pass.
- `revoice.ts` / `RevoiceDialog.tsx` — re-voice: transcript lines mapped onto
  the timeline, spoken with Kokoro, laid out at the original times (sped up to
  fit, else pushed later), one WAV on a new track, original muted/lowered.
- `chroma.ts` / `fx.ts` / `segmenter.ts` — the GPU/ML per-clip passes.
- `project.ts` — `.krypt` (de)serialization and validation.

Preview and export share the pure math from `timelineStore.ts`; anything that
affects rendering must go through those helpers so the two stay in sync.
