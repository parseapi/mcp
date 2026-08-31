# parseapi-mcp

Official parseAPI MCP server. Every parseAPI lookup as a tool for AI agents: IP and place data, email, phone and domain validation, weather, currency, timezones, holidays.

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

One tool per endpoint, named after the route: `ip`, `postal`, `city`, `city_search`, `city_nearby`, `email`, `vat`, `iban`, `vin`, `phone`, `carrier`, `caller`, `hlr`, `weather`, `currency_rate`, `timezone`, `holiday`, `point`, `elevation`, and the rest. Every tool returns the same minimal JSON the API serves.

Errors come back as JSON with a machine-readable `code`. Branch on `code`, never on message text. A miss is `not_found`. No key is `invalid_api_key`.

## Development

```bash
npm install
npm run build
npm run smoke     # stdio + http, live calls when PARSEAPI_KEY is set
npm run serve     # http on :8080
```

MIT licensed.
