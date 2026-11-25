/**
 * A picture leaning back in space: a clip's tiltX / tiltY (degrees) turn it
 * about its own middle and it is seen in perspective, the way an app window is
 * shown at an angle in a product film.
 *
 * The preview does it with CSS (perspective() rotateX() rotateY()); the export
 * canvas has no perspective, so the flat picture is drawn to a scratch canvas
 * and laid onto the frame as one quad by WebGL. Both use the numbers here, in
 * the order CSS applies them, so the two agree.
 */

/** How far the eye is from a tilted clip, in frame heights. */
export const TILT_EYE = 2.2;
/** The most a clip leans, degrees either way: past this it is nearly edge-on. */
export const TILT_MAX = 65;

const rad = (deg: number): number => (deg * Math.PI) / 180;
export const clampTilt = (deg: number | undefined): number => Math.min(TILT_MAX, Math.max(-TILT_MAX, deg || 0));

/**
 * Where a point of a tilted box lands. x, y are measured from the box's middle (y down); the result is too, with
 * `w` the depth divisor that was applied (under 1 = nearer the eye, so larger). CSS order: turn about Y, then X,
 * then in the plane of the screen, then perspective from `eye` away.
 */
export function tiltPoint(x: number, y: number, tiltX: number, tiltY: number, rotation: number, eye: number): { x: number; y: number; w: number } {
  const a = rad(clampTilt(tiltX));
  const b = rad(clampTilt(tiltY));
  const c = rad(rotation || 0);
  // rotateY: x' = x cos b + z sin b, z' = -x sin b + z cos b   (z = 0 on the box)
  const x1 = x * Math.cos(b);
  const z1 = -x * Math.sin(b);
  // rotateX: y' = y cos a - z sin a, z' = y sin a + z cos a
  const y2 = y * Math.cos(a) - z1 * Math.sin(a);
  const z2 = y * Math.sin(a) + z1 * Math.cos(a);
  // rotate (about Z)
  const x3 = x1 * Math.cos(c) - y2 * Math.sin(c);
  const y3 = x1 * Math.sin(c) + y2 * Math.cos(c);
  const w = Math.max(0.05, 1 - z2 / eye);
  return { x: x3 / w, y: y3 / w, w };
}

/** The CSS for the same thing, to go between the translate and the scale of a clip's transform. */
export function tiltCss(tiltX: number, tiltY: number, rotation: number, stageH: number): string {
  return `perspective(${TILT_EYE * stageH}px) rotate(${rotation}deg) rotateX(${clampTilt(tiltX)}deg) rotateY(${clampTilt(tiltY)}deg)`;
}

// ── The export's quad ──────────────────────────────────────────────────────
interface Warper {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext | WebGL2RenderingContext;
  two: boolean;
  buffer: WebGLBuffer;
  texture: WebGLTexture;
}
let warper: Warper | null | undefined;

function makeWarper(): Warper | null {
  const canvas = document.createElement('canvas');
  const opts = { premultipliedAlpha: true, alpha: true, antialias: true, depth: false, stencil: false };
  const gl2 = canvas.getContext('webgl2', opts) as WebGL2RenderingContext | null;
  const gl: WebGLRenderingContext | WebGL2RenderingContext | null = gl2 ?? (canvas.getContext('webgl', opts) as WebGLRenderingContext | null);
  if (!gl) return null;
  const shader = (type: number, src: string): WebGLShader | null => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const vs = shader(gl.VERTEX_SHADER, 'attribute vec4 p; attribute vec2 uv; varying vec2 v; void main() { v = uv; gl_Position = p; }');
  const fs = shader(gl.FRAGMENT_SHADER, 'precision mediump float; varying vec2 v; uniform sampler2D s; void main() { gl_FragColor = texture2D(s, v); }');
  const program = gl.createProgram();
  const buffer = gl.createBuffer();
  const texture = gl.createTexture();
  if (!vs || !fs || !program || !buffer || !texture) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, 'p');
  gl.bindAttribLocation(program, 1, 'uv');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 24, 0);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 16);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // Mip maps keep the far edge of a leaning picture from shimmering; WebGL 1 has none for odd sizes.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl2 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 0);
  return { canvas, gl, two: !!gl2, buffer, texture };
}

/**
 * `flat` (a picture drawn untilted, its middle the box's middle) as it looks tilted, on a see-through canvas the
 * size of the frame, ready to be drawn onto it at 0, 0. Null where WebGL is not to be had: the caller draws it flat.
 * The canvas is reused by the next call, so draw it before asking again.
 */
export function warpTilted(flat: HTMLCanvasElement, o: { cx: number; cy: number; tiltX: number; tiltY: number; rotation: number }, W: number, H: number): HTMLCanvasElement | null {
  if (warper === undefined) {
    try {
      warper = typeof document === 'undefined' ? null : makeWarper();
    } catch {
      warper = null;
    }
  }
  const k = warper;
  if (!k || k.gl.isContextLost()) return null;
  const { gl, canvas } = k;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  gl.viewport(0, 0, W, H);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const hw = flat.width / 2;
  const hh = flat.height / 2;
  const data = new Float32Array(24);
  // A strip: top left, top right, bottom left, bottom right.
  [
    [-hw, -hh, 0, 0],
    [hw, -hh, 1, 0],
    [-hw, hh, 0, 1],
    [hw, hh, 1, 1],
  ].forEach(([x, y, u, v], i) => {
    const q = tiltPoint(x, y, o.tiltX, o.tiltY, o.rotation, TILT_EYE * H);
    const nx = ((o.cx + q.x) / W) * 2 - 1;
    const ny = 1 - ((o.cy + q.y) / H) * 2;
    // Homogeneous, so the picture is foreshortened the way perspective does it, not stretched evenly.
    data.set([nx * q.w, ny * q.w, 0, q.w, u, v], i * 6);
  });
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, flat);
  if (k.two) gl.generateMipmap(gl.TEXTURE_2D);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return canvas;
}
