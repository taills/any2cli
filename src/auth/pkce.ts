import { createHash, randomBytes } from 'node:crypto';

export interface Pkce {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** RFC 7636 PKCE pair: 32 random bytes → 43-char base64url verifier, SHA-256 challenge. */
export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

export function randomState(): string {
  return randomBytes(16).toString('base64url');
}
