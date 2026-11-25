// Test bundle entry — everything the pure-logic tests exercise. Bundled to
// test/.editor.mjs by `npm test` (esbuild, node platform, @shared aliased).
export {
  activeAudioClips,
  carriedSound,
  freeTrack,
  linkPartners,
  linkedIds,
  listenableClips,
  relinkPieces,
  soundOf,
  voiceTrack,
  activeWordAt,
  audibleTrackIds,
  captionClipsFor,
  fadeFactor,
  maxClipDuration,
  resolvedValue,
  retimeKeyframesForHeadTrim,
  sliceClip,
  sourceTimeAt,
  speedAt,
  splitKeyframes,
  timelineDuration,
  upcomingVideoClips,
  useTimelineStore,
  boxDecor,
} from '../src/editor/timelineStore';
export type { Clip, MediaClip, Track } from '../src/editor/timelineStore';
export { clipSpeechCuts, combineSilences, detectSilences, envelopeDb, fillerRanges, intersectRanges, planCuts, remapSegments, retakeRanges, silencesFromWords, timelineTimeAtSource, voiceLevelDb } from '../src/editor/autoEdit';
export { compactRanges, parseSubtitles, planSlices, poolSize, restoreTimes, sourceTime, speechRanges, toSRT } from '../src/editor/captions';
export { AnalysisAccumulator, Resampler, resample } from '../src/editor/audioDecode';
export { timeStretch } from '../src/editor/stretch';
export { lutAtlasPixels, lutFromBase64, lutToBase64, parseCube } from '../src/editor/lut';
export { denoiseChannel } from '../src/editor/denoise';
export { encodeWavPcm16 } from '../src/editor/tts';
export { AGENT_TOOL_NAMES, markSessionReady, runAgentTool } from '../src/editor/agentTools';
export { TOOLS } from '../electron/mcp/tools';
export { useLutStore } from '../src/editor/lutStore';
export { useProjectStore } from '../src/editor/projectStore';
export { useMediaStore } from '../src/editor/mediaStore';
export { loadDict, phonemize, sentences, splitLong, textChunks, word as g2pWord } from '../src/editor/kokoro/g2p';
export { encode as kokoroEncode } from '../src/editor/kokoro/vocab';
export { wordToArpabet } from '../src/editor/kokoro/lts';
export { spellToken } from '../src/editor/kokoro/numbers';
export { TTS_VOICES, voiceNotice } from '../src/editor/tts';
export { layoutLines, linesFromTranscript, revoicePieces, speakable } from '../src/editor/revoice';
export { cutRangesForWords, findPhrase, transcriptWordsFrom, wordIndexAt } from '../src/editor/transcriptEdit';
export { cameraPath, fillFactor, pathAt, posXFor, reframeClip, sampleTimes } from '../src/editor/reframe';
export { duckKeys, duckSpans, joinClose, voicedFromWords } from '../src/editor/ducking';
export { integratedLoudness, normalizeLoudness, peakDb } from '../src/editor/loudness';
export { passthroughClip } from '../src/editor/passthrough';
export { tokenTimestamps } from '../src/editor/whisperTimestamps';
export { CLIP_ANIMS, MOTIONS, TEXT_ANIMS, TRANSITIONS, EFFECTS, FONTS, activeVisualLayers, hasClipAnim, textAnim, transitionPart } from '../src/editor/timelineStore';
export { buildCard, buildKeyPoints, buildStinger, fitText, insertGap, makeRoom, markChapters, planTransitions, readableOn } from '../src/editor/scenes';
export { alignSlides, contentWords, slideTitle } from '../src/editor/slides';
export { CAMERA_CORNER, clock, describeOutputs, encodeSize, noVisualsYet, planOutputs, planRecordingClips, videoBitrate } from '../src/editor/recordingPlan';
export { chapterList, chapterStamp, chaptersOf } from '../src/editor/timelineStore';
export { BUILTIN_STYLES, CARD_LOOKS, STYLE_PARTS, findStyle, styleId, useStyleStore } from '../src/editor/styles';
export { averageTone, buildProfile, countBlackDips, detectCuts, frameDistance, frameStats, frameTimes, gradeTowards, nearestAspect, soundCoverage, suggestStyle } from '../src/editor/reference';
export { HARD_SEEK, STEER_MAX, STEER_START, STEER_STOP, steer } from '../src/editor/previewSync';
export { routeAudio, unrouteAudio } from '../src/editor/previewAudio';
export { BEAT_RATE, detectBeats, findHighlights, planMontage } from '../src/editor/montage';
export { CompareError, beyondDivider, coverCrop, planCompare, trackInFront } from '../src/editor/compare';
export { clipLayout, withKeyframes } from '../src/editor/timelineStore';
export { proxySize, wantsProxy } from '../src/editor/proxy';
export { exportExtension } from '../src/editor/export';
export { fitCanvas } from '../src/editor/timelineStore';
export { EQ_RANGE, VOICE_PRESET, compressorSettings, fxSignature, hasAudioFx, isVoicePreset, meterFraction, resolveFx, toDb } from '../src/editor/audioFx';
export { crossCorrelate, findSoundOffset, onsetEnvelope, soundMatches } from '../src/editor/syncSound';
export { CREW, TOOL_SPECS, deal, diffClips, planStage, toolSpec } from '../src/editor/agentCursorPlan';
export { beginAgentStage } from '../src/editor/agentCursors';
export { planTrailer, trailerMusic, beatTime, evenLines, TRAILER_MAX_CALLOUTS, TRAILER_MOVE, TRAILER_BPM } from '../src/editor/trailer';
export { TILT_EYE, tiltPoint, tiltCss, clampTilt } from '../src/editor/tilt';
export { cascadeProgress, cascadeWord } from '../src/editor/timelineStore';
export { planQuiz, quizLayout, quizTicks, quizDing, answerIndex, revealLine, QUIZ_RIGHT, QUIZ_MAX_OPTIONS } from '../src/editor/quiz';
export { heardLines, narrationSlice, snapToPause, QUIZ_THINK, STRETCH, readingSeconds } from '../src/editor/longform';
export { APP_KINDS, MOMENT, appVideoArgs, appVideoProblem, appVideoPrompt, findAppKind, findMoments } from '../src/editor/appVideo';
export { LONGFORM_FORMATS, alignLines, captionSegments, coverScale, comparisonSides, estimateLines, findFormat, joinSpoken, parseScript, speakerNames, speakerTurns, phraseTime, planLongform, pointTimes, scriptStats, speechParts, splitSentences, spreadWords, trimSilence, visualStarts } from '../src/editor/longform';
export { MARKETO_TOOLS, handoffArgs, longVideoId, useHandoffStore } from '../src/editor/marketo';
export { ART_STYLES, artHelp, cueProblems, directBeats, figureIn, findArt } from '../src/editor/art/art';
export { ACTIONS } from '../src/editor/art/mascotVocab';
export { STICK_POSES, stickProps } from '../src/editor/art/stickVocab';
export { sceneSize } from '../src/editor/art/bake';
export { DEMO, cameraAt, clickSound, clipClicks, clipKeys, fitShare, onCanvas, parsePointer, planCamera, pointerAt, reachAt, settles, transformAt, viewAt } from '../src/editor/demo';
export { AGENT_CAPTURE_PROMPTS, AGENT_VIDEO_PROMPTS, LONGFORM_EXAMPLES, agentPrompt } from '../src/editor/longformExamples';
export { cleanSteps, cleanWindowSteps, parseSteps, pointerJson, webAddress, webSize } from '../src/editor/webCapture';
export { GUIDES, GUIDE_FILE, MAKE_WAYS, chapterAt, findGuide, guideClock, guideUrl } from '../src/utils/guides';
export { IMAGE_SOURCES, commonsSearchUrl, creditLine, creditOf, creditsText, imageExt, imageFileBase, openverseSearchUrl, parseCommons, parseOpenverse, parsePinterestFeed, parsePinterestOembed, pinSizes, pinterestFeedUrl, pinterestOembedUrl, pinterestTarget, plainText, readCredit, shapeOf } from '../shared/imageSearch';
export { MIN_PANEL, panelSlots, panelTime } from '../src/editor/art/bake';
export { THUMB, balanceLines, fitThumb, hexColor, inkOn, thumbBox, thumbColorsFrom, thumbVariants, thumbWords } from '../src/editor/thumbnail';
export { channelFeedUrl, channelIdIn, channelTarget, describeStudy, paletteOf, parseChannelFeed, studyChannel, titleHabits, videoThumbUrl } from '../shared/channelStudy';
export { DEFAULT_PICTURE_SETTINGS, LOCAL_PICTURE_MODELS, PICTURE_LOOKS, PICTURE_PROVIDERS, aspectFor, customEndpoint, pickSource, pictureAnswer, pictureBeats, pictureBeatsWithin, pictureFailure, picturePrompt, pictureRequest, pictureSlug, readPictureSettings, readyLocalModel, sourceProblem, withoutKey } from '../shared/imageGen';
export { CLIP_LENGTH, LCM_TIMESTEPS, SDXS_SIGMA, alphasCumprod, clipTokenizer, gaussian, lcmStep, LOCAL_SIZE, localCrop, noise, planesToRgba, sdxsInput, sdxsStep } from '../src/editor/pictureMath';
export { DRAWING_ELEMENTS, DRAWING_MAX_CHARS, DRAWING_MOVES, MAX_DRAWINGS, boilSeed, combineMoves, drawingAttributeOk, drawingPivot, drawingPixels, drawingProblem, drawingSlug, drawingStyleText, moveAt, movePhase, moveStyle, withNamespaces } from '../src/editor/drawing';
