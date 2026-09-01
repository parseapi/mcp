// Live smoke for parseapi-mcp. Run: node smoke/smoke.mjs
// With PARSEAPI_KEY set it also makes real calls against the edge.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

const KEY = process.env.PARSEAPI_KEY ?? null;
let failures = 0;

function check(name, cond, detail) {
	if (cond) {
		console.log(`ok   ${name}`);
	} else {
		failures++;
		console.log(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
	}
}

function toolText(result) {
	return JSON.parse(result.content[0].text);
}

// ---- stdio transport ----------------------------------------------------

class StdioClient {
	constructor(env) {
		this.child = spawn(process.execPath, ['dist/stdio.js'], {
			env: { ...process.env, ...env },
			stdio: ['pipe', 'pipe', 'inherit'],
		});
		this.nextId = 1;
		this.pending = new Map();
		this.buffer = '';
		this.child.stdout.on('data', (chunk) => {
			this.buffer += chunk.toString();
			let idx;
			while ((idx = this.buffer.indexOf('\n')) !== -1) {
				const line = this.buffer.slice(0, idx).trim();
				this.buffer = this.buffer.slice(idx + 1);
				if (!line) continue;
				const msg = JSON.parse(line);
				if (msg.id !== undefined && this.pending.has(msg.id)) {
					this.pending.get(msg.id)(msg);
					this.pending.delete(msg.id);
				}
			}
		});
	}

	send(msg) {
		this.child.stdin.write(JSON.stringify(msg) + '\n');
	}

	request(method, params) {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30000);
			this.pending.set(id, (msg) => {
				clearTimeout(timer);
				resolve(msg);
			});
			this.send({ jsonrpc: '2.0', id, method, params });
		});
	}

	async init() {
		const res = await this.request('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'parseapi-mcp-smoke', version: '0.0.0' },
		});
		this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
		return res;
	}

	close() {
		this.child.kill();
	}
}

async function smokeStdio() {
	console.log('\n-- stdio --');

	// Keyless: tools list, calls funnel to signup.
	const bare = new StdioClient({ PARSEAPI_KEY: '' });
	await bare.init();
	const list = await bare.request('tools/list', {});
	const names = list.result.tools.map((t) => t.name);
	check('stdio tools/list has 46 tools', names.length === 46, `got ${names.length}`);
	check('stdio has ip_self', names.includes('ip_self'));
	check('stdio has vat', names.includes('vat'));
	check('stdio has iban', names.includes('iban'));
	check('stdio has npi', names.includes('npi'));
	check('stdio has vin', names.includes('vin'));
	check('stdio has no sanctions', !names.includes('sanctions'));
	check('stdio has hts', names.includes('hts') && names.includes('hts_search'));
	check(
		'stdio has the phone family',
		names.includes('carrier') && names.includes('caller') && names.includes('hlr')
	);
	const funnel = await bare.request('tools/call', {
		name: 'postal',
		arguments: { code: '28202', country: 'US' },
	});
	const funnelBody = toolText(funnel.result);
	check(
		'stdio keyless call funnels to signup',
		funnel.result.isError === true && funnelBody.code === 'invalid_api_key',
		JSON.stringify(funnelBody)
	);
	bare.close();

	if (!KEY) {
		console.log('skip live stdio call (no PARSEAPI_KEY)');
		return;
	}

	const live = new StdioClient({ PARSEAPI_KEY: KEY });
	await live.init();
	const postal = await live.request('tools/call', {
		name: 'postal',
		arguments: { code: '28202', country: 'US' },
	});
	const body = toolText(postal.result);
	check('stdio live postal 28202 is Charlotte', body.city === 'Charlotte', JSON.stringify(body).slice(0, 200));
	const miss = await live.request('tools/call', {
		name: 'city',
		arguments: { name: 'atlantis-does-not-exist' },
	});
	const missBody = toolText(miss.result);
	check(
		'stdio honest miss is not_found',
		miss.result.isError === true && missBody.code === 'not_found',
		JSON.stringify(missBody)
	);
	live.close();
}

