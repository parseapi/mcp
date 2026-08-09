import { createServer } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { buildServer } from './registry.js';

function keyFrom(request: Request | undefined): string | null {
	if (!request) return null;
	const headerKey = request.headers.get('x-api-key');
	if (headerKey) return headerKey;
	const auth = request.headers.get('authorization');
	if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim() || null;
	return null;
}

const handler = createMcpHandler((ctx) => buildServer(keyFrom(ctx.requestInfo), 'http'), {
	onerror: (err) => console.error('parseapi-mcp:', err.message),
});

const nodeHandler = toNodeHandler(handler);
const port = Number(process.env.PORT ?? 8080);

createServer((req, res) => {
	if (req.method === 'GET' && req.url === '/health') {
		res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
		return;
	}
	void nodeHandler(req, res);
}).listen(port, () => {
	console.error(`parseapi-mcp listening on :${port}`);
});
