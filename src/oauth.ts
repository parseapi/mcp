// OAuth for the hosted server. parseapi.com is the authorization server;
// this process is only the resource. Two jobs here: serve the discovery
// documents, and exchange bearer tokens for the org's API key through the
// web's internal resolve endpoint. Answers cache for up to 10 minutes, so a
// revoke on the dashboard lands on the key-revoke law's clock — PlanetScale
// is truth, caches age out, no invalidate machinery.

const WEB_URL = (process.env.WEB_URL ?? 'https://parseapi.com').replace(/\/$/, '');
const SELF_URL = (process.env.SELF_URL ?? 'https://mcp.parseapi.com').replace(/\/$/, '');

const KEY_TTL_MS = 10 * 60 * 1000;
const MISS_TTL_MS = 60 * 1000;

type CacheEntry = { key: string | null; expires: number };
const cache = new Map<string, CacheEntry>();

/** parse_ / parse_public_ mint, or a legacy 32-hex key. Anything else on a Bearer is an OAuth token. */
export function isApiKeyShape(value: string): boolean {
	return value.startsWith('parse_') || /^[0-9a-f]{32}$/.test(value);
}

export async function resolveOAuthKey(token: string): Promise<string | null> {
	const hit = cache.get(token);
	if (hit && hit.expires > Date.now()) return hit.key;

	if (cache.size > 5000) {
		const now = Date.now();
		for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
	}

	try {
		const res = await fetch(`${WEB_URL}/api/internal/mcp/resolve`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-parse-web-internal': process.env.WEB_INTERNAL_TOKEN ?? '',
			},
			body: JSON.stringify({ token }),
			signal: AbortSignal.timeout(3000),
		});
		if (res.ok) {
			const data = (await res.json()) as { key?: string; expires_in?: number };
			if (typeof data.key === 'string' && data.key) {
				const ttl = Math.min(KEY_TTL_MS, Math.max(30_000, (data.expires_in ?? 600) * 1000));
				cache.set(token, { key: data.key, expires: Date.now() + ttl });
				return data.key;
			}
		}
		if (res.status === 401 || res.status === 403 || res.status === 404) {
			cache.set(token, { key: null, expires: Date.now() + MISS_TTL_MS });
		}
		// 5xx / bad shape: no cache — this call fails, the next one retries.
		return null;
	} catch {
		return null;
	}
}

/** RFC 9728 — tells clients where to sign in. */
export const PROTECTED_RESOURCE_METADATA = {
	resource: SELF_URL,
	authorization_servers: [WEB_URL],
	bearer_methods_supported: ['header'],
	scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
} as const;

export const WWW_AUTHENTICATE = `Bearer resource_metadata="${SELF_URL}/.well-known/oauth-protected-resource"`;

// Pre-2025-06 clients look for authorization-server metadata on the MCP
// origin itself instead of following resource metadata. Mirror the web's
// document for them, cached briefly.
let asMetadata: { body: string; expires: number } | null = null;

export async function authServerMetadata(): Promise<string | null> {
	if (asMetadata && asMetadata.expires > Date.now()) return asMetadata.body;
	try {
		const res = await fetch(`${WEB_URL}/.well-known/oauth-authorization-server`, {
			signal: AbortSignal.timeout(3000),
		});
		if (!res.ok) return null;
		const body = await res.text();
		asMetadata = { body, expires: Date.now() + 5 * 60 * 1000 };
		return body;
	} catch {
		return asMetadata?.body ?? null;
	}
}
