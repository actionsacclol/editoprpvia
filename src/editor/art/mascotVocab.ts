// The 3D mascot: its art styles and the actions a beat can give it (ported from Krypt Marketo).

/** cartoon = toon shading with ink outlines; ps2 = wobbly low-poly world with fog and dithering; 3d = soft studio render (clay / toy). */
export const ARTS = ['cartoon', 'ps2', '3d'] as const;
export type Art = (typeof ARTS)[number];

export const ACTIONS = ['talk', 'point', 'present', 'shrug', 'shock', 'cheer', 'think', 'wave', 'facepalm', 'sad', 'laugh'] as const;
export type Action = (typeof ACTIONS)[number];

export const isAction = (v: string): v is Action => (ACTIONS as readonly string[]).includes(v);