// ---- http transport -----------------------------------------------------

async function postRpc(port, msg, headers = {}) {
	const res = await fetch(`http://127.0.0.1:${port}/`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			...headers,
		},
		body: JSON.stringify(msg),
	});
	const type = res.headers.get('content-type') ?? '';
	if (type.includes('text/event-stream')) {
		const text = await res.text();
		const data = text
			.split('\n')
			.filter((l) => l.startsWith('data:'))
			.map((l) => l.slice(5).trim());
		return JSON.parse(data[data.length - 1]);
	}
	return res.json();
}

async function smokeHttp() {
	console.log('\n-- http --');
	const port = 8917;
	const child = spawn(process.execPath, ['dist/http.js'], {
		env: { ...process.env, PORT: String(port), PARSEAPI_KEY: '' },
		stdio: ['ignore', 'inherit', 'inherit'],
	});
	await sleep(600);

	// The gate passes any key-shaped credential through; the SDK answers
	// invalid_api_key on calls. Keyless is a 401 at the door (OAuth funnel).
	const dummyKey = { 'x-api-key': 'parse_smoke00000000000000000' };

	try {
		const health = await fetch(`http://127.0.0.1:${port}/health`);
		check('http /health 200', health.status === 200);

		const resource = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`);
		const resourceBody = await resource.json().catch(() => null);
		check(
			'http protected-resource metadata points at the auth server',
			resource.status === 200 && Array.isArray(resourceBody?.authorization_servers) && resourceBody.authorization_servers.length === 1,
			JSON.stringify(resourceBody).slice(0, 200)
		);

		const keyless = await fetch(`http://127.0.0.1:${port}/`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
		});
		check(
			'http keyless is 401 with WWW-Authenticate',
			keyless.status === 401 && (keyless.headers.get('www-authenticate') ?? '').includes('resource_metadata'),
			`status ${keyless.status}`
		);

		const init = await postRpc(port, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'parseapi-mcp-smoke', version: '0.0.0' },
			},
		}, dummyKey);
		check('http initialize answers', init.result?.serverInfo?.name === 'parseapi', JSON.stringify(init).slice(0, 200));

		const list = await postRpc(port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, dummyKey);
		const names = (list.result?.tools ?? []).map((t) => t.name);
		check('http tools/list has 45 tools (no ip_self)', names.length === 45 && !names.includes('ip_self'), `got ${names.length}`);
		check('http has vat', names.includes('vat'));
		check('http has iban', names.includes('iban'));
		check('http has npi', names.includes('npi'));
		check('http has vin', names.includes('vin'));
		check('http has no sanctions', !names.includes('sanctions'));
		check('http has hts', names.includes('hts') && names.includes('hts_search'));

		const funnel = await postRpc(port, {
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'postal', arguments: { code: '28202', country: 'US' } },
		}, dummyKey);
		const funnelBody = toolText(funnel.result);
		check(
			'http bad-key call funnels to signup',
			funnel.result?.isError === true && funnelBody.code === 'invalid_api_key',
			JSON.stringify(funnel).slice(0, 300)
		);

		if (KEY) {
			const live = await postRpc(
				port,
				{
					jsonrpc: '2.0',
					id: 4,
					method: 'tools/call',
					params: { name: 'postal', arguments: { code: '28202', country: 'US' } },
				},
				{ 'x-api-key': KEY }
			);
			const body = toolText(live.result);
			check('http live postal via X-API-Key', body.city === 'Charlotte', JSON.stringify(body).slice(0, 200));
		} else {
			console.log('skip live http call (no PARSEAPI_KEY)');
		}
	} finally {
		child.kill();
		await once(child, 'exit').catch(() => {});
	}
}

await smokeStdio();
await smokeHttp();

console.log('');
if (failures > 0) {
	console.log(`${failures} failure(s)`);
	process.exit(1);
}
console.log('smoke green');
