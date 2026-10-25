import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const fixtureKey = 'parse_http_browser_redirect_fixture_key';

async function availablePort() {
	const listener = createServer();
	await new Promise((resolve, reject) => {
		listener.once('error', reject);
		listener.listen(0, '127.0.0.1', resolve);
	});
	const port = listener.address().port;
	await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
	return port;
}

async function startServer(t) {
	const port = await availablePort();
	const origin = `http://127.0.0.1:${port}`;
	const child = spawn(process.execPath, [process.env.MCP_HTTP_ENTRY ?? 'dist/http.js'], {
		cwd: fileURLToPath(new URL('../', import.meta.url)),
		env: {
			...process.env,
			PORT: String(port),
			PARSEAPI_KEY: '',
			PARSEAPI_MCP_MODE: 'full',
			SELF_URL: 'https://mcp.parseapi.com',
			WEB_URL: origin,
			WEB_INTERNAL_TOKEN: '',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let output = '';
	let spawnError;
	for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-4000); });
	child.once('error', error => { spawnError = error; });
	const exited = once(child, 'exit').catch(() => {});
	t.after(async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		child.kill('SIGTERM');
		await Promise.race([exited, delay(1000)]);
		if (child.exitCode === null && child.signalCode === null) {
			child.kill('SIGKILL');
			await exited;
		}
	});
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		if (spawnError) throw spawnError;
		assert.equal(child.exitCode, null, `HTTP child exited before readiness:\n${output}`);
		try {
			const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) });
			if (response.status === 200 && await response.text() === 'ok') return origin;
		} catch {}
		await delay(50);
	}
	assert.fail(`HTTP child did not become ready:\n${output}`);
}

function request(origin, path = '/', options = {}) {
	return fetch(`${origin}${path}`, { ...options, redirect: 'manual', signal: AbortSignal.timeout(3000) });
}

function requestWithoutAccept(origin) {
	// fetch supplies Accept: */* automatically, so use HTTP directly for the missing-header case.
	return new Promise((resolve, reject) => {
		const req = httpRequest(origin, response => {
			const chunks = [];
			response.on('data', chunk => chunks.push(chunk));
			response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
			response.on('error', reject);
		});
		req.setTimeout(3000, () => req.destroy(new Error('HTTP request timed out')));
		req.on('error', reject);
		req.end();
	});
}

function assertUnauthorized(response) {
	assert.equal(response.status, 401);
	assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
	assert.match(response.headers.get('www-authenticate') ?? '', /Bearer resource_metadata="https:\/\/mcp\.parseapi\.com\/\.well-known\/oauth-protected-resource"/);
}

async function rpcResponse(response) {
	const text = await response.text();
	if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
		const messages = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5).trim()));
		return messages.find(message => message.id === 1);
	}
	return JSON.parse(text);
}

