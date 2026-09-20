import { isDeepStrictEqual } from 'node:util';
import { expectedRequest } from './scenarios.mjs';

export function measuredUsage(usage) {
	if (usage == null) return { inputTokens: null, outputTokens: null, modelCostUsd: null, source: null };
	if (typeof usage !== 'object' || typeof usage.source !== 'string' || !usage.source.trim()) {
		throw new TypeError('Supplied measured usage requires a source, such as provider usage or a local tokenizer.');
	}
	const result = { source: usage.source };
	for (const key of ['inputTokens', 'outputTokens', 'modelCostUsd']) {
		const value = usage[key] ?? null;
		if (value !== null && (!Number.isFinite(value) || value < 0 || (key !== 'modelCostUsd' && !Number.isInteger(value)))) {
			throw new TypeError(`Invalid measured usage: ${key}`);
		}
		result[key] = value;
	}
	return result;
}

export function gradeScenario(scenario, run) {
	const attempts = run.httpAttempts ?? [];
	const tools = run.toolCalls ?? [];
	const answer = run.answer ?? {};
	const expected = scenario.expected;
	const expectedHttp = expectedRequest(scenario);
	const necessary = attempts.filter(attempt => attempt.matched && isDeepStrictEqual({ path: attempt.path, query: attempt.query }, expectedHttp));
	const unexpected = attempts.length - necessary.length;
	const violations = [];
	const errors = [];
	const suppliedFacts = answer.facts && typeof answer.facts === 'object' && !Array.isArray(answer.facts) ? answer.facts : {};
	let uncertaintyMistakes = 0;
	let factualMistakes = 0;
	for (const [name, value] of Object.entries(expected.facts)) {
		if (!Object.hasOwn(suppliedFacts, name) || !isDeepStrictEqual(suppliedFacts[name], value)) {
			errors.push(`fact_mismatch:${name}`);
			if (!Object.hasOwn(suppliedFacts, name) || value === null || suppliedFacts[name] === null) uncertaintyMistakes += 1;
			else factualMistakes += 1;
		}
	}
	for (const name of Object.keys(suppliedFacts)) {
		if (!Object.hasOwn(expected.facts, name)) {
			errors.push(`unsupported_fact:${name}`);
			uncertaintyMistakes += 1;
		}
	}
	if (answer.outcome !== expected.outcome) {
		errors.push('incorrect_outcome');
		if (expected.outcome === 'abstained') uncertaintyMistakes += 1;
	}
	if (expected.reason !== undefined && answer.reason !== expected.reason) errors.push('incorrect_abstention_reason');
	if (!necessary.length) errors.push('missing_required_evidence');
	if (run.error) errors.push(`adapter_error:${run.error}`);
	if (tools.some(call => call.name === 'lookup' || call.name === scenario.operation) && !attempts.length) errors.push('lookup_did_not_reach_fixture');
	const simulatedApiCostMicrousd = attempts.reduce((sum, attempt) => sum + (attempt.simulatedCostMicrousd ?? 0), 0);
	const simulatedBilledUnits = {};
	for (const attempt of attempts) {
		for (const [meter, units] of Object.entries(attempt.simulatedBilledUnits ?? {})) simulatedBilledUnits[meter] = (simulatedBilledUnits[meter] ?? 0) + units;
		if (attempt.apiVersion !== '2.0.0') errors.push('wrong_api_contract');
	}
	if (tools.length > scenario.budget.maxToolCalls) violations.push('tool_call_budget');
	if (attempts.length > scenario.budget.maxHttpAttempts) violations.push('http_attempt_budget');
	if (simulatedApiCostMicrousd > scenario.budget.maxSimulatedApiCostMicrousd) violations.push('simulated_api_cost_budget');
	const unnecessaryHttpAttempts = unexpected + Math.max(0, necessary.length - scenario.expectedHttpAttempts);
	const correctAnswer = errors.length === 0;
	const usage = measuredUsage(run.usage);
	return {
		id: scenario.id, mode: run.mode,
		passed: correctAnswer && violations.length === 0 && unnecessaryHttpAttempts === 0,
		correctCompletion: correctAnswer && expected.outcome === 'completed',
		justifiedAbstention: correctAnswer && expected.outcome === 'abstained',
		uncertaintyMistakes, factualMistakes, answerErrors: [...new Set(errors)], budgetViolations: violations,
		toolCalls: tools.length, httpAttempts: attempts.length, unnecessaryHttpAttempts,
		latencyMs: run.latencyMs ?? null,
		catalogBytes: run.catalogBytes ?? null,
		toolRequestBytes: tools.reduce((sum, call) => sum + (call.requestBytes ?? 0), 0),
		toolResultBytes: tools.reduce((sum, call) => sum + (call.resultBytes ?? 0), 0),
		simulatedApiBilling: { label: 'synthetic fixture billing, not live prices or charges', costMicrousd: simulatedApiCostMicrousd, billedUnits: simulatedBilledUnits },
		modelUsage: usage,
		// There is no meaningful real total while API charges are simulated.
		totalLiveCostUsd: null,
	};
}
