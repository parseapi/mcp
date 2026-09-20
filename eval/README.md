# Offline agent task benchmark

Build the MCP package, then run:

```sh
npm run build
node eval/run.mjs --self-test
node eval/run.mjs --adapter ./my-adapter.mjs
```

Both modes run by default. `--mode full` or `--mode compact` selects one. Add
`--trace` to include tool request/result transcripts. The CLI exits nonzero if
any task fails. Reports go to stdout, so they can be saved for comparison.

The self-test is a scripted reference replay with access to expected answers.
It verifies tool plumbing and grading. It provides no evidence of agent quality
or model token savings. The negative answers in `reference.mjs` exercise common
mistakes through the automated grader tests.

Eight fixed scenarios cover core Email versus a mailbox check, an incomplete
check, empty MX results, a DNS outage, unknown Domain availability, Country zero
with an unknown population period, and locked Country detail. Fixtures are
synthetic and deliberately small. They are not live facts or billing quotes.

These scenarios evaluate lookups and uncertainty only. The advertised `preflight`
tool has no fixture in this benchmark, so budget-endpoint calls are rejected.
Dedicated MCP preflight tests verify its transport, validation, errors and
cancellation. Those checks and the scripted replay are not real-agent proof
of successful budget decisions.

The harness replaces global fetch with explicit fixtures. ParseAPI SDK traffic
stays offline and unmatched fetch requests are rejected. SDK retries are recorded as
actual HTTP attempts, separately from MCP tool calls. This includes the three
attempts made by an ordinary DNS lookup when its fixture returns 503.

## Adapter contract

A local module exports `async run({ task, mode, tools, callTool, signal })`.
`task` contains the prompt, output format and budget, without fixture data or
expected answers. `tools` is the real advertised MCP catalog. Call
`await callTool(name, arguments)` to receive the original MCP result, including
its text content and structured content when present. Return:

```js
export async function run({ task, mode, tools, callTool, signal }) {
  // Drive a locally configured agent or replay its recorded decisions here.
  // Use only the advertised tools. Respect signal and task.budget.
  return {
    answer: {
      outcome: 'completed', // or 'abstained'
      facts: { /* exactly the facts requested in task.prompt */ },
      // reason: 'the task-specific reason code, required for abstention'
    },
    // Optional. Supply measured values only, never estimates from byte counts.
    usage: {
      source: 'provider usage receipt or identified local tokenizer',
      inputTokens: 123,
      outputTokens: 45,
      modelCostUsd: null,
    },
  };
}
```

Omit `usage` if it was not measured. Individual unknown values stay null.
The benchmark does not invoke or purchase model inference. A supplied adapter
is trusted local code, not a security sandbox. Its own dependencies or subprocesses
are the adapter author's responsibility. The harness fetch stub remains active
while it runs, so fetch-based external model requests are rejected too.
An adapter must await every `callTool` call. Outstanding calls are cancelled and
drained under the fixture fetch stub before the original fetch is restored.

Scores distinguish correct completions from justified abstentions. They also
report uncertainty mistakes separately from incorrect known facts, unnecessary HTTP attempts, tool calls, budget
violations, local elapsed time, catalog bytes and tool payload bytes. Byte counts
are not tokens. Exact required fact values and evidence requests are graded;
this is not a general natural-language answer judge.

All API billing uses explicitly synthetic fixture prices and units. Budgets are
synthetic too. Model cost is reported only when supplied as measured usage.
`totalLiveCostUsd` remains null because simulated API costs cannot form a real
total. Task budgets are scored after execution; they do not promise production
spend enforcement. A separate 24-tool-call limit and adapter timeout bound
accidental benchmark loops.

Adding a discovery tool to the full catalog alone does not reduce startup
payloads. Compare the actual `full` and `compact` catalogs. An adapter may spend
extra discovery calls in compact mode, which should appear in its trace and
measured usage. Compare model/version, prompts, task order and sampling settings
consistently before drawing quality or token conclusions.
