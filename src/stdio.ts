import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildServer } from './registry.js';

const key = process.env.PARSEAPI_KEY ?? null;
if (!key) {
	console.error(
		'parseapi-mcp: PARSEAPI_KEY is not set. Tools are listed but calls return invalid_api_key. Get a free key at https://parseapi.com'
	);
}

serveStdio(() => buildServer(key, 'stdio'));
