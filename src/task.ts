import type { McpServer } from '@modelcontextprotocol/server';
import type { parseAPI } from '@parseapi/sdk';
import * as z from 'zod';
import { preflightTaskSchema } from './preflight.js';
import { noKeyResult, ok, toErrorResult, type ToolResult } from './errors.js';
import type { Transport } from './registry.js';

export function registerTasks(server: McpServer, client: ReturnType<typeof parseAPI> | null, transport: Transport): void {
	const id = z.string().regex(/^task_[a-f0-9]{40}$/);
	const requestId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).describe('Unique ID for the intended request. Reuse this exact ID and inputs on every retry. Never include private lookup values in it.');
	const call = async (action: () => Promise<unknown>): Promise<ToolResult> => {
		if (!client) return noKeyResult(transport);
		try { const data = await action(); return { ...ok(data), structuredContent: data as Record<string, unknown> }; }
		catch (error) { return toErrorResult(error); }
	};
	server.registerTool('task_create', {
		title: 'Authorize a bounded task',
		description: 'Create a 24-hour task with allowed operations, lookup counts and an enforced USD limit on additional lookup charges. Requires already authorized user scope and a secret key. Reserves no account units and makes no lookups. Only task_lookup obeys this task budget. Ordinary lookups remain separate. Included units can make actual cost zero, but a positive-rate lookup needs budget room for its conservative full rate.',
		inputSchema: preflightTaskSchema.safeExtend({ budget_usd: z.string().regex(/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/), request_id: requestId })
			.refine(args => args.operations.reduce((sum,op) => sum + op.count,0) <= 1000, { message: 'A task can authorize at most 1000 lookups.' })
			.refine(args => Number(args.budget_usd) <= 1000000, { message: 'The task budget cannot exceed 1000000 USD.' }),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
	}, (args, context) => call(() => client!.task({ operations: args.operations, budget_usd: args.budget_usd }, args.request_id, { signal: context.mcpReq.signal })));
	server.registerTool('task_status', {
		title: 'Read task budget and progress', description: 'Read completed and allocated lookup counts, spent and reserved USD budget and expiry. No lookup or usage unit.',
		inputSchema: z.strictObject({ task_id: id }), annotations: { readOnlyHint: true, idempotentHint: true },
	}, (args, context) => call(() => client!.task.get(args.task_id, { signal: context.mcpReq.signal })));
	server.registerTool('task_cancel', {
		title: 'Cancel remaining task work', description: 'Prevent new lookups in this task. Already started lookups may finish and incur their reserved charge. Saved results remain recoverable.',
		inputSchema: z.strictObject({ task_id: id }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
	}, (args, context) => call(() => client!.task.cancel(args.task_id, { signal: context.mcpReq.signal })));
	server.registerTool('task_lookup', {
		title: 'Run or recover a bounded lookup',
		description: 'Run one lookup under an authorized task budget and count. Reuse request_id with identical inputs to recover its saved response without another lookup or usage charge. Inspect status_code and result, including nulls. task_in_progress or task_outcome_unknown means keep the same request_id; never use a new ID to repeat uncertain work. Saved results are available for 48 hours from task creation. This tool can consume pooled and metered units on its first execution.',
		inputSchema: z.strictObject({ task_id: id, request_id: requestId,
			operation: z.enum(['email','vat','carrier','caller','hlr','domain','dns','mx','country','ip','phone','postal']),
			value: z.string().min(1).max(2048), country: z.string().regex(/^[A-Za-z]{2}$/).optional(), deep: z.boolean().optional() }),
		annotations: { readOnlyHint: true, idempotentHint: true },
	}, ({ task_id, request_id, ...input }, context) => call(() => client!.task.lookup(task_id, input, request_id, { signal: context.mcpReq.signal })));
}
