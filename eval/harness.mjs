import { InMemoryTransport } from '@modelcontextprotocol/server';
import { isDeepStrictEqual } from 'node:util';
import { buildServer } from '../dist/registry.js';
import { gradeScenario } from './grade.mjs';
import { publicTask, scenarios } from './scenarios.mjs';

const bytes = value => Buffer.byteLength(JSON.stringify(value));
let running = false;

export function fixtureFetch(scenario, attempts) {
	return async (input, init = {}) => {
		const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
		const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
		const query = Object.fromEntries(url.searchParams);
		const method = init.method ?? (input instanceof Request ? input.method : 'GET');
		const match = url.origin === 'https://api.parseapi.com' && method === 'GET'
			? scenario.fixtures.find(item => item.path === url.pathname && isDeepStrictEqual(item.query, query)) : undefined;
		const attempt = {
			path: url.pathname, query, matched: Boolean(match), apiVersion: headers.get('parse-version'),
			status: match?.status ?? null,
			simulatedCostMicrousd: match?.simulatedCostMicrousd ?? 0,
			simulatedBilledUnits: structuredClone(match?.simulatedBilledUnits ?? {}),
		};
		attempts.push(attempt);
		if (!match) throw new Error('Offline benchmark rejected a request outside its explicit fixtures.');
		init.signal?.throwIfAborted();
		if (match.delayMs) await new Promise((resolve, reject) => {
			const onAbort = () => { clearTimeout(timer); attempt.aborted = true; reject(init.signal.reason); };
			const timer = setTimeout(() => { init.signal?.removeEventListener('abort', onAbort); resolve(); }, match.delayMs);
			init.signal?.addEventListener('abort', onAbort, { once: true });
		});
		return new Response(JSON.stringify(match.body), { status: match.status, headers: { 'content-type': 'application/json', 'retry-after': '0' } });
	};
}

async function connect(mode) {
	const server = buildServer('offline_fixture_key', 'http', { mode });
	const [client, peer] = InMemoryTransport.createLinkedPair();
	let nextId = 0;
	const pending = new Map();
	client.onmessage = message => {
		const waiting = pending.get(message.id);
		if (waiting) {
			clearTimeout(waiting.timer);
			pending.delete(message.id);
			if (message.error) waiting.reject(new Error(`MCP ${message.error.code}: ${message.error.message}`));
			else waiting.resolve(message.result);
		}
	};
	const request = (method, params) => new Promise((resolve, reject) => {
		const id = ++nextId;
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`Offline MCP request timed out: ${method}`));
		}, 10000);
		pending.set(id, { resolve, reject, timer });
		client.send({ jsonrpc: '2.0', id, method, params }).catch(error => {
			clearTimeout(timer);
			pending.delete(id);
			reject(error);
		});
	});
	await server.connect(peer);
	await client.start();
	await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'parseapi-offline-eval', version: '1.0.0' } });
	await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
	return {
		request,
		async close() {
			// Cancellation reaches each MCP handler's signal before the fetch stub
			// is restored. Closing also aborts request handlers in the MCP SDK.
			for (const id of pending.keys()) await client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Offline benchmark task finished' } });
			await client.close();
			await server.close();
			for (const item of pending.values()) {
				clearTimeout(item.timer);
				item.reject(new Error('Offline MCP connection closed'));
			}
			pending.clear();
		},
	};
}

