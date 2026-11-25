import { create } from 'zustand';
import type { McpToolResult } from '@shared/types';
import { chapterList, useTimelineStore } from './timelineStore';
import { useProjectStore } from './projectStore';

/**
 * Handing a finished video to Krypt Marketo, the Krypt app that uploads to
 * YouTube. Marketo keeps a list of long videos (title, script, description,
 * tags, thumbnail, files); the hand-off writes one from what this editor
 * knows (the exported file, the project, the chapters, the script the video
 * was built from) and can put the file into YouTube Studio's upload dialog
 * in Marketo's own browser. The connection itself is electron/system/marketo.ts.
 *
 * Only Marketo's long-video tools are reachable from here. Driving the user's
 * accounts (clicking through Studio, posting) stays with Marketo's own agent
 * connection, where the user allowed it.
 */

/** The Marketo tools an agent can reach through the editor. */
export const MARKETO_TOOLS = ['list_accounts', 'list_long_videos', 'save_long_video', 'render_thumbnail', 'browser_attach_long'] as const;
export type MarketoTool = (typeof MARKETO_TOOLS)[number];

export interface HandoffScript {
  title: string;
  sections: Array<{ heading: string; text: string }>;
}

interface HandoffState {
  /** The last video file exported in this session. */
  exportPath: string | null;
  /** The script the open video was built from (build_longform), for Marketo's record of it. */
  script: HandoffScript | null;
  /** The Marketo long video this project was last sent to, so sending again updates it. */
  sentId: string | null;
  setExport: (path: string) => void;
  setScript: (script: HandoffScript | null) => void;
  setSent: (id: string | null) => void;
}

export const useHandoffStore = create<HandoffState>((set) => ({
  exportPath: null,
  script: null,
  sentId: null,
  setExport: (exportPath) => set({ exportPath }),
  setScript: (script) => set({ script, sentId: null }),
  setSent: (sentId) => set({ sentId }),
}));

export interface SendOptions {
  videoPath?: string;
  /** An existing Marketo long video to update (default: the one this project was sent to before, else a new one). */
  id?: string;
  handle?: string;
  title?: string;
  topic?: string;
  description?: string;
  tags?: string[];
  thumbnailText?: string;
  thumbnailBg?: string;
  visibility?: 'unlisted' | 'public' | 'private';
  /** Also put the file into YouTube Studio's upload dialog in Marketo's browser. */
  upload?: boolean;
}

export interface SendResult {
  ok: boolean;
  text: string;
  id?: string;
}

const VIDEO_FILE = /\.(mp4|mov|webm|mkv|m4v)$/i;
const hasChapterLines = (s: string): boolean => /^\s*\d{1,2}:\d{2}(:\d{2})?\s+\S/m.test(s);

/** What goes to Marketo's save_long_video for this project (pure: the stores are read by the caller). */
export function handoffArgs(o: SendOptions, ctx: { exportPath: string | null; projectPath: string | null; projectName: string; chapters: string; script: HandoffScript | null; sentId: string | null }): { args: Record<string, unknown>; problem?: string } {
  const videoPath = o.videoPath ?? ctx.exportPath;
  if (!videoPath) return { args: {}, problem: 'There is no exported video yet: export the video first, or pass video_path.' };
  if (!VIDEO_FILE.test(videoPath)) return { args: {}, problem: `${videoPath} is not a video file: export as MP4 for YouTube.` };
  const id = o.id ?? ctx.sentId ?? undefined;
  const title = (o.title ?? (id ? undefined : (ctx.script?.title ?? ctx.projectName)))?.trim().slice(0, 100);
  let description = o.description?.trim();
  // The chapters come from the edit: a description without them gets them, a new video's starts with them.
  if (ctx.chapters && description && !hasChapterLines(description)) description = `${description}\n\n${ctx.chapters}`;
  else if (ctx.chapters && !description && !id) description = ctx.chapters;
  const sections = !id && ctx.script ? ctx.script.sections.filter((s) => s.heading.trim() && s.text.trim()).slice(0, 30).map((s) => ({ heading: s.heading.trim().slice(0, 80), text: s.text.trim().slice(0, 5000) })) : undefined;
  const args: Record<string, unknown> = {
    id,
    handle: o.handle,
    title: title || undefined,
    topic: o.topic?.slice(0, 400),
    sections: sections?.length ? sections : undefined,
    description: description?.slice(0, 5000),
    tags: o.tags?.map((t) => t.trim().slice(0, 60)).filter(Boolean).slice(0, 30),
    thumbnail_text: o.thumbnailText?.slice(0, 60),
    thumbnail_bg: o.thumbnailBg,
    project_path: ctx.projectPath ?? undefined,
    video_path: videoPath,
    status: 'edited',
    visibility: o.visibility,
  };
  for (const k of Object.keys(args)) if (args[k] === undefined) delete args[k];
  return { args };
}

/** A long video's id from Marketo's answer (its first line starts with it). */
export function longVideoId(text: string): string | undefined {
  const m = /^\s*([A-Za-z0-9_-]{3,40}) · "/.exec(text);
  return m?.[1];
}

export async function marketoCall(tool: string, args: unknown, launch = true): Promise<McpToolResult> {
  const api = window.krypt?.marketo;
  if (!api) return { ok: false, text: 'This build of Krypt Editor has no Krypt Marketo connection.' };
  return api.call(tool, args, launch);
}

/** Write the open project's video into Marketo's long-video list, and optionally start the upload. */
export async function sendToMarketo(o: SendOptions = {}): Promise<SendResult> {
  const hand = useHandoffStore.getState();
  const project = useProjectStore.getState();
  const built = handoffArgs(o, {
    exportPath: hand.exportPath,
    projectPath: project.path,
    projectName: project.name,
    chapters: chapterList(useTimelineStore.getState().clips).text,
    script: hand.script,
    sentId: hand.sentId,
  });
  if (built.problem) return { ok: false, text: built.problem };
  const saved = await marketoCall('save_long_video', built.args);
  if (!saved.ok) return { ok: false, text: saved.text };
  const id = (built.args.id as string | undefined) ?? longVideoId(saved.text);
  if (id) useHandoffStore.getState().setSent(id);
  if (!o.upload) return { ok: true, text: saved.text, id };
  if (!id) return { ok: false, text: `Saved in Krypt Marketo, but its answer did not name the video, so the upload was not started:\n${saved.text}`, id };
  const attached = await marketoCall('browser_attach_long', { id, ...(o.handle ? { handle: o.handle } : {}) });
  return { ok: attached.ok, text: `${saved.text}\n\n${attached.ok ? '' : 'The upload was not started: '}${attached.text}`, id };
}
