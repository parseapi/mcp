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

## Tools

58 local tools and 57 hosted tools cover the lookup operations. `ip_self` is local only. `time` returns current local time and Unix seconds. It accepts a timezone or coordinates and defaults to UTC when both are omitted. `date` parses the supplied date, or returns today in UTC when omitted. Every tool returns the JSON the API serves.

Tools follow the lookup names: `country_states`, `city_search`, `postal_nearby`, `address`, `address_search`, `company`, `email`, `vat`, `iban`, `bin`, `swift`, `npi`, `vin`, `naics`, `naics_search`, `tariff`, `dns`, `asn`, `mac`, `currency_rate`, and the rest. All search tools take `query`.

NAICS paid deep records include classification `deep.exclusions`, each with a description and linked codes. Generic exclusions can have no linked codes. Omitted or null exclusions in older responses remain unknown. Search results also include `match`: the matched `field` (`name`, `term` or `naics`) and `text`, plus `corrections` with `from` and `to` tokens for typo fallback. Corrections are empty for exact, plural and prefix matches. Direct code lookups omit `match`. Older responses may omit it.

Example tool arguments:

| Tool | Arguments |
|---|---|
| `domain` | `{"domain":"example.com"}` (registration status) |
| `domain` | `{"domain":"example.com","deep":true}` (registration details on paid plans) |
| `dns` | `{"domain":"example.com","type":"TXT"}` |
| `mx` | `{"domain":"example.com"}` |
| `asn` | `{"asn":"AS13335"}` |
| `mac` | `{"mac":"00:1B:63:84:45:E6"}` |
| `bin` | `{"bin":"424242"}` |
| `swift` | `{"code":"CHASUS33"}` |
| `country_states` | `{"code":"US"}` |
| `address_search` | `{"query":"1600 Pennsylvania","country":"US","city":"Washington","state":"DC"}` |
| `company` | `{"number":"552100554","country":"FR"}` |
| `time` | `{}` (UTC now) |
| `time` | `{"timezone":"America/New_York","at":"2026-09-05T09:00:00","to":"Asia/Tokyo"}` |
| `time` | `{"lat":40.71,"lon":-74.01}` |
| `date` | `{"date":"03/04/2026","format":"dmy"}` |

Address lookup returns standardized components and registration status for the US and France. Its `deep` object is currently empty. Company lookup returns validity, registration status and business details when available. `address_search` also accepts `postal` and `ip` to narrow or rank matches. French search needs `country: "FR"` and either `postal` or `city`.

Ordinary lookups retry up to twice after a transient failure. Metered lookups and address deep checks default to no retries. Cancelling a tool call cancels the pending SDK request.

Errors come back as JSON with a machine-readable `code`. Branch on `code`, never on message text. A miss is `not_found`. No key is `invalid_api_key`.

## Measurements

Call `measure` with `{ "measure": "5 ft 11 in", "to": "cm" }`. The result keeps the amount as the decimal string `"180.34"`. Without `to`, the result uses the canonical unit for its type. Optional `locale` and `system` (`us` or `imperial`) resolve explicit number or customary-unit ambiguity.

Call `measure_units` with `{ "unit": "m" }` to discover compatible targets, or `{}` for the reviewed catalog. Optional `query` and `type` filters narrow the list. Ambiguous input remains a successful result with `valid: false`, `reason`, and `choices`. Invalid targets return the ordinary API error. Both tools use pooled requests.

## Development

```bash
npm install
npm run typecheck
npm test          # builds and tests with mocked fetch and in-memory MCP
npm run smoke     # stdio + http, includes live API authentication checks
npm run serve     # http on :8080
```

Offline tests pin the public tool names and argument schemas in `test/public-api.json`, exercise every operation and query option, and verify errors, retries and cancellation. Review baseline changes as public API changes. Publishing runs typecheck and offline tests first.

MIT licensed.

SWIFT `valid` checks code syntax. Its institution-name coverage is partial; unknown or ambiguous names stay null. The tool decodes the response attribution header and includes the required data notice as a second text block. Retain that notice with copies of the lookup data.


## Optional detail

Start with the default tool call. Use the same tool with `deep: true` for richer facts. Time, Date, Currency, Language, Emoji, Phone, IBAN and Point include detail on every plan. Geographic profiles, Name evidence and NAICS definitions require a paid plan. Carrier and HLR detail stays inside the same metered core unit, including Free allowance units, with no additional charge or second gate.

Search detail belongs to each returned entity. Time conversion puts target display detail in `to.deep`; only the source returns `deep.next_dst`. Name core parsing needs no dictionary lookup. Country, State and Postal tax references are in their paid deep bags.