// Sequential by design: the SDK uses global fetch, replaced only for this run.
export async function runScenario(scenario, { adapter, mode = 'full', timeoutMs = 30000 }) {
	if (running) throw new Error('Run offline benchmark scenarios sequentially.');
	if (!['full', 'compact'].includes(mode)) throw new Error('Unknown benchmark mode.');
	if (typeof adapter?.run !== 'function') throw new TypeError('Adapter must export async run({ task, mode, tools, callTool, signal }).');
	running = true;
	const previousFetch = globalThis.fetch;
	const httpAttempts = [];
	const toolCalls = [];
	const controller = new AbortController();
	const pendingCalls = new Set();
	const allCalls = [];
	let active = true;
	let rpc;
	let timer;
	let run;
	globalThis.fetch = fixtureFetch(scenario, httpAttempts);
	const started = performance.now();
	try {
		rpc = await connect(mode);
		const { tools } = await rpc.request('tools/list', {});
		const advertised = new Set(tools.map(tool => tool.name));
		if (!advertised.has('discover') || !advertised.has('preflight') || (mode === 'compact' && (!advertised.has('lookup') || tools.length !== 3))) {
			throw new Error('Build the MCP discovery/compact implementation before running this benchmark.');
		}
		const callTool = (name, args = {}) => {
			const promise = (async () => {
			if (!active || controller.signal.aborted) throw new Error('Benchmark task is closed.');
			if (toolCalls.length >= 24) throw new Error('Benchmark safety limit: 24 tool calls per task.');
			const call = { name, arguments: structuredClone(args), requestBytes: bytes({ name, arguments: args }) };
			toolCalls.push(call);
			if (!advertised.has(name)) {
				call.error = 'tool_not_advertised';
				throw new Error(`Tool is not advertised in ${mode} mode: ${name}`);
			}
			const result = await rpc.request('tools/call', { name, arguments: args });
			call.resultBytes = bytes(result);
			call.result = structuredClone(result);
			return structuredClone(result);
			})();
			pendingCalls.add(promise);
			allCalls.push(promise);
			// An adapter can forget to await its callback. Retain and handle the
			// exact promise, then cancel and drain it during teardown.
			promise.then(() => pendingCalls.delete(promise), () => pendingCalls.delete(promise));
			return promise;
		};
		let returned;
		let error;
		try {
			returned = await Promise.race([
				adapter.run({ task: publicTask(scenario), mode, tools: structuredClone(tools), callTool, signal: controller.signal }),
				new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Adapter task timed out.')); }, timeoutMs); }),
			]);
		} catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
		clearTimeout(timer);
		active = false;
		if (pendingCalls.size && !error) error = 'Adapter returned with unawaited tool calls.';
		run = { mode, answer: returned?.answer, usage: returned?.usage, error, httpAttempts, toolCalls,
			catalogBytes: bytes(tools), latencyMs: Math.round((performance.now() - started) * 1000) / 1000 };
	} finally {
		active = false;
		clearTimeout(timer);
		controller.abort();
		try {
			await rpc?.close();
			await Promise.allSettled(allCalls);
			// Drain cancellation continuations while the rejecting fixture fetch
			// remains installed. SDK retry sleeps use the now-aborted MCP signal.
			await new Promise(resolve => setImmediate(resolve));
		} finally { globalThis.fetch = previousFetch; running = false; }
	}
	return { score: gradeScenario(scenario, run), trace: run };
}

const sumKnown = (rows, field) => rows.every(row => row.modelUsage[field] !== null)
	? rows.reduce((sum, row) => sum + row.modelUsage[field], 0) : null;

export async function runBenchmark({ adapter, modes = ['full', 'compact'], tasks = scenarios }) {
	const results = [];
	for (const mode of modes) for (const scenario of tasks) results.push(await runScenario(scenario, { adapter, mode }));
	const scores = results.map(result => result.score);
	return {
		benchmark: 'parseapi-agent-offline-v1',
		adapter: adapter.kind ?? 'supplied adapter; inspect its source and measured usage provenance',
		limitations: [
			'Synthetic API responses, prices and billed units. No live API calls.',
			'Tokens and model cost remain null unless the adapter supplies measured usage with a source.',
			'Latency measures this local harness and adapter, not production service latency.',
			'A scripted reference replay validates the harness, not agent task quality.',
		],
		byMode: Object.fromEntries(modes.map(mode => {
			const rows = scores.filter(score => score.mode === mode);
			return [mode, {
				tasks: rows.length, passed: rows.filter(row => row.passed).length,
				taskSuccessRate: rows.length ? rows.filter(row => row.passed).length / rows.length : null,
				correctCompletions: rows.filter(row => row.correctCompletion).length,
				justifiedAbstentions: rows.filter(row => row.justifiedAbstention).length,
				uncertaintyMistakes: rows.reduce((sum, row) => sum + row.uncertaintyMistakes, 0),
				factualMistakes: rows.reduce((sum, row) => sum + row.factualMistakes, 0),
				budgetViolations: rows.reduce((sum, row) => sum + row.budgetViolations.length, 0),
				httpAttempts: rows.reduce((sum, row) => sum + row.httpAttempts, 0),
				unnecessaryHttpAttempts: rows.reduce((sum, row) => sum + row.unnecessaryHttpAttempts, 0),
				toolCalls: rows.reduce((sum, row) => sum + row.toolCalls, 0),
				catalogBytes: rows[0]?.catalogBytes ?? null,
				latencyMs: rows.reduce((sum, row) => sum + row.latencyMs, 0),
				inputTokens: sumKnown(rows, 'inputTokens'), outputTokens: sumKnown(rows, 'outputTokens'), modelCostUsd: sumKnown(rows, 'modelCostUsd'),
				simulatedApiCostMicrousd: rows.reduce((sum, row) => sum + row.simulatedApiBilling.costMicrousd, 0),
				totalLiveCostUsd: null,
			}];
		})),
		scores, traces: results.map(result => result.trace),
	};
}
