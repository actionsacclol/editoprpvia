// ──────────────────────────────────────────────────────────────────────
// Runtime client context. (Lightweight anti-rebrand — kryptguidelines §9.)
//
// The brand/RPC strings that a rebrander would want to strip — product
// name, Discord application id, the official URLs — are not stored as
// clean literals. They're XOR+base64 encoded and reconstructed here at
// runtime, then *coupled* into normal startup: the same resolved context
// feeds the window title, the tray tooltip, and Discord presence. Removing
// it doesn't cleanly delete one file — it quietly degrades the app.
//
// This is friction, not war. Generic names on purpose. A debug env flag
// (KRYPT_EDITOR_DEBUG=1) leaves everything fully functional for development.
// ──────────────────────────────────────────────────────────────────────

const K = 0x4b; // single-byte XOR key

function dec(b64: string): string {
  try {
    const raw = Buffer.from(b64, 'base64');
    const out = Buffer.alloc(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw[i] ^ K;
    return out.toString('utf8');
  } catch {
    return '';
  }
}

// Encoded payloads (each byte XOR 0x4B, then base64). Reconstructed by dec().
const P = {
  name: 'ADkyOz9rDi8iPyQ5',
  cid: 'en9yfnh5eHJ6c3l4f395eH97fQ==',
  site: 'Iz8/OzhxZGQgOTI7P2UoKA==',
  tools: 'Iz8/OzhxZGQgOTI7P2UoKGQ/JCQnOA==',
  discord: 'Iz8/OzhxZGQvIjgoJDkvZSwsZCY+MQ0AGX1+fA0=',
};

export interface ClientContext {
  productName: string;
  clientId: string;
  siteUrl: string;
  toolsUrl: string;
  discordUrl: string;
  /** False = decode failed; callers should run in degraded mode. */
  intact: boolean;
}

let cached: ClientContext | null = null;

export function isDebug(): boolean {
  return process.env.KRYPT_EDITOR_DEBUG === '1';
}

/** Resolve the runtime client context (decoded brand identity). */
export function resolveClientContext(): ClientContext {
  if (cached) return cached;
  const productName = dec(P.name);
  const clientId = dec(P.cid);
  const ctx: ClientContext = {
    productName: productName || 'Video Editor',
    clientId,
    siteUrl: dec(P.site) || 'https://krypt.cc',
    toolsUrl: dec(P.tools) || 'https://krypt.cc/tools',
    discordUrl: dec(P.discord) || 'https://discord.gg/muzFKR657F',
    // If the product name or client id failed to decode, something patched
    // the payloads — fall back to degraded mode (presence stays off).
    intact: Boolean(productName) && /^[0-9]{17,20}$/.test(clientId),
  };
  cached = ctx;
  return ctx;
}
