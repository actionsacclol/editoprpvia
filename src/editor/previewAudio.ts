import { buildFxChain, fxSignature, type AudioFx, type FxChain } from './audioFx';

/**
 * The preview's sound path.
 *
 * Every playing <video> / <audio> element is taken into one Web Audio graph:
 *
 *   element → [the clip's EQ / compressor / pan] → mix ─┬→ monitor volume → speakers
 *                                                       └→ level meter
 *
 * The meter reads the mix before the preview's volume slider, so it shows the
 * level an export gets, not how loud the speakers are set. If the graph can't
 * be set up (no audio device, say) elements simply keep playing straight to
 * the speakers, without shaping or metering.
 */

interface Route {
  source: MediaElementAudioSourceNode;
  sig: string;
  chain: FxChain | null;
}

interface Graph {
  ctx: AudioContext;
  mix: GainNode;
  monitor: GainNode;
  left: AnalyserNode;
  right: AnalyserNode;
  bufL: Float32Array<ArrayBuffer>;
  bufR: Float32Array<ArrayBuffer>;
}

let graph: Graph | null = null;
let broken = false;
let monitorVolume = 1;
const routes = new Map<HTMLMediaElement, Route>();
/**
 * An element can be given a source node only once, and from then on its sound
 * comes out of that node alone. So the node is kept for as long as the element
 * lives: one that is routed again after being taken out (React's development
 * mode runs every clean-up once right after mounting) gets its old node back.
 * Making a second one throws, and the element would stay silent for good.
 */
const sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
let sweptAt = 0;

/** Elements that have left the page are taken out of the graph (belt and braces beside the players' own clean-up). */
function sweep(): void {
  const now = performance.now();
  if (now - sweptAt < 2000) return;
  sweptAt = now;
  for (const el of [...routes.keys()]) if (!el.isConnected) unrouteAudio(el);
}

function ensureGraph(): Graph | null {
  if (graph || broken) return graph;
  try {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const mix = ctx.createGain();
    const monitor = ctx.createGain();
    monitor.gain.value = monitorVolume;
    // The mix is always treated as stereo, so a mono source reads the same on both meters.
    mix.channelCount = 2;
    mix.channelCountMode = 'explicit';
    const split = ctx.createChannelSplitter(2);
    const left = ctx.createAnalyser();
    const right = ctx.createAnalyser();
    left.fftSize = right.fftSize = 2048;
    mix.connect(monitor).connect(ctx.destination);
    mix.connect(split);
    split.connect(left, 0);
    split.connect(right, 1);
    graph = { ctx, mix, monitor, left, right, bufL: new Float32Array(left.fftSize), bufR: new Float32Array(right.fftSize) };
  } catch (e) {
    broken = true;
    console.warn(`[audio] preview graph unavailable, playing directly: ${(e as Error).message}`);
  }
  return graph;
}

/** The preview's volume slider (0–1). Applied after the meter. */
export function setMonitorVolume(v: number): void {
  monitorVolume = Math.max(0, Math.min(1, v));
  if (graph) graph.monitor.gain.value = monitorVolume;
}

/** What an element that is not in the graph should multiply its own volume by. */
export const directVolume = (): number => monitorVolume;

/**
 * Take an element into the graph (once) and give it the sound shaping of the
 * clip it is playing. Cheap to call every frame: nodes are only rebuilt when
 * the settings change. Returns false when the element plays directly instead.
 */
export function routeAudio(el: HTMLMediaElement, fx: AudioFx): boolean {
  const g = ensureGraph();
  if (!g) return false;
  sweep();
  let r = routes.get(el);
  if (!r) {
    try {
      let source = sources.get(el);
      if (!source) {
        source = g.ctx.createMediaElementSource(el);
        sources.set(el, source);
      }
      r = { source, sig: '\u0000', chain: null };
      routes.set(el, r);
    } catch {
      return false;
    }
  }
  const sig = fxSignature(fx);
  if (sig !== r.sig) {
    r.source.disconnect();
    r.chain?.nodes.forEach((n) => n.disconnect());
    r.chain = buildFxChain(g.ctx, fx);
    if (r.chain) {
      r.source.connect(r.chain.input);
      r.chain.output.connect(g.mix);
    } else {
      r.source.connect(g.mix);
    }
    r.sig = sig;
  }
  return true;
}

/** An element is going away: take it out of the graph. Its source node is kept (see `sources`). */
export function unrouteAudio(el: HTMLMediaElement): void {
  const r = routes.get(el);
  if (!r) return;
  try {
    r.source.disconnect();
    r.chain?.nodes.forEach((n) => n.disconnect());
  } catch {
    /* already disconnected */
  }
  routes.delete(el);
}

/** Playback is starting: a context that was created suspended has to be woken. */
export function wakeAudio(): void {
  if (graph && graph.ctx.state === 'suspended') void graph.ctx.resume().catch(() => {});
}

/** The mix's current peak per channel (linear, 0 = silence; above 1 would clip an export). */
export function readLevels(): [number, number] {
  if (!graph) return [0, 0];
  const peak = (a: AnalyserNode, buf: Float32Array<ArrayBuffer>): number => {
    a.getFloatTimeDomainData(buf);
    let m = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i] < 0 ? -buf[i] : buf[i];
      if (v > m) m = v;
    }
    return m;
  };
  return [peak(graph.left, graph.bufL), peak(graph.right, graph.bufR)];
}
