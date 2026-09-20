import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import catalog from './agent-catalog.json' with { type: 'json' };
import { ok, type ToolResult } from './errors.js';

export type CatalogMode = 'full' | 'compact';
export interface CatalogOperation {
	name: string;
	description: string;
	schema: z.ZodType;
	invoke: (args: unknown, signal: AbortSignal) => Promise<ToolResult>;
}

/** Explicit process configuration. Existing installations keep the full catalog. */
export function catalogMode(value: string | undefined): CatalogMode {
	if (value === undefined || value === 'full') return 'full';
	if (value === 'compact') return 'compact';
	throw new Error('PARSEAPI_MCP_MODE must be full or compact');
}

const policies = catalog.operations as Record<string, Record<string, unknown>>;
const object = z.record(z.string(), z.unknown());
const discoveryOutput = z.object({
	schema_version: z.string(),
	api_version: z.string(),
	total_operations: z.number().int(),
	policy_operations: z.array(z.string()),
	effective_access: z.literal('not_evaluated'),
	pricing: z.literal('not_quoted'),
	total_matches: z.number().int(),
	next_offset: z.number().int().nullable(),
	operations: z.array(z.object({
		name: z.string(),
		description: z.string(),
		policy_available: z.boolean(),
		inputSchema: object.optional(),
		policy: object.nullable().optional(),
	})),
});

function invalid(message: string): ToolResult {
	return { ...ok({ code: 'invalid_request', message, docs: 'https://parseapi.com/mcp', request_id: null }), isError: true };
}

export function registerDiscovery(server: McpServer, operations: Map<string, CatalogOperation>, mode: CatalogMode, apiVersion: string): void {
	if (catalog.api_version !== apiVersion) throw new Error('Agent catalog does not match the MCP API contract');
	const all = [...operations.values()].sort((a, b) => a.name.localeCompare(b.name));
	const reviewed = Object.keys(policies).filter(name => operations.has(name)).sort();
	server.registerTool('discover', {
		description: 'Find ParseAPI operations by keyword, or describe one by its exact name. Returns inputs and reviewed capability, freshness, uncertainty, billing and access policies. Metadata only, no API request or usage charge. Use preflight for effective credential permissions and account-specific cost estimates. Use operation to get full detail before lookup.',
		inputSchema: z.object({
			query: z.string().trim().min(1).max(256).optional().describe('Keywords such as mailbox, DNS, or population'),
			operation: z.string().min(1).max(64).optional().describe('Exact operation name for its input schema and policy'),
			detail: z.enum(['summary', 'full']).optional().describe('Defaults to full for one operation, summary for search'),
			limit: z.number().int().min(1).max(20).default(5),
			offset: z.number().int().min(0).max(1000).default(0),
		}).refine(args => args.operation === undefined || (args.query === undefined && args.offset === 0), {
			message: 'Use operation by itself, or query and offset to browse.',
		}),
		outputSchema: discoveryOutput,
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
	}, async args => {
		if (args.operation && !operations.has(args.operation)) return invalid('Unknown operation. Use discover with query to find an available operation.');
		const tokens = [...new Set((args.query?.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []))];
		const matches = args.operation ? [operations.get(args.operation)!] : all
			.map(operation => {
				const text = `${operation.name} ${operation.description} ${JSON.stringify(policies[operation.name] ?? {})}`.toLowerCase();
				const score = tokens.reduce((sum, token) => sum + (operation.name === token ? 10 : text.includes(token) ? 1 : 0), 0);
				return { operation, score };
			})
			.filter(item => !args.query || (tokens.length > 0 && item.score > 0))
			.sort((a, b) => b.score - a.score || a.operation.name.localeCompare(b.operation.name))
			.map(item => item.operation);
		const full = (args.detail ?? (args.operation ? 'full' : 'summary')) === 'full';
		const selected = matches.slice(args.offset, args.offset + args.limit);
		const data = {
			schema_version: catalog.schema_version,
			api_version: catalog.api_version,
			total_operations: all.length,
			policy_operations: reviewed,
			effective_access: 'not_evaluated' as const,
			pricing: 'not_quoted' as const,
			total_matches: matches.length,
			next_offset: args.offset + selected.length < matches.length ? args.offset + selected.length : null,
			operations: selected.map(operation => ({
				name: operation.name,
				description: operation.description,
				policy_available: Object.hasOwn(policies, operation.name),
				...(full ? {
					inputSchema: z.toJSONSchema(operation.schema, { io: 'input' }),
					policy: policies[operation.name] ?? null,
				} : {}),
			})),
		};
		return { ...ok(data), structuredContent: data };
	});

	if (mode !== 'compact') return;
	server.registerTool('lookup', {
		description: 'Run one ParseAPI operation found with discover. Pass its exact name and arguments. Uses the same validation, API 2.0.0 contract, credentials and billing as the named lookup. Reads can consume pooled or paid units. Ordinary lookups can retry twice, metered checks default to no retries.',
		inputSchema: z.object({ operation: z.string().min(1).max(64), arguments: object }),
		annotations: { readOnlyHint: true, idempotentHint: false },
	}, async (args, context) => {
		const operation = operations.get(args.operation);
		if (!operation) return invalid('Unknown operation. Use discover to find an available lookup.');
		// Original Zod refinements (including time/date combinations) stay authoritative.
		const parsed = await operation.schema.safeParseAsync(args.arguments);
		if (!parsed.success) return invalid(parsed.error.issues.map(issue => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; '));
		return operation.invoke(parsed.data, context.mcpReq.signal);
	});
}
