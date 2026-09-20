import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gradeScenario, measuredUsage } from '../eval/grade.mjs';
import { fixtureFetch, runBenchmark, runScenario } from '../eval/harness.mjs';
import { scenarios, publicTask } from '../eval/scenarios.mjs';
import * as reference from '../eval/reference.mjs';

function referenceTrace(scenario) {
	const fixture = scenario.fixtures[0];
	return {
		mode: 'full', answer: structuredClone(scenario.expected),
		httpAttempts: Array.from({ length: scenario.expectedHttpAttempts }, () => ({
			path: fixture.path, query: structuredClone(fixture.query), matched: true, apiVersion: '2.0.0', status: fixture.status,
			simulatedCostMicrousd: fixture.simulatedCostMicrousd, simulatedBilledUnits: structuredClone(fixture.simulatedBilledUnits),
		})),
		toolCalls: [{ name: 'discover' }, { name: scenario.operation }],
	};
}

test('offline task reference and negative traces distinguish correct facts and uncertainty mistakes', () => {
	for (const scenario of scenarios) {
		const trace = referenceTrace(scenario);
		const good = gradeScenario(scenario, trace);
		assert.equal(good.passed, true, scenario.id);
		assert.equal(good.correctCompletion, scenario.expected.outcome === 'completed');
		assert.equal(good.justifiedAbstention, scenario.expected.outcome === 'abstained');
		const bad = gradeScenario(scenario, { ...trace, answer: reference.negativeAnswers.find(entry => entry.id === scenario.id).answer });
		assert.equal(bad.passed, false, scenario.id);
		assert.ok(bad.uncertaintyMistakes + bad.factualMistakes > 0, scenario.id);
	}
});

test('wrong known facts are separated from invented certainty or lost zero values', () => {
	const delivery = scenarios.find(entry => entry.id === 'email-delivery');
	const knownWrong = gradeScenario(delivery, { ...referenceTrace(delivery), answer: { outcome: 'completed', facts: { mailboxDeliverable: true } } });
	assert.equal(knownWrong.factualMistakes, 1);
	assert.equal(knownWrong.uncertaintyMistakes, 0);
	const country = scenarios.find(entry => entry.id === 'country-period-zero');
	const lostZero = gradeScenario(country, { ...referenceTrace(country), answer: { outcome: 'completed', facts: { population: null, populationPeriod: null } } });
	assert.equal(lostZero.uncertaintyMistakes, 1);
	assert.equal(lostZero.factualMistakes, 0);
	const fabricatedPeriod = gradeScenario(country, { ...referenceTrace(country), answer: { outcome: 'completed', facts: { population: 0, populationPeriod: '2026' } } });
	assert.equal(fabricatedPeriod.uncertaintyMistakes, 1);
	assert.equal(fabricatedPeriod.factualMistakes, 0);
});

test('DNS outage fixture preserves the production error code and help link', () => {
	const outage = scenarios.find(entry => entry.id === 'dns-outage').fixtures[0];
	assert.equal(outage.status, 503);
	assert.equal(outage.body.code, 'service_unavailable');
	assert.equal(outage.body.docs, 'https://parseapi.com/docs#service_unavailable');
});

test('plausible answers without lookup evidence cannot pass', () => {
	const scenario = scenarios[0];
	const score = gradeScenario(scenario, { ...referenceTrace(scenario), httpAttempts: [], toolCalls: [] });
	assert.equal(score.passed, false);
	assert.ok(score.answerErrors.includes('missing_required_evidence'));
});

test('invented extra facts and unjustified abstention fail the grader', () => {
	const scenario = scenarios[0];
	const trace = referenceTrace(scenario);
	const extra = gradeScenario(scenario, { ...trace, answer: { ...trace.answer, facts: { ...trace.answer.facts, verifiedIdentity: true } } });
	assert.equal(extra.passed, false);
	assert.ok(extra.answerErrors.includes('unsupported_fact:verifiedIdentity'));
	const abstained = gradeScenario(scenario, { ...trace, answer: { ...trace.answer, outcome: 'abstained', reason: 'unknown' } });
	assert.equal(abstained.passed, false);
	assert.equal(abstained.justifiedAbstention, false);
	const unknown = scenarios.find(entry => entry.id === 'domain-unknown');
	const wrongReason = gradeScenario(unknown, { ...referenceTrace(unknown), answer: { ...unknown.expected, reason: 'not_registered' } });
	assert.ok(wrongReason.answerErrors.includes('incorrect_abstention_reason'));
});

