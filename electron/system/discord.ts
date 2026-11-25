import RPC from 'discord-rpc';
import { resolveClientContext, isDebug } from './identity';

/**
 * Discord Rich Presence — best-effort, never blocking (kryptguidelines §8).
 * Every Krypt tool advertises in the user's profile while running; the
 * activity text updates with live state ("Editing video", "Idle").
 *
 * Identity (app id, product name, URLs) comes from the coupled identity
 * module — not clean literals here (§9). If the context can't be resolved
 * (someone patched the brand payloads) we simply never connect: degraded,
 * not crashing. Never throw out of this module.
 */

const ctx = resolveClientContext();

const DEFAULT_BUTTONS: Array<{ label: string; url: string }> = [
  { label: 'Free Tools', url: ctx.toolsUrl },
  { label: 'Krypt.cc', url: ctx.discordUrl },
];

let client: RPC.Client | null = null;
let connected = false;
let desired = false;
let last: { state: string; details: string } | null = null;
let startedAt = Date.now();

export async function startDiscordRpc(): Promise<void> {
  // Degraded mode: refuse to advertise under a tampered identity, but let
  // the rest of the app run normally (no crash, no "tamper" message).
  if (!ctx.intact && !isDebug()) return;
  desired = true;
  if (connected) return;
  try {
    client = new RPC.Client({ transport: 'ipc' });
    client.on('ready', () => {
      connected = true;
      startedAt = Date.now();
      pushActivity();
    });
    client.on('disconnected', () => {
      connected = false;
    });
    await client.login({ clientId: ctx.clientId });
  } catch (err) {
    // Discord may simply not be running. Not an error.
    // eslint-disable-next-line no-console
    console.warn('[presence] login skipped:', (err as Error)?.message);
    connected = false;
  }
}

export function stopDiscordRpc(): void {
  desired = false;
  try {
    client?.destroy();
  } catch {
    /* ignore */
  }
  client = null;
  connected = false;
  last = null;
}

export function setActivity(details: string, state: string): void {
  last = { details, state };
  pushActivity();
}

function pushActivity(): void {
  if (!connected || !client || !desired) return;
  const payload = last ?? { details: 'Idle', state: 'Editing video' };
  client
    .setActivity({
      details: payload.details,
      state: payload.state,
      largeImageKey: 'krypt',
      largeImageText: ctx.productName,
      startTimestamp: startedAt,
      instance: false,
      buttons: DEFAULT_BUTTONS,
    })
    .catch(() => {
      /* best-effort */
    });
}
