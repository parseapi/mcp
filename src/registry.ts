import { McpServer } from '@modelcontextprotocol/server';
import { parseAPI } from 'parseapi';
import * as z from 'zod';
import { noKeyResult, ok, toErrorResult, type ToolResult } from './errors.js';

export const VERSION = '0.1.0';

type Client = ReturnType<typeof parseAPI>;
export type Transport = 'stdio' | 'http';

const deep = z
	.boolean()
	.optional()
	.describe('Include the nested deep object with richer fields. Paid on most endpoints.');
const lat = z.number().min(-90).max(90).describe('Latitude in decimal degrees');
const lon = z.number().min(-180).max(180).describe('Longitude in decimal degrees');
const iso2 = (what: string) => z.string().describe(`ISO 3166-1 alpha-2 ${what}, e.g. US`);

/**
 * One server, every parseAPI lookup as a tool. `key` null serves the funnel:
 * tools list fine, calls return invalid_api_key pointing at signup.
 */
export function buildServer(key: string | null, transport: Transport): McpServer {
	const server = new McpServer(
		{
			name: 'parseapi',
			version: VERSION,
			title: 'parseAPI',
			description:
				'Lookups for agents: IP and place data, email, phone and domain validation, weather, currency, timezones, holidays. Real reference data instead of guessing.',
			websiteUrl: 'https://parseapi.com',
		},
		{ capabilities: { tools: {} } }
	);

	const parse = key ? parseAPI(key) : null;

	function tool<S extends z.ZodRawShape>(
		name: string,
		description: string,
		shape: S,
		fn: (client: Client, args: z.infer<z.ZodObject<S>>) => Promise<unknown>
	): void {
		server.registerTool(
			name,
			{
				description,
				inputSchema: z.object(shape),
				annotations: { readOnlyHint: true },
			},
			async (args): Promise<ToolResult> => {
				if (!parse) return noKeyResult(transport);
				try {
					return ok(await fn(parse, args as z.infer<z.ZodObject<S>>));
				} catch (err) {
					return toErrorResult(err);
				}
			}
		);
	}

	// Locate
	tool(
		'ip',
		'Look up an IPv4 or IPv6 address: country, region, ASN, timezone. Deep adds datacenter, relay and tor flags.',
		{ ip: z.string().describe('IPv4 or IPv6 address, e.g. 8.8.8.8'), deep },
		(c, a) => c.ip(a.ip, { deep: a.deep })
	);
	if (transport === 'stdio') {
		tool(
			'ip_me',
			'Look up the public IP of the machine running this MCP server.',
			{ deep },
			(c, a) => c.ip.me({ deep: a.deep })
		);
	}
	tool(
		'continent',
		'Look up a continent by code: name, area, population.',
		{ code: z.string().describe('Continent code: AF, AN, AS, EU, NA, OC, SA') },
		(c, a) => c.continent(a.code)
	);
	tool(
		'continent_countries',
		'List every country on a continent.',
		{ code: z.string().describe('Continent code: AF, AN, AS, EU, NA, OC, SA') },
		(c, a) => c.continent.countries(a.code)
	);
	tool(
		'country',
		'Look up a country: names, capital, currency, languages, calling code, timezones.',
		{ code: iso2('country code') },
		(c, a) => c.country(a.code)
	);
	tool(
		'country_states',
		'List the states, provinces or regions of a country.',
		{ code: iso2('country code') },
		(c, a) => c.country.states(a.code)
	);
	tool(
		'state',
		'Look up a state, province or region by its code within a country.',
		{ code: z.string().describe('State code, e.g. NC'), country: iso2('country code') },
		(c, a) => c.state(a.code, { country: a.country })
	);
	tool(
		'state_districts',
		'List the districts, counties or departments of a state.',
		{ code: z.string().describe('State code, e.g. NC'), country: iso2('country code') },
		(c, a) => c.state.districts(a.code, { country: a.country })
	);
	tool(
		'district',
		'Look up a district, county or department by code.',
		{ code: z.string().describe('District code, e.g. 37081'), country: iso2('country code').optional() },
		(c, a) => c.district(a.code, { country: a.country })
	);
	tool(
		'city',
		'Look up a city by name: coordinates, state, population, timezone. Pass country to disambiguate name ties.',
		{
			name: z.string().describe('City name, e.g. charlotte'),
			country: iso2('country code').optional(),
			state: z.string().optional().describe('State code to disambiguate, e.g. NC'),
		},
		(c, a) => c.city(a.name, { country: a.country, state: a.state })
	);
	tool(
		'city_id',
		'Refetch a city by its stable parse id from an earlier response.',
		{ id: z.string().describe('Stable city id, e.g. city_mb8mbqrkz8zb') },
		(c, a) => c.city.id(a.id)
	);
	tool(
		'city_search',
		'Search cities by name prefix. Use when the exact name is unknown.',
		{
			q: z.string().describe('Name prefix, e.g. char'),
			country: iso2('country code').optional(),
			state: z.string().optional().describe('State code filter'),
			limit: z.number().int().min(1).max(50).optional().describe('Max results'),
		},
		(c, a) => c.city.search(a.q, { country: a.country, state: a.state, limit: a.limit })
	);
	tool('city_nearest', 'Find the nearest city to coordinates.', { lat, lon }, (c, a) =>
		c.city.nearest(a.lat, a.lon)
	);
	tool(
		'postal',
		'Look up a postal code: place name, coordinates, state, district, timezone, elevation. Country is required.',
		{ code: z.string().describe('Postal code, e.g. 28202'), country: iso2('country code') },
		(c, a) => c.postal(a.code, { country: a.country })
	);
	tool(
		'postal_nearby',
		'List postal codes near a given one, sorted by distance.',
		{
			code: z.string().describe('Postal code to search around'),
			country: iso2('country code'),
			radius: z.number().positive().optional().describe('Search radius'),
			unit: z.enum(['km', 'mi']).optional().describe('Radius unit, default km'),
		},
		(c, a) => c.postal.nearby(a.code, { country: a.country, radius: a.radius, unit: a.unit })
	);
	tool(
		'postal_distance',
		'Distance between two postal codes in the same country.',
		{
			from: z.string().describe('First postal code'),
			to: z.string().describe('Second postal code'),
			country: iso2('country code'),
		},
		(c, a) => c.postal.distance(a.from, a.to, { country: a.country })
	);
	tool(
		'point',
		'Reverse geocode coordinates to country, state, district and nearest city. Deep adds richer admin data.',
		{ lat, lon, deep },
		(c, a) => c.point(a.lat, a.lon, { deep: a.deep })
	);
	tool('elevation', 'Elevation in meters at coordinates.', { lat, lon }, (c, a) =>
		c.elevation(a.lat, a.lon)
	);
	tool(
		'weather',
		'Current weather observation at coordinates from official national agencies. Deep adds forecast and alerts where available.',
		{
			lat,
			lon,
			unit: z.enum(['metric', 'imperial']).optional().describe('Unit system, default metric'),
			deep,
		},
		(c, a) => c.weather(a.lat, a.lon, { unit: a.unit, deep: a.deep })
	);

	// Validate
	tool(
		'email',
		'Validate an email address: syntax, domain, MX, disposable and role flags. Deep runs a live mailbox verification.',
		{ email: z.string().describe('Email address to validate'), deep },
		(c, a) => c.email(a.email, { deep: a.deep })
	);
	tool(
		'phone',
		'Validate and parse a phone number: country, type, formats. Pass country for national-format numbers.',
		{
			number: z.string().describe('Phone number, e.g. +14155552671'),
			country: iso2('country code for national-format numbers').optional(),
			deep,
		},
		(c, a) => c.phone(a.number, { country: a.country, deep: a.deep })
	);
	tool(
		'domain',
		'Look up a domain: registration, DNS, mail setup. Deep adds richer checks.',
		{ domain: z.string().describe('Domain name, e.g. example.com'), deep },
		(c, a) => c.domain(a.domain, { deep: a.deep })
	);
	tool('mx', 'MX records and mail provider for a domain.', { domain: z.string().describe('Domain name') }, (c, a) =>
		c.mx(a.domain)
	);
	tool(
		'useragent',
		'Parse a User-Agent string: browser, OS, device, bot detection.',
		{ ua: z.string().describe('The User-Agent string to parse'), deep },
		(c, a) => c.useragent(a.ua, { deep: a.deep })
	);

	// Decode
	tool(
		'currency',
		'Look up a currency: name, symbol, decimal places, countries using it.',
		{ code: z.string().describe('ISO 4217 code, e.g. USD') },
		(c, a) => c.currency(a.code)
	);
	tool(
		'currency_rate',
		'Exchange rate between two currencies from official central bank data.',
		{
			base: z.string().describe('Base currency ISO 4217 code, e.g. USD'),
			quote: z.string().describe('Quote currency ISO 4217 code, e.g. EUR'),
		},
		(c, a) => c.currency.rate(a.base, a.quote)
	);
	tool(
		'language',
		'Look up a language by BCP 47 or ISO 639-3 code: names, script, direction.',
		{ code: z.string().describe('Language code, e.g. en, ja, gsw') },
		(c, a) => c.language(a.code)
	);
	tool(
		'timezone',
		'Look up an IANA timezone: current offset, DST state, local time. Pass at for a specific instant.',
		{
			id: z.string().describe('IANA timezone id, e.g. America/New_York'),
			at: z.string().optional().describe('ISO 8601 instant to evaluate, default now'),
		},
		(c, a) => c.timezone(a.id, { at: a.at })
	);
	tool(
		'holiday',
		'Public holidays for a country and year.',
		{
			country: iso2('country code'),
			year: z.number().int().optional().describe('Year, default current'),
		},
		(c, a) => c.holiday(a.country, { year: a.year })
	);
	tool(
		'holiday_date',
		'Whether a specific date is a public holiday in a country. holiday is null when it is not.',
		{ country: iso2('country code'), date: z.string().describe('Date as YYYY-MM-DD') },
		(c, a) => c.holiday.date(a.country, a.date)
	);
	tool(
		'emoji',
		'Look up an emoji by name or character: unicode, hex, skin tones.',
		{ query: z.string().describe('Emoji name or the character itself, e.g. rocket') },
		(c, a) => c.emoji(a.query)
	);
	tool(
		'emoji_search',
		'Search emoji by keyword.',
		{
			q: z.string().describe('Search keyword, e.g. fire'),
			limit: z.number().int().min(1).max(50).optional().describe('Max results'),
		},
		(c, a) => c.emoji.search(a.q, { limit: a.limit })
	);

	return server;
}
