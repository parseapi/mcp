#!/usr/bin/env node
// Package a reviewed copy of the API-owned policy catalog. Builds stay standalone.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const sourceAt = args.indexOf('--source');
if (sourceAt !== -1 && !args[sourceAt + 1]) throw new Error('--source needs an API checkout path');
const sourceRoot = sourceAt === -1 ? fileURLToPath(new URL('../../../api/', import.meta.url)) : resolve(args[sourceAt + 1]);
const source = await readFile(resolve(sourceRoot, 'src/route/help/agent-catalog.json'), 'utf8');
const catalog = JSON.parse(source);
const registry = await readFile(new URL('../src/registry.ts', import.meta.url), 'utf8');
const apiVersion = registry.match(/const API_VERSION = '([^']+)'/)?.[1];
if (catalog.schema_version !== '1.0.0' || catalog.api_version !== apiVersion || !catalog.operations) {
	throw new Error('Review the agent catalog schema and API version before syncing');
}
const target = new URL('../src/agent-catalog.json', import.meta.url);
if (args.includes('--check')) {
	if (await readFile(target, 'utf8') !== source) throw new Error('Agent catalog differs from the API source. Run npm run catalog:sync and review the diff.');
	console.log(`Agent catalog matches API ${apiVersion}: ${Object.keys(catalog.operations).length} reviewed operations.`);
} else {
	await writeFile(target, source);
	console.log(`Copied API ${apiVersion} agent catalog. Review the diff before release.`);
}
