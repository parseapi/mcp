import type { McpServer } from '@modelcontextprotocol/server';
import { parseAPI } from '@parseapi/sdk';
import * as z from 'zod';
import { noKeyResult, ok, toErrorResult } from './errors.js';
import type { Transport } from './registry.js';

const task = z.strictObject({
	operations: z.array(z.strictObject({
		operation: z.enum(['email', 'domain', 'dns', 'mx', 'country']),
		count: z.number().int().min(1).max(100000),
		deep: z.boolean().optional(),
	})).min(1).max(20).refine(items => items.reduce((sum, item) => sum + item.count, 0) <= 100000, {
		message: 'The task can contain at most 100000 total lookups.',
	}),
	budget_usd: z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/).optional()
		.describe('Optional USD budget as a decimal string, e.g. 2.50. Advisory, never an enforced cap.'),
});

export function registerPreflight(server: McpServer, client: ReturnType<typeof parseAPI> | null, transport: Transport): void {
	server.registerTool('preflight', {
		description: 'Estimate whether your secret key permits a proposed Email, Domain, DNS, MX or Country task, its advisory capacity, and additional USD charges under accepted terms. Supply operation counts and optional Deep, without lookup inputs. Uses default SDK retries: up to three attempts per ordinary lookup and one per Email Deep lookup. Authenticated metadata request, no lookup units or paid checks. Reserves no units or money and does not enforce a budget. Check permitted, cost.status, capacity and budget before lookup.',
		inputSchema: task,
		annotations: { readOnlyHint: true, idempotentHint: true },
	}, async (args, context) => {
		if (!client) return noKeyResult(transport);
		try {
			const data = await client.preflight(args, { signal: context.mcpReq.signal });
			return { ...ok(data), structuredContent: data as unknown as Record<string, unknown> };
		} catch (error) {
			return toErrorResult(error);
		}
	});
}
