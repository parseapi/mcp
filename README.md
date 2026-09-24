# parseapi-mcp

Official ParseAPI MCP server. Look up places, addresses, company numbers, email, phone, weather, currency, timezones, dates and more from your AI agent.

## Hosted

One URL, nothing to install. Add the server and sign in once in the browser. Free plan works.

```json
{
  "mcpServers": {
    "parseAPI": { "url": "https://mcp.parseapi.com" }
  }
}
```

**Cursor:** [Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=parseAPI&config=eyJ1cmwiOiJodHRwczovL21jcC5wYXJzZWFwaS5jb20ifQ==)

Repo-root `.mcp.json` is keyless on purpose. [cursor.directory](https://cursor.directory/plugins/parseapi) auto-detects it when you submit or refresh the listing.

CI and headless setups skip the browser with a key from [parseapi.com](https://parseapi.com):

```json
{
  "mcpServers": {
    "parseAPI": {
      "url": "https://mcp.parseapi.com",
      "headers": { "X-API-Key": "your-api-key" }
    }
  }
}
```

## Local

```json
{
  "mcpServers": {
    "parseAPI": {
      "command": "npx",
      "args": ["-y", "parseapi-mcp"],
      "env": { "PARSEAPI_KEY": "your-api-key" }
    }
  }
}
```

## API versions

Since version 1.0.0, the package explicitly selects the API contract supported by this MCP package. Every API tool request sends `Parse-Version: 2.0.0`, matching this release's tool descriptions and SDK response types. The contract is fixed for both local stdio and hosted HTTP, including retries. Your key, OAuth identity and team's saved default stay the same.

For local stdio, pin the MCP package version in your application configuration and test the new release before deploying it. A future major MCP upgrade can select a newer API contract. There is no version argument to add to individual tool calls. The hosted service uses the API contract supported by its deployed MCP release.

MCP packages older than 1.0.0 keep their existing behavior and use the team's default. Keep that default unchanged while older applications depend on it. Rolling back to a package without a version header restores the team default, so rollback only restores the old contract when that default has stayed unchanged. See [API versions and migration](https://parseapi.com/docs/versioning).

## Tools

Full mode provides 59 local lookup tools and 58 hosted lookup tools, plus `discover` for local metadata and `preflight` for authenticated task estimates. `ip_self` is local only. `time` returns current local time and Unix seconds. It accepts a timezone or coordinates and defaults to UTC when both are omitted. `date` parses the supplied date, or returns today in UTC when omitted. Existing `timezone` calls remain supported with their original arguments. Every lookup returns the JSON the API serves.

Tools follow the lookup names: `country_states`, `city_search`, `postal_nearby`, `address`, `address_search`, `company`, `email`, `vat`, `iban`, `bin`, `npi`, `vin`, `naics`, `naics_search`, `tariff`, `dns`, `asn`, `mac`, `currency_rate`, and the rest. All search tools take `query`.

NAICS paid deep records include classification `deep.exclusions`, each with a description and linked codes. Generic exclusions can have no linked codes. Omitted or null exclusions in older responses remain unknown. Search results also include `match`: the matched `field` (`name`, `term` or `naics`) and `text`, plus `corrections` with `from` and `to` tokens for typo fallback. Corrections are empty for exact, plural and prefix matches. Direct code lookups omit `match`. Older responses may omit it.

Example tool arguments:

| Tool | Arguments |
|---|---|
| `stack` | `{"domain":"example.com"}` (website technologies and versions by category) |
| `domain` | `{"domain":"example.com"}` (registration status) |
| `domain` | `{"domain":"example.com","deep":true}` (registration details on paid plans) |
| `dns` | `{"domain":"example.com","type":"TXT"}` |
| `mx` | `{"domain":"example.com"}` |
| `asn` | `{"asn":"AS13335"}` |
| `mac` | `{"mac":"00:1B:63:84:45:E6"}` |
| `bin` | `{"bin":"424242"}` |
| `country_states` | `{"code":"US"}` |
| `address_search` | `{"query":"1600 Pennsylvania","country":"US","city":"Washington","state":"DC"}` |
| `company` | `{"number":"552100554","country":"FR"}` |
| `time` | `{}` (UTC now) |
| `time` | `{"timezone":"America/New_York","at":"2026-09-05T09:00:00","to":"Asia/Tokyo"}` |
| `time` | `{"lat":40.71,"lon":-74.01}` |
| `date` | `{"date":"03/04/2026","format":"dmy"}` |

Australian `postal` lookup returns core `localities` with suburb choices (`city`, `state`, `state_name`). Null or an omitted field means unknown, while `[]` means the reviewed reference has no eligible choices. A single choice can coexist with `city: null`. Ask for the user's suburb choice and preserve manual entry. These are geographic choices, not mailing-address verification. AU Postal tool results include a separate source notice after the JSON. [G-NAF source, adaptations and licence](https://parseapi.com/legal/attribution#postal-au).

Address lookup returns standardized components and registration status for the US and France. Its `deep` object is currently empty. Company lookup returns validity, registration status and business details when available. `address_search` also accepts `postal` and `ip` to narrow or rank matches. French search needs `country: "FR"` and either `postal` or `city`.


Ordinary lookups retry up to twice after a transient failure. Metered lookups and address deep checks default to no retries. Cancelling a tool call cancels the pending SDK request.

Errors come back as JSON with a machine-readable `code`. Branch on `code`, never on message text. A miss is `not_found`. No key is `invalid_api_key`.

## Agent discovery

Ask `discover` what an operation can determine before making a lookup:

```json
{ "operation": "email" }
```

The result includes the actual input schema and reviewed policies for capabilities, freshness, uncertainty, billing units, credential types and retries. Both JSON text and MCP `structuredContent` carry the same result. Email, Domain, DNS, MX and Country have reviewed policies. Other operations return their input schema with `policy: null`. Field meanings are specific to each operation. An unknown result is not automatically a reason to retry.

Use `{ "query": "mailbox" }` to find operations. Search returns up to five summaries by default. `detail: "full"` includes schemas and policies. Use `limit` and the returned `next_offset` to page through results. Metadata calls make no API requests and consume no lookup units. Hosted HTTP still requires its existing authentication before discovery.

Policies describe the API contract. `effective_access: "not_evaluated"` and `pricing: "not_quoted"` mean discovery has not inspected the credential's permissions, remaining allowances or accepted rates. Use `preflight` for those account-specific estimates. A read-only lookup can still consume a paid unit.

Call `preflight` with a secret key and operation counts before spending:

```json
{
  "operations": [{ "operation": "email", "count": 100, "deep": true }],
  "budget_usd": "2.50"
}
```

Preflight supports Email, Domain, DNS, MX and Country, with up to 20 rows and 100,000 total lookups. It needs no lookup inputs or personal data. Check `permitted`, `cost.status`, `capacity` and `budget.within_maximum` together. Monetary values are decimal strings. The maximum assumes included Email checks are exhausted. The projection uses currently unallocated included checks. Unknowns stay null. Both use the credential's accepted rates.

The estimate allows up to three attempts per ordinary lookup and one per Email Deep lookup. Extra calls or retries require a new estimate. Capacity can change with concurrent work. Preflight reserves no units or money, performs no paid checks, and does not enforce the supplied budget. It uses the normal request rate limit. Subscription fees, tax and model costs are excluded. Preflight uses API contract 2.0.0 and the matching JavaScript SDK 1.2.0 or later.

For a compact tool catalog, set `PARSEAPI_MCP_MODE=compact` on the MCP process:

```bash
PARSEAPI_MCP_MODE=compact npx -y parseapi-mcp@1.4.0
```

Set `PARSEAPI_KEY` in the process environment for lookups. Compact mode advertises three tools, `discover`, `preflight` and `lookup`. After discovering an operation, pass its exact name and arguments:

```json
{ "operation": "country", "arguments": { "code": "US" } }
```

`lookup` uses the same input validation, cancellation, version pin, SDK and billing behavior as the named tools. It executes one operation and cannot run arbitrary code or request arbitrary URLs. Full mode is the default and preserves existing named lookup calls. The same process setting supports self-hosted HTTP.

The policy source is the API's `src/route/help/agent-catalog.json`. Current API help exposes the same metadata as `agent`. Frozen API 1.0.0 help stays unchanged. In a ParseAPI workspace, run `npm run catalog:sync` to copy a reviewed policy change, then `npm run catalog:check`. An independent checkout can pass `-- --source /path/to/api`. Package builds use the checked-in copy and do not need the API checkout or a network request.

## Display language

This source candidate adds optional `lang` to supported tools. For example,
`country` accepts `{"code":"DE","lang":"fr"}`. It requires a matching API
localization release, data, and JS SDK package; installing the existing published
package does not activate it.

Display names follow available source translations. IDs, native-name fields,
numbers and input parsing stay unchanged. Omitted language keeps the default
behavior. Measure parsing, currency rates, Holiday and prove tools have no new
language argument.

## Measurements

Call `measure` with `{ "measure": "5 ft 11 in", "to": "cm" }`. The result keeps the amount as the decimal string `"180.34"`. Without `to`, the result uses the canonical unit for its type. Optional `locale` and `system` (`us` or `imperial`) resolve explicit number or customary-unit ambiguity.

Call `measure_units` with `{ "unit": "m" }` to discover compatible targets, or `{}` for the reviewed catalog. Optional `query` and `type` filters narrow the list. Ambiguous input remains a successful result with `valid: false`, `reason`, and `choices`. Invalid targets return the ordinary API error. Both tools use pooled requests.

## Development

```bash
npm install
npm run typecheck
npm test          # builds and tests with mocked fetch and in-memory MCP
npm run eval:agents # offline benchmark self-test, no model or live API calls
npm run smoke     # stdio + http, includes live API authentication checks
npm run serve     # http on :8080
```

Offline tests pin the public tool names and argument schemas in `test/public-api.json`, exercise every operation and query option, and verify errors, retries and cancellation. Review baseline changes as public API changes. Publishing runs typecheck and offline tests first.

The [agent benchmark](eval/README.md) compares full and compact discovery on fixed tasks with synthetic API responses. Its scripted reference run verifies the harness and grading, not agent completion quality. Model tokens and cost remain null until an adapter supplies measured usage. Fixture billing is simulated and always labeled separately from live charges.

MIT licensed.


## Optional detail

Start with the default tool call. Use the same tool with `deep: true` for richer facts. Time, Date, Currency, Language, Emoji, Phone, IBAN and Point include detail on every plan. Geographic profiles, Name evidence and NAICS definitions require a paid plan. Carrier and HLR detail stays inside the same metered core unit, including Free allowance units, with no additional charge or second gate.

Search detail belongs to each returned entity. Time conversion puts target display detail in `to.deep`; only the source returns `deep.next_dst`. Name core parsing needs no dictionary lookup. Paid Name deep also returns flat `short`, `directory`, and `initials`. Optional `name_locale` selects CLDR formatting rules, defaults to `en`, and leaves parsing and gender context unchanged. Unavailable formatting is null, and older responses may omit these fields. Country, State and Postal tax references are in their paid deep bags.

## Stack API

Call the `stack` tool:

```json
{"domain":"example.com"}
```

Pass a public hostname without a scheme, path, port or IP address. Stack returns the checked URL and `checked_at` time, followed by `scope`, `pages` and `partial`. `scope` is `homepage` or `site`; `pages` counts successfully checked HTML pages. `partial` is true for homepage-only or incomplete bounded site checks. False means the known in-scope candidates were completed, not that every page on a website was visited. A homepage result has `scope: "homepage"`, `pages: 1` and `partial: true`.

`cms`, `servers`, `frameworks`, `ecommerce`, `analytics`, `chat`, `payments` and `hosting` are arrays because a site can use several technologies in each category. Each entry contains `technology`, `name` and nullable `version`. Technology codes are open strings. A successful check uses empty arrays for categories with no matches. When no HTML page could be checked, `checked_at` and all categories are null, `pages` is 0 and `partial` is null. Unknown or conflicting versions are null. Missing detections do not prove absence.

Successful checks may be reused for up to 24 hours. `pretty` optionally formats the wire JSON. Stack uses your plan's request allowance and API version 2.0.0 selected by this client.

The `stack` tool allows 35 seconds per attempt for a first check. MCP cancellation still aborts the request.