test('unnecessary calls, HTTP retries, synthetic cost and tool budgets are scored independently', () => {
	const scenario = scenarios[0];
	const trace = referenceTrace(scenario);
	trace.httpAttempts.push({ ...trace.httpAttempts[0], query: { deep: 'true' }, simulatedCostMicrousd: 20000, simulatedBilledUnits: { pooled: 1, email: 1 } });
	trace.toolCalls.push(...Array.from({ length: 3 }, () => ({ name: 'discover' })));
	const score = gradeScenario(scenario, trace);
	assert.equal(score.correctCompletion, true, 'A fact can be correct while its task exceeded the budget.');
	assert.equal(score.passed, false);
	assert.equal(score.unnecessaryHttpAttempts, 1);
	assert.deepEqual(score.budgetViolations, ['tool_call_budget', 'http_attempt_budget', 'simulated_api_cost_budget']);
	assert.equal(score.simulatedApiBilling.costMicrousd, 21000);
	assert.equal(score.simulatedApiBilling.billedUnits.email, 1);
	const outage = scenarios.find(entry => entry.id === 'dns-outage');
	assert.equal(gradeScenario(outage, referenceTrace(outage)).unnecessaryHttpAttempts, 0);
	const duplicate = referenceTrace(scenario);
	duplicate.httpAttempts.push({ ...duplicate.httpAttempts[0] });
	assert.equal(gradeScenario(scenario, duplicate).unnecessaryHttpAttempts, 1);
});

test('a changed API version fails even when answer facts happen to match', () => {
	const scenario = scenarios[0];
	const trace = referenceTrace(scenario);
	trace.httpAttempts[0].apiVersion = null;
	const score = gradeScenario(scenario, trace);
	assert.equal(score.passed, false);
	assert.ok(score.answerErrors.includes('wrong_api_contract'));
});

test('measured model usage stays unknown unless explicitly supplied with provenance', () => {
	const scenario = scenarios[0];
	const unmeasured = gradeScenario(scenario, { ...referenceTrace(scenario), catalogBytes: 42000 });
	assert.deepEqual(unmeasured.modelUsage, { inputTokens: null, outputTokens: null, modelCostUsd: null, source: null });
	assert.equal(unmeasured.totalLiveCostUsd, null);
	const measured = measuredUsage({ source: 'provider receipt in test fixture', inputTokens: 100, outputTokens: 25, modelCostUsd: 0.0001 });
	assert.equal(measured.inputTokens, 100);
	assert.equal(measured.modelCostUsd, 0.0001);
	assert.equal(measuredUsage({ source: 'tokenizer', inputTokens: 100 }).modelCostUsd, null);
	for (const usage of [{ inputTokens: 1 }, { source: 'test', inputTokens: -1 }, { source: 'test', outputTokens: 1.5 }, { source: 'test', modelCostUsd: NaN }]) {
		assert.throws(() => measuredUsage(usage), TypeError);
	}
});

test('adapter tasks omit fixture and answer oracles and return independent copies', () => {
	const scenario = scenarios[0];
	const task = publicTask(scenario);
	for (const key of ['expected', 'fixtures', 'operation', 'arguments', 'expectedHttpAttempts']) assert.equal(Object.hasOwn(task, key), false);
	task.budget.maxHttpAttempts = 100;
	assert.equal(scenario.budget.maxHttpAttempts, 1);
});

