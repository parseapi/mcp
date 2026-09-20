#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runBenchmark } from './harness.mjs';
import * as reference from './reference.mjs';

const args = process.argv.slice(2);
const allowed = new Set(['--self-test', '--adapter', '--mode', '--trace', '--help']);
let adapterPath;
let mode;
let selfTest = false;
let trace = false;
for (let i = 0; i < args.length; i++) {
	const flag = args[i];
	if (!allowed.has(flag)) throw new Error(`Unknown argument: ${flag}`);
	if (flag === '--adapter') adapterPath = args[++i];
	else if (flag === '--mode') mode = args[++i];
	else if (flag === '--self-test') selfTest = true;
	else if (flag === '--trace') trace = true;
	else {
		console.log('node eval/run.mjs --self-test | --adapter ./adapter.mjs [--mode full|compact] [--trace]');
		process.exit(0);
	}
}
if ((selfTest ? 1 : 0) + (adapterPath ? 1 : 0) !== 1) throw new Error('Choose exactly one of --self-test or --adapter PATH.');
if (mode && !['full', 'compact'].includes(mode)) throw new Error('--mode must be full or compact.');
const adapter = selfTest ? reference : await import(pathToFileURL(resolve(adapterPath)).href);
const report = await runBenchmark({ adapter, modes: mode ? [mode] : undefined });
if (!trace) delete report.traces;
console.log(JSON.stringify(report, null, 2));
if (report.scores.some(score => !score.passed)) process.exitCode = 1;
