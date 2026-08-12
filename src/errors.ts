import { ParseAPIError } from '@parseapi/sdk';

export interface ToolResult {
	content: { type: 'text'; text: string }[];
	isError?: boolean;
	[key: string]: unknown;
}

export function ok(data: unknown): ToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function errorJson(code: string, message: string, docs: string | null, requestId: string | null): ToolResult {
	return {
		isError: true,
		content: [{ type: 'text', text: JSON.stringify({ code, message, docs, request_id: requestId }) }],
	};
}

/** Same shape the edge sends. Agents branch on `code`. */
export function toErrorResult(err: unknown): ToolResult {
	if (err instanceof ParseAPIError) {
		return errorJson(err.code, err.message, err.docs, err.requestId);
	}
	const message = err instanceof Error ? err.message : String(err);
	return errorJson('network_error', message, null, null);
}

/** The funnel: keyless agents can list tools, calls point at signup. */
export function noKeyResult(transport: 'stdio' | 'http'): ToolResult {
	const where =
		transport === 'stdio'
			? 'set it as the PARSEAPI_KEY environment variable for this MCP server'
			: 'send it in the X-API-Key header';
	return errorJson(
		'invalid_api_key',
		`No API key. Get a free key at https://parseapi.com and ${where}.`,
		'https://parseapi.com/docs#invalid_api_key',
		null
	);
}
