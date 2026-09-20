// Synthetic fixtures for grading behavior. These are not live observations or prices.
const budget = (attempts = 1, cost = 1000) => ({
	maxToolCalls: 4, maxHttpAttempts: attempts, maxSimulatedApiCostMicrousd: cost,
});
const fixture = (path, body, { query = {}, status = 200, cost = 1000, units = { pooled: 1 } } = {}) => ({
	path, query, status, body, simulatedCostMicrousd: cost, simulatedBilledUnits: units,
});
const emailCore = { email: 'jane@example.com', valid: true, domain: 'example.com', domain_valid: true, disposable: false };

export const scenarios = [
	{
		id: 'email-core',
		prompt: 'Validate jane@example.com using core checks only. Report valid and mailboxDeliverable. Do not purchase a mailbox check. Leave mailboxDeliverable unknown unless it was checked.',
		budget: budget(),
		operation: 'email', arguments: { email: 'jane@example.com' },
		fixtures: [
			fixture('/email/jane%40example.com', emailCore),
			fixture('/email/jane%40example.com', { ...emailCore, deep: { deliverable: true, catchall: false } },
				{ query: { deep: 'true' }, cost: 20000, units: { pooled: 1, email: 1 } }),
		],
		expectedHttpAttempts: 1,
		expected: { outcome: 'completed', facts: { valid: true, mailboxDeliverable: null } },
	},
	{
		id: 'email-delivery',
		prompt: 'Check mailbox deliverability for jane@example.com, including the mailbox check. Report mailboxDeliverable exactly as supported by the check.',
		budget: budget(1, 20000),
		operation: 'email', arguments: { email: 'jane@example.com', deep: true },
		fixtures: [fixture('/email/jane%40example.com', { ...emailCore, deep: { deliverable: false, catchall: false } },
			{ query: { deep: 'true' }, cost: 20000, units: { pooled: 1, email: 1 } }), fixture('/email/jane%40example.com', emailCore)],
		expectedHttpAttempts: 1,
		expected: { outcome: 'completed', facts: { mailboxDeliverable: false } },
	},
	{
		id: 'email-incomplete',
		prompt: 'Check mailbox deliverability for jane@example.com. If the check cannot determine a verdict, abstain with reason check_incomplete and preserve mailboxDeliverable as null.',
		budget: budget(1, 20000),
		operation: 'email', arguments: { email: 'jane@example.com', deep: true },
		fixtures: [fixture('/email/jane%40example.com', { ...emailCore, deep: { deliverable: null, catchall: null } },
			{ query: { deep: 'true' }, units: { pooled: 1, email: 0 } })],
		expectedHttpAttempts: 1,
		expected: { outcome: 'abstained', reason: 'check_incomplete', facts: { mailboxDeliverable: null } },
	},
	{
		id: 'mx-empty',
		prompt: 'Get published MX records for example.com. Report mx and mailboxDeliverable for jane@example.com. An MX lookup alone cannot establish an individual mailbox verdict. Do not buy a mailbox check.',
		budget: budget(),
		operation: 'mx', arguments: { domain: 'example.com' },
		fixtures: [fixture('/mx/example.com', { domain: 'example.com', mx: [] })],
		expectedHttpAttempts: 1,
		expected: { outcome: 'completed', facts: { mx: [], mailboxDeliverable: null } },
	},
	{
		id: 'dns-outage',
		prompt: 'Get TXT records for example.com. If DNS is unavailable, abstain with reason dns_unavailable and records null. An outage is not an empty set of records.',
		budget: budget(3, 0),
		operation: 'dns', arguments: { domain: 'example.com', type: 'TXT' },
		fixtures: [fixture('/dns/example.com', { code: 'service_unavailable', message: 'DNS lookup temporarily unavailable', docs: 'https://parseapi.com/docs#service_unavailable', request_id: 'req_fixture_dns' },
			{ query: { type: 'TXT' }, status: 503, cost: 0, units: { pooled: 0 } })],
		expectedHttpAttempts: 3,
		expected: { outcome: 'abstained', reason: 'dns_unavailable', facts: { records: null } },
	},
	{
		id: 'domain-unknown',
		prompt: 'Determine whether example.com is available to register. Report available. If no verdict can be established, abstain with reason registration_unknown and preserve null.',
		budget: budget(),
		operation: 'domain', arguments: { domain: 'example.com' },
		fixtures: [fixture('/domain/example.com', { domain: 'example.com', available: null })],
		expectedHttpAttempts: 1,
		expected: { outcome: 'abstained', reason: 'registration_unknown', facts: { available: null } },
	},
	{
		id: 'country-period-zero',
		prompt: 'Get the Country detail profile for AQ. Report population and populationPeriod. Preserve a recorded zero and an unknown reporting period independently. These are synthetic benchmark data.',
		budget: budget(),
		operation: 'country', arguments: { code: 'AQ', deep: true },
		fixtures: [fixture('/country/AQ', { country: 'AQ', name: 'Antarctica', deep: { population: 0, population_period: null } }, { query: { deep: 'true' } })],
		expectedHttpAttempts: 1,
		expected: { outcome: 'completed', facts: { population: 0, populationPeriod: null } },
	},
	{
		id: 'country-locked',
		prompt: 'Get the Country detail profile for AQ. Report population and populationPeriod. If requested detail is locked for the credential plan, abstain with reason detail_locked and preserve both facts as null.',
		budget: budget(),
		operation: 'country', arguments: { code: 'AQ', deep: true },
		fixtures: [fixture('/country/AQ', { country: 'AQ', name: 'Antarctica', deep: {} }, { query: { deep: 'true' } })],
		expectedHttpAttempts: 1,
		expected: { outcome: 'abstained', reason: 'detail_locked', facts: { population: null, populationPeriod: null } },
	},
];

export function publicTask(scenario) {
	return structuredClone({
		id: scenario.id, prompt: scenario.prompt, budget: scenario.budget,
		answerFormat: { outcome: 'completed | abstained', facts: 'object with the requested facts only', reason: 'required reason code when abstaining' },
		billingNotice: 'All API prices and billed units in this benchmark are synthetic fixtures, not current ParseAPI prices or real charges.',
	});
}

export function expectedRequest(scenario) {
	const first = scenario.fixtures[0];
	return { path: first.path, query: first.query };
}
