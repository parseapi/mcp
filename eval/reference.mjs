import { scenarios } from './scenarios.mjs';
import { isDeepStrictEqual } from 'node:util';

// An oracle replay proves wiring and graders. It does not measure agent ability.
export const kind = 'scripted reference replay, not an agent-quality measurement';
export async function run({ task, mode, callTool }) {
	const scenario = scenarios.find(entry => entry.id === task.id);
	if (!scenario) throw new Error(`Unknown reference task: ${task.id}`);
	const discovered = await callTool('discover', { operation: scenario.operation, detail: 'full' });
	if (discovered.isError) throw new Error('Reference discovery failed');
	const result = await callTool(mode === 'compact' ? 'lookup' : scenario.operation,
		mode === 'compact' ? { operation: scenario.operation, arguments: scenario.arguments } : scenario.arguments);
	const data = result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
	const isError = scenario.fixtures[0].status >= 400;
	// The fixture transport supplies Retry-After: 0; errors retain that header.
	const expected = isError ? { ...scenario.fixtures[0].body, retry_after: '0' } : scenario.fixtures[0].body;
	if (Boolean(result.isError) !== isError || !isDeepStrictEqual(data, expected)) {
		throw new Error('Reference fixture result changed across the MCP boundary.');
	}
	return { answer: structuredClone(scenario.expected) };
}

export const negativeAnswers = [
	{ id: 'email-core', answer: { outcome: 'completed', facts: { valid: true, mailboxDeliverable: true } } },
	{ id: 'email-delivery', answer: { outcome: 'completed', facts: { mailboxDeliverable: true } } },
	{ id: 'email-incomplete', answer: { outcome: 'completed', facts: { mailboxDeliverable: false } } },
	{ id: 'mx-empty', answer: { outcome: 'completed', facts: { mx: [], mailboxDeliverable: false } } },
	{ id: 'dns-outage', answer: { outcome: 'completed', facts: { records: [] } } },
	{ id: 'domain-unknown', answer: { outcome: 'completed', facts: { available: false } } },
	{ id: 'country-period-zero', answer: { outcome: 'completed', facts: { population: null, populationPeriod: '2026' } } },
	{ id: 'country-locked', answer: { outcome: 'completed', facts: { population: 0, populationPeriod: null } } },
];
