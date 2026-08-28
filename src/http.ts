import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { buildServer } from './registry.js';
import {
	PROTECTED_RESOURCE_METADATA,
	WWW_AUTHENTICATE,
	authServerMetadata,
	isApiKeyShape,
	resolveOAuthKey,
} from './oauth.js';

function keyFrom(request: Request | undefined): string | null {
	if (!request) return null;
	const headerKey = request.headers.get('x-api-key');
	if (headerKey) return headerKey;
	const auth = request.headers.get('authorization');
	if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim() || null;
	return null;
}

const handler = createMcpHandler((ctx) => buildServer(keyFrom(ctx.requestInfo), 'http'), {
	onerror: (err) => console.error('parseapi-mcp:', err.message),
});

const nodeHandler = toNodeHandler(handler);
const port = Number(process.env.PORT ?? 8080);

const WELL_KNOWN_CORS = {
	'content-type': 'application/json',
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, OPTIONS',
	'access-control-allow-headers': 'Content-Type',
};

function unauthorized(res: ServerResponse): void {
	res
		.writeHead(401, {
			'content-type': 'application/json',
			'www-authenticate': WWW_AUTHENTICATE,
			'access-control-allow-origin': '*',
			'access-control-expose-headers': 'WWW-Authenticate',
		})
		.end(
			JSON.stringify({
				error: 'unauthorized',
				error_description: 'Sign in via OAuth or send an API key in X-API-Key.',
			})
		);
}

function bearerFrom(req: IncomingMessage): string | null {
	const auth = req.headers.authorization;
	if (typeof auth !== 'string' || !auth.toLowerCase().startsWith('bearer ')) return null;
	return auth.slice(7).trim() || null;
}

// Credential gate for the MCP endpoint. API keys (X-API-Key or a key-shaped
// Bearer) pass straight through to the handler above. An OAuth bearer token
// gets exchanged for the connection's org key and rides on as X-API-Key.
// No credentials at all is a 401 with resource metadata — that header is
// what makes "Add to Cursor" open the browser sign-in.
async function gate(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const headerKey = req.headers['x-api-key'];
	if (typeof headerKey === 'string' && headerKey) {
		return nodeHandler(req, res);
	}

	const bearer = bearerFrom(req);
	if (!bearer) {
		unauthorized(res);
		return;
	}
	if (isApiKeyShape(bearer)) {
		return nodeHandler(req, res);
	}

	const key = await resolveOAuthKey(bearer);
	if (!key) {
		unauthorized(res);
		return;
	}
	req.headers['x-api-key'] = key;
	return nodeHandler(req, res);
}

createServer((req, res) => {
	const path = (req.url ?? '/').split('?')[0];

	if (req.method === 'GET' && path === '/health') {
		res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
		return;
	}

	if (path === '/.well-known/oauth-protected-resource') {
		if (req.method === 'OPTIONS') {
			res.writeHead(204, WELL_KNOWN_CORS).end();
			return;
		}
		res.writeHead(200, WELL_KNOWN_CORS).end(JSON.stringify(PROTECTED_RESOURCE_METADATA));
		return;
	}

	if (
		path === '/.well-known/oauth-authorization-server' ||
		path === '/.well-known/openid-configuration'
	) {
		if (req.method === 'OPTIONS') {
			res.writeHead(204, WELL_KNOWN_CORS).end();
			return;
		}
		void authServerMetadata().then((body) => {
			if (body) res.writeHead(200, WELL_KNOWN_CORS).end(body);
			else res.writeHead(503, WELL_KNOWN_CORS).end(JSON.stringify({ error: 'unavailable' }));
		});
		return;
	}

	// Preflights carry no credentials by design — never 401 them.
	if (req.method === 'OPTIONS') {
		void nodeHandler(req, res);
		return;
	}

	void gate(req, res).catch((err) => {
		console.error('parseapi-mcp gate:', err instanceof Error ? err.message : err);
		if (!res.headersSent) {
			res.writeHead(500, { 'content-type': 'application/json' }).end(
				JSON.stringify({ error: 'server_error' })
			);
		}
	});
}).listen(port, () => {
	console.error(`parseapi-mcp listening on :${port}`);
});
