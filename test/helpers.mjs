import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { buildServer } from '../dist/registry.js';

/** Exercise the MCP wire protocol without a socket or a second client dependency. */
export async function connect(key = 'test_key', transport = 'stdio') {
	const server = buildServer(key, transport);
	const [client, peer] = InMemoryTransport.createLinkedPair();
	const pending = new Map();
	let nextId = 1;
	client.onmessage = (message) => {
		if (message.id !== undefined) pending.get(message.id)?.(message);
	};
	function startRequest(method, params) {
		const id = nextId++;
		const response = new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`MCP request timed out: ${method}`));
			}, 2000);
			pending.set(id, (message) => {
				clearTimeout(timer);
				pending.delete(id);
				resolve(message);
			});
			client.send({ jsonrpc: '2.0', id, method, params }).catch(reject);
		});
		return { id, response };
	}
	const request = (method, params) => startRequest(method, params).response;
	await server.connect(peer);
	await client.start();
	const initialized = await request('initialize', {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'parseapi-offline-test', version: '0.0.0' },
	});
	assert.equal(initialized.result?.serverInfo.name, 'parseapi');
	await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
	return {
		request,
		startRequest,
		call: (name, args) => request('tools/call', { name, arguments: args }),
		notify: (method, params) => client.send({ jsonrpc: '2.0', method, params }),
		close: async () => {
			for (const [id, resolve] of pending) resolve({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Test connection closed' } });
			await client.close();
			await server.close();
		},
	};
}

export function body(message) {
	assert.equal(message.error, undefined, JSON.stringify(message.error));
	return JSON.parse(message.result.content[0].text);
}

export function publicSurface(tools) {
	const clean = (value) => {
		if (Array.isArray(value)) return value.map(clean);
		if (!value || typeof value !== 'object') return value;
		return Object.fromEntries(Object.entries(value)
			.filter(([key]) => !['description', 'title', '$schema'].includes(key))
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, value]) => [key, clean(value)]));
	};
	return tools.map(({ name, inputSchema, annotations }) => ({ name, inputSchema: clean(inputSchema), annotations }))
		.sort((a, b) => a.name.localeCompare(b.name));
}
