# parseapi-mcp

Official parseAPI MCP server. Every parseAPI lookup as a tool for AI agents: IP and place data, email, phone and domain validation, weather, currency, timezones, holidays.

## Hosted

One URL, nothing to install. Sign in once in the browser and tools work. Free plan works.

```json
{
  "mcpServers": {
    "parseapi": { "url": "https://mcp.parseapi.com" }
  }
}
```

CI and headless setups skip the browser with a key from [parseapi.com](https://parseapi.com):

```json
{
  "mcpServers": {
    "parseapi": {
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
    "parseapi": {
      "command": "npx",
      "args": ["-y", "parseapi-mcp"],
      "env": { "PARSEAPI_KEY": "your-api-key" }
    }
  }
}
```

## Tools

One tool per endpoint, named after the route: `ip`, `postal`, `city`, `city_search`, `email`, `phone`, `weather`, `currency_rate`, `timezone`, `holiday`, `point`, `elevation`, and the rest. Every tool returns the same minimal JSON the API serves.

Errors come back as JSON with a machine-readable `code`. Branch on `code`, never on message text. A miss is `not_found`. No key is `invalid_api_key`.

## Development

```bash
npm install
npm run build
npm run smoke     # stdio + http, live calls when PARSEAPI_KEY is set
npm run serve     # http on :8080
```

MIT licensed.