test('browser redirect preserves the authenticated MCP endpoint and discovery routes', { timeout: 20000 }, async t => {
	const origin = await startServer(t);

	await t.test('explicit HTML navigation redirects to the existing MCP page', async () => {
		for (const [path, accept] of [
			['/', 'text/html'],
			['/?from=browser&message=untrusted_query_marker', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'],
			['/', 'text/html;q=0.2'],
		]) {
			const response = await request(origin, path, { headers: { accept } });
			assert.equal(response.status, 302);
			assert.equal(response.headers.get('location'), 'https://parseapi.com/mcp');
			assert.equal(response.headers.get('cache-control'), 'no-store');
			assert.equal(response.headers.get('vary'), 'Accept');
			assert.equal(response.headers.get('www-authenticate'), null);
			assert.equal(response.headers.get('set-cookie'), null);
			assert.equal(await response.text(), '');
		}
	});

	await t.test('HEAD navigation redirects to the fixed destination without a response body', async () => {
		const response = await request(origin, '/?from=head', { method: 'HEAD', headers: { accept: 'text/html' } });
		assert.equal(response.status, 302);
		assert.equal(response.headers.get('location'), 'https://parseapi.com/mcp');
		assert.equal(response.headers.get('cache-control'), 'no-store');
		assert.equal(response.headers.get('vary'), 'Accept');
		assert.equal(await response.text(), '');
	});

	await t.test('non-browser Accept headers retain the OAuth challenge', async () => {
		const missing = await requestWithoutAccept(origin);
		assertUnauthorized(missing);
		assert.equal((await missing.json()).error, 'unauthorized');
		for (const accept of ['*/*', 'application/json', 'text/event-stream', 'application/json, text/html;q=0.2', 'text/html, text/event-stream', 'text/html;q=0', 'text/html;q=0, */*;q=1']) {
			const response = await request(origin, '/', { headers: { accept } });
			assertUnauthorized(response);
			assert.equal((await response.json()).error, 'unauthorized');
		}
	});

	await t.test('MCP protocol headers prevent a browser redirect even when HTML is accepted', async () => {
		for (const headers of [{ 'mcp-session-id': 'fixture-session' }, { 'mcp-protocol-version': '2025-06-18' }]) {
			const response = await request(origin, '/', { headers: { accept: 'text/html', ...headers } });
			assertUnauthorized(response);
			assert.equal((await response.json()).error, 'unauthorized');
		}
	});

	await t.test('explicit credentials retain protocol handling instead of redirecting', async () => {
		for (const headers of [{ 'x-api-key': fixtureKey }, { authorization: `Bearer ${fixtureKey}` }]) {
			const response = await request(origin, '/', { headers: { accept: 'text/html', ...headers } });
			assert.equal(response.status, 405);
			assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
			assert.equal((await response.json()).error.code, -32000);
		}
		for (const headers of [{ 'x-api-key': '' }, { authorization: '' }]) {
			const response = await request(origin, '/', { headers: { accept: 'text/html', ...headers } });
			assertUnauthorized(response);
			await response.arrayBuffer();
		}
	});

	await t.test('browser redirects are limited to GET and HEAD at the root', async () => {
		for (const path of ['/mcp', '/other', '/nested/']) {
			const response = await request(origin, path, { headers: { accept: 'text/html' } });
			assertUnauthorized(response);
			await response.arrayBuffer();
		}
		const post = await request(origin, '/', { method: 'POST', headers: { accept: 'text/html', 'content-type': 'application/json' }, body: '{}' });
		assertUnauthorized(post);
		await post.arrayBuffer();
	});

	await t.test('health and protected-resource discovery retain their ordinary responses', async () => {
		const health = await request(origin, '/health', { headers: { accept: 'text/html' } });
		assert.equal(health.status, 200);
		assert.match(health.headers.get('content-type') ?? '', /^text\/plain\b/);
		assert.equal(await health.text(), 'ok');
		const metadata = await request(origin, '/.well-known/oauth-protected-resource', { headers: { accept: 'text/html' } });
		assert.equal(metadata.status, 200);
		assert.match(metadata.headers.get('content-type') ?? '', /^application\/json\b/);
		const resource = await metadata.json();
		assert.equal(resource.resource, 'https://mcp.parseapi.com');
		assert.deepEqual(resource.authorization_servers, [origin]);
		assert.deepEqual(resource.bearer_methods_supported, ['header']);
	});

	await t.test('OPTIONS still reaches the existing protocol preflight handler without authentication', async () => {
		const response = await request(origin, '/', { method: 'OPTIONS', headers: { accept: 'text/html', origin: 'https://client.example.test', 'access-control-request-method': 'POST' } });
		assert.equal(response.status, 405);
		assert.equal(response.headers.get('www-authenticate'), null);
		assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
		assert.equal((await response.json()).error.code, -32000);
		const metadata = await request(origin, '/.well-known/oauth-protected-resource', { method: 'OPTIONS', headers: { accept: 'text/html' } });
		assert.equal(metadata.status, 204);
		assert.equal(metadata.headers.get('access-control-allow-origin'), '*');
		assert.equal(await metadata.text(), '');
	});

	await t.test('a fixture API key can initialize the MCP transport without making a lookup', async () => {
		const response = await request(origin, '/', {
			method: 'POST',
			headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'x-api-key': fixtureKey },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'http-browser-redirect-fixture', version: '0.0.0' } },
			}),
		});
		assert.equal(response.status, 200);
		const message = await rpcResponse(response);
		assert.equal(message?.error, undefined);
		assert.equal(message?.result?.serverInfo?.name, 'parseapi');
		assert.equal(message?.id, 1);
		assert.ok(!JSON.stringify(message).includes(fixtureKey));
	});
});