test('offline fetch rejects unmatched hosts, requests and query arguments without forwarding', async () => {
	const scenario = scenarios[0];
	const attempts = [];
	const fetch = fixtureFetch(scenario, attempts);
	const headers = { 'parse-version': '2.0.0' };
	assert.equal((await fetch(`https://api.parseapi.com${scenario.fixtures[0].path}`, { headers })).status, 200);
	for (const url of ['https://example.net/email/jane%40example.com', 'https://api.parseapi.com/email/other%40example.com', 'https://api.parseapi.com/email/jane%40example.com?unknown=true']) {
		await assert.rejects(fetch(url, { headers }), /Offline benchmark rejected/);
	}
	await assert.rejects(fetch(`https://api.parseapi.com${scenario.fixtures[0].path}`, { method: 'POST', headers }), /Offline benchmark rejected/);
	assert.equal(attempts.length, 5);
	assert.equal(attempts.filter(item => item.matched).length, 1);
});

test('scripted reference replay exercises every fixture through both real MCP modes', async () => {
	const before = globalThis.fetch;
	const report = await runBenchmark({ adapter: reference });
	assert.equal(globalThis.fetch, before);
	assert.equal(report.scores.length, scenarios.length * 2);
	for (const score of report.scores) assert.equal(score.passed, true, JSON.stringify(score));
	for (const mode of ['full', 'compact']) {
		assert.equal(report.byMode[mode].passed, scenarios.length);
		assert.equal(report.byMode[mode].correctCompletions, 4);
		assert.equal(report.byMode[mode].justifiedAbstentions, 4);
		assert.equal(report.byMode[mode].httpAttempts, 10);
		assert.equal(report.byMode[mode].inputTokens, null);
		assert.equal(report.byMode[mode].modelCostUsd, null);
		assert.equal(report.byMode[mode].totalLiveCostUsd, null);
	}
	assert.ok(report.byMode.compact.catalogBytes < report.byMode.full.catalogBytes);
	const incomplete = report.scores.find(score => score.id === 'email-incomplete');
	assert.equal(incomplete.simulatedApiBilling.billedUnits.email, 0);
});

test('adapter integration catches a paid check outside the task budget', async () => {
	const scenario = scenarios[0];
	const adapter = {
		async run({ callTool }) {
			await callTool('email', { email: 'jane@example.com' });
			await callTool('email', { email: 'jane@example.com', deep: true });
			return { answer: structuredClone(scenario.expected) };
		},
	};
	const { score } = await runScenario(scenario, { adapter });
	assert.equal(score.passed, false);
	assert.equal(score.unnecessaryHttpAttempts, 1);
	assert.ok(score.budgetViolations.includes('simulated_api_cost_budget'));
});

test('unawaited and timed-out adapters cancel SDK work before restoring fetch', async () => {
	const scenario = structuredClone(scenarios.find(entry => entry.id === 'dns-outage'));
	// Make a request remain in fetch so cleanup races against real SDK work.
	// Without cancellation this 503 would schedule retries after restoration.
	scenario.fixtures[0].delayMs = 30;
	const previous = globalThis.fetch;
	let escaped = 0;
	const rejectingOriginal = async () => { escaped += 1; throw new Error('Unexpected escaped fetch'); };
	globalThis.fetch = rejectingOriginal;
	try {
		for (const timedOut of [false, true]) {
			const adapter = { async run({ callTool }) {
				callTool('dns', { domain: 'example.com', type: 'TXT' });
				if (timedOut) await new Promise(resolve => setTimeout(resolve, 60));
				else await new Promise(resolve => setImmediate(resolve));
				return { answer: structuredClone(scenario.expected) };
			} };
			const result = await runScenario(scenario, { adapter, timeoutMs: timedOut ? 10 : 1000 });
			assert.equal(result.score.passed, false);
			assert.match(result.trace.error, timedOut ? /timed out/ : /unawaited tool calls/);
			assert.equal(result.trace.httpAttempts.length, 1);
			assert.equal(result.trace.httpAttempts[0].aborted, true);
			assert.equal(globalThis.fetch, rejectingOriginal);
		}
		// Exceeds the fixture response delay and the SDK's two retry delays.
		await new Promise(resolve => setTimeout(resolve, 850));
		assert.equal(escaped, 0);
	} finally { globalThis.fetch = previous; }
});
