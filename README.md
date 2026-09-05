# parseapi-mcp

Official parseAPI MCP server. Look up places, addresses, company numbers, email, phone, weather, currency, timezones, dates and more from your AI agent.

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

51 local tools and 50 hosted tools cover all 53 SDK operations. `ip_self` is local only. `timezone` accepts either a timezone ID or coordinates. `date` parses the supplied date, or returns today in UTC when omitted. Every tool returns the JSON the API serves.

Tools follow the lookup names: `country_states`, `city_search`, `postal_nearby`, `address`, `address_search`, `company`, `email`, `vat`, `iban`, `npi`, `vin`, `tariff`, `asn`, `mac`, `currency_rate`, and the rest. All search tools take `query`.

Example tool arguments:

| Tool | Arguments |
|---|---|
| `asn` | `{"asn":"AS13335"}` |
| `mac` | `{"mac":"00:1B:63:84:45:E6"}` |
| `country_states` | `{"code":"US"}` |
| `address_search` | `{"query":"1600 Pennsylvania","country":"US","city":"Washington","state":"DC"}` |
| `company` | `{"number":"552100554","country":"FR"}` |
| `timezone` | `{"timezone":"America/New_York","at":"2026-09-05T09:00:00","to":"Asia/Tokyo"}` |
| `timezone` | `{"lat":40.71,"lon":-74.01}` |
| `date` | `{"date":"03/04/2026","format":"dmy"}` |

Address lookup returns standardized components and registration status for the US and France. Its `deep` object is currently empty. Company lookup returns validity, registration status and business details when available. `address_search` also accepts `postal` and `ip` to narrow or rank matches. French search needs `country: "FR"` and either `postal` or `city`.

Ordinary lookups retry up to twice after a transient failure. Metered lookups and address deep checks default to no retries. Cancelling a tool call cancels the pending SDK request.

Errors come back as JSON with a machine-readable `code`. Branch on `code`, never on message text. A miss is `not_found`. No key is `invalid_api_key`.

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
