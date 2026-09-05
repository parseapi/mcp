import { McpServer } from '@modelcontextprotocol/server';
import { parseAPI, type RequestOptions } from '@parseapi/sdk';
import * as z from 'zod';
import { noKeyResult, ok, toErrorResult, type ToolResult } from './errors.js';

export const VERSION = '0.3.0';

type Client = ReturnType<typeof parseAPI>;
export type Transport = 'stdio' | 'http';

const deep = z
	.boolean()
	.optional()
	.describe('Include the nested deep object when available. Pricing depends on the operation.');
const lat = z.number().min(-90).max(90).describe('Latitude in decimal degrees');
const lon = z.number().min(-180).max(180).describe('Longitude in decimal degrees');
const iso2 = (what: string) => z.string().describe(`ISO 3166-1 alpha-2 ${what}, e.g. US`);
const countryOpt = z
	.string()
	.optional()
	.describe('ISO2, ISO3, or a country name. Optional when the lookup is unique.');

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
				'Lookups for agents: IP and place data, addresses, company numbers, email, VAT, IBAN, NPI, phone, domains, weather, currency, timezones, dates and holidays. Real reference data instead of guessing.',
			websiteUrl: 'https://parseapi.com',
		},
		{ capabilities: { tools: {} } }
	);

	const parse = key ? parseAPI(key) : null;

	function tool<S extends z.ZodRawShape>(
		name: string,
		description: string,
		shape: S,
		fn: (client: Client, args: z.infer<z.ZodObject<S>>, options: RequestOptions) => Promise<unknown>,
		refine?: (schema: z.ZodObject<S>) => z.ZodObject<S>
	): void {
		server.registerTool(
			name,
			{
				description,
				inputSchema: refine ? refine(z.object(shape)) : z.object(shape),
				annotations: { readOnlyHint: true },
			},
			async (args, context): Promise<ToolResult> => {
				if (!parse) return noKeyResult(transport);
				try {
					return ok(await fn(parse, args as z.infer<z.ZodObject<S>>, { signal: context.mcpReq.signal }));
				} catch (err) {
					return toErrorResult(err);
				}
			}
		);
	}

	// Locate
	tool(
		'ip',
		'Look up an IPv4 or IPv6 address: country, region, ASN, timezone. Deep adds datacenter, relay, tor and vpn flags.',
		{ ip: z.string().describe('IPv4 or IPv6 address, e.g. 8.8.8.8'), deep },
		(c, a, request) => c.ip(a.ip, { ...request, deep: a.deep })
	);
	if (transport === 'stdio') {
		tool(
			'ip_self',
			'Look up the public IP of the machine running this MCP server.',
			{ deep },
			(c, a, request) => c.ip.self({ ...request, deep: a.deep })
		);
	}
	tool(
		'continent',
		'Look up a continent by code: name, area, population.',
		{ code: z.string().describe('Continent code: AF, AN, AS, EU, NA, OC, SA') },
		(c, a, request) => c.continent(a.code, request)
	);
	tool(
		'continent_countries',
		'List every country on a continent.',
		{ code: z.string().describe('Continent code: AF, AN, AS, EU, NA, OC, SA') },
		(c, a, request) => c.continent.countries(a.code, request)
	);
	tool(
		'bloc',
		'Look up a country group by code: EU, EEA, Schengen, Eurozone, SEPA, NATO, and more. Returns the official name and the current member count.',
		{
			code: z
				.string()
				.describe('Bloc code: EU, EEA, EFTA, SCHENGEN, EUROZONE, SEPA, NATO, OECD, G7, ASEAN, GCC, MERCOSUR'),
		},
		(c, a, request) => c.bloc(a.code, request)
	);
	tool(
		'bloc_countries',
		'List the current members of a country group, each with name, flag, and calling code.',
		{
			code: z
				.string()
				.describe('Bloc code: EU, EEA, EFTA, SCHENGEN, EUROZONE, SEPA, NATO, OECD, G7, ASEAN, GCC, MERCOSUR'),
		},
		(c, a, request) => c.bloc.countries(a.code, request)
	);
	tool(
		'country',
		'Look up a country: names, capital, currency, languages, calling code, timezones.',
		{ code: iso2('country code') },
		(c, a, request) => c.country(a.code, request)
	);
	tool(
		'country_states',
		'List the states, provinces or regions of a country.',
		{ code: iso2('country code') },
		(c, a, request) => c.country.states(a.code, request)
	);
	tool(
		'state',
		'Look up a state, province or region by code or name. Unique names resolve without a country. A colliding code 404s asking for ?country=. Country takes ISO2, ISO3, or a name.',
		{
			code: z.string().describe('State code or name, e.g. colorado, NC'),
			country: countryOpt,
		},
		(c, a, request) => c.state(a.code, { ...request, country: a.country })
	);
	tool(
		'state_districts',
		'List the districts, counties or departments of a state.',
		{
			code: z.string().describe('State code or name, e.g. NC, colorado'),
			country: countryOpt,
		},
		(c, a, request) => c.state.districts(a.code, { ...request, country: a.country })
	);
	tool(
		'district',
		'Look up a district, county or department by code or name. Pass state when a name collides.',
		{
			code: z.string().describe('District code or name, e.g. 37081, guilford county'),
			country: countryOpt,
			state: z.string().optional().describe('ADM1 code or name to disambiguate, e.g. NC or louisiana'),
		},
		(c, a, request) => c.district(a.code, { ...request, country: a.country, state: a.state })
	);
	tool(
		'city',
		'Look up a city by name: type, capital status (capital_of), district, elevation, area in km2, coordinates, timezone. Pass country or state to disambiguate name ties.',
		{
			name: z.string().describe('City name, e.g. charlotte'),
			country: countryOpt,
			state: z.string().optional().describe('State code to disambiguate, e.g. NC'),
		},
		(c, a, request) => c.city(a.name, { ...request, country: a.country, state: a.state })
	);
	tool(
		'city_id',
		'Refetch a city by its stable parse id from an earlier response.',
		{ id: z.string().describe('Stable city id, e.g. city_mb8mbqrkz8zb') },
		(c, a, request) => c.city.id(a.id, request)
	);
	tool(
		'city_search',
		'Search cities by name prefix. Use when the exact name is unknown.',
		{
			query: z.string().describe('Name prefix, e.g. char'),
			country: countryOpt,
			state: z.string().optional().describe('State code filter'),
			limit: z.number().int().min(1).max(50).optional().describe('Max results'),
		},
		(c, a, request) => c.city.search(a.query, { ...request, country: a.country, state: a.state, limit: a.limit })
	);
	tool('city_nearest', 'Find the nearest city to coordinates.', { lat, lon }, (c, a, request) =>
		c.city.nearest(a.lat, a.lon, request)
	);
	tool(
		'city_nearby',
		'List cities around a named city, nearest first, with distance. Default radius 40 km.',
		{
			name: z.string().describe('Anchor city name, e.g. denver'),
			country: countryOpt,
			state: z.string().optional().describe('State code to disambiguate the anchor'),
			radius: z.number().positive().optional().describe('Search radius, default 40 km'),
			unit: z.enum(['km', 'mi']).optional().describe('Radius unit, default km'),
			limit: z.number().int().min(1).max(50).optional().describe('Max results, default 10'),
		},
		(c, a, request) =>
			c.city.nearby(a.name, {
				...request,
				country: a.country,
				state: a.state,
				radius: a.radius,
				unit: a.unit,
				limit: a.limit,
			})
	);
	tool(
		'postal',
		'Look up a postal or ZIP code: place name, country name, coordinates, state, district, area, timezone, elevation. Unique codes resolve without a country. A collision 404s asking for ?country=. Never defaults to US.',
		{
			code: z.string().describe('Postal or ZIP code, e.g. SW1A 1AA, 28202'),
			country: countryOpt,
		},
		(c, a, request) => c.postal(a.code, { ...request, country: a.country })
	);
	tool(
		'postal_nearby',
		'List postal codes near a given one, sorted by distance. Unique codes resolve without a country.',
		{
			code: z.string().describe('Postal code to search around'),
			country: countryOpt,
			radius: z.number().positive().optional().describe('Search radius'),
			unit: z.enum(['km', 'mi']).optional().describe('Radius unit, default km'),
		},
		(c, a, request) => c.postal.nearby(a.code, { ...request, country: a.country, radius: a.radius, unit: a.unit })
	);
	tool(
		'postal_distance',
		'Distance between two postal codes in the same country. Unique codes resolve without a country.',
		{
			from: z.string().describe('First postal code'),
			to: z.string().describe('Second postal code'),
			country: countryOpt,
		},
		(c, a, request) => c.postal.distance(a.from, a.to, { ...request, country: a.country })
	);
	tool(
		'address',
		'Look up a US or French street address: house number, street, unit, city, state, postal code and registration status. Registration does not establish deliverability or verify an apartment. Deep is currently an empty object.',
		{
			address: z.string().describe('Street address, e.g. 1600 Pennsylvania Ave NW, Washington, DC 20500'),
			country: z.string().optional().describe('Country: US or FR. Use FR or a written France suffix for France. Defaults to US.'),
			deep,
		},
		(c, a, request) => c.address(a.address, { ...request, country: a.country, deep: a.deep })
	);
	tool(
		'address_search',
		'Search US or French street addresses from a partial address. Postal code, city, state and user IP can narrow or rank matches. French search requires country FR and either postal or city.',
		{
			query: z.string().describe('Partial street address, e.g. 1600 Pennsylvania'),
			country: z.string().optional().describe('Country: US or FR. Defaults to US.'),
			postal: z.string().optional().describe('Postal code filter'),
			city: z.string().optional().describe('City filter'),
			state: z.string().optional().describe('State code filter'),
			ip: z.string().optional().describe('User IP address for ranking nearby matches'),
		},
		(c, a, request) => c.address.search(a.query, { ...request, country: a.country, postal: a.postal, city: a.city, state: a.state, ip: a.ip })
	);
	tool(
		'company',
		'Look up a company registration number: validity, registration status, name, activity and address when available. Pass country when more than one scheme can match. Deep adds country, postal and city data.',
		{
			number: z.string().describe('Company registration number, e.g. 552100554 with country FR'),
			country: countryOpt,
			deep,
		},
		(c, a, request) => c.company(a.number, { ...request, country: a.country, deep: a.deep })
	);

	tool(
		'point',
		'Reverse geocode coordinates to country, state, district and nearest city. Deep adds richer admin data.',
		{ lat, lon, deep },
		(c, a, request) => c.point(a.lat, a.lon, { ...request, deep: a.deep })
	);
	tool('elevation', 'Elevation in meters at coordinates.', { lat, lon }, (c, a, request) =>
		c.elevation(a.lat, a.lon, request)
	);
	tool(
		'weather',
		'Current weather observation at coordinates. Every measurement ships metric and imperial side by side. Deep adds minute-by-minute rain, hourly and daily rows worldwide, alerts, and air quality. With deep, date returns a past day as deep.history.',
		{
			lat,
			lon,
			deep,
			date: z
				.string()
				.optional()
				.describe('A past UTC day, YYYY-MM-DD. Requires deep. Returns that day as deep.history'),
		},
		(c, a, request) => c.weather(a.lat, a.lon, { ...request, deep: a.deep, date: a.date })
	);

	// Validate
	tool(
		'email',
		'Validate an email address: syntax, domain, MX, disposable, role, and a typo suggestion when the host looks misspelled. Deep runs a live mailbox verification.',
		{ email: z.string().describe('Email address to validate'), deep },
		(c, a, request) => c.email(a.email, { ...request, deep: a.deep })
	);
	tool(
		'vat',
		'Validate a VAT number: format and checksum on every call. Deep asks the live EU registry for registered, legal name, and address. Pass from with your own VAT for a consultation identifier.',
		{
			number: z.string().describe('VAT number, with or without the country prefix'),
			country: iso2('country code when the number has no prefix').optional(),
			from: z.string().optional().describe('Your own VAT number. Returns a consultation identifier for your audit file'),
			deep,
		},
		(c, a, request) => c.vat(a.number, { ...request, country: a.country, from: a.from, deep: a.deep })
	);
	tool(
		'iban',
		'Parse an IBAN: checksum and structure. Returns the normalized number, the print form for display, country, checksum digits, bank, branch, and account identifiers, plus bank_name and bic when available. Junk answers valid false, never a 404. Pass country when the value has no prefix.',
		{
			iban: z.string().describe('IBAN, with or without spaces, with or without the country prefix'),
			country: iso2('country code when the number has no prefix').optional(),
		},
		(c, a, request) => c.iban(a.iban, { ...request, country: a.country })
	);
	tool(
		'npi',
		'Look up a US healthcare provider by NPI: name, specialty, practice address, deactivation date, and exclusion status. Deep adds Medicare enrollment on paid plans.',
		{
			npi: z.string().describe('10-digit NPI number'),
			deep,
		},
		(c, a, request) => c.npi(a.npi, { ...request, deep: a.deep })
	);
	tool(
		'phone',
		'Validate and parse a phone number: country, type, area-code state, timezone, formats. Pass country for national-format numbers.',
		{
			number: z.string().describe('Phone number, e.g. +14155552671'),
			country: iso2('country code for national-format numbers').optional(),
			deep,
		},
		(c, a, request) => c.phone(a.number, { ...request, country: a.country, deep: a.deep })
	);
	tool(
		'carrier',
		'Look up the current carrier serving a phone number: carrier name, network type including voip, burner app flag, issuing city and state. Metered per lookup on a valid number.',
		{
			number: z.string().describe('Phone number, e.g. +14155552671'),
			country: iso2('country code for national-format numbers').optional(),
		},
		(c, a, request) => c.carrier(a.number, { ...request, country: a.country })
	);
	tool(
		'caller',
		'Look up the caller ID name (CNAM) for a US or Canada phone number. caller is the record verbatim, null when no record or outside NANP. Metered per lookup on a NANP number.',
		{
			number: z.string().describe('Phone number, e.g. +18004633339'),
			country: iso2('country code for national-format numbers').optional(),
		},
		(c, a, request) => c.caller(a.number, { ...request, country: a.country })
	);
	tool(
		'hlr',
		'Live network status for a phone number worldwide: live means assigned, connected means the handset is reachable right now. Outside North America adds roaming and network details. Metered per lookup on a valid number.',
		{
			number: z.string().describe('Phone number, e.g. +447712345678'),
			country: iso2('country code for national-format numbers').optional(),
		},
		(c, a, request) => c.hlr(a.number, { ...request, country: a.country })
	);
	tool(
		'domain',
		'Look up a domain: registration, DNS, mail setup. Deep adds richer checks.',
		{ domain: z.string().describe('Domain name, e.g. example.com'), deep },
		(c, a, request) => c.domain(a.domain, { ...request, deep: a.deep })
	);
	tool('asn', 'Network name and country for an autonomous system number.', { asn: z.string().describe('Autonomous system number, such as AS13335 or 13335') }, (c, a, request) =>
		c.asn(a.asn, request)
	);

	tool('mac', 'Normalize a 48-bit MAC address and return its registered assignment holder, local flag, and multicast flag. Vendor is null for local or multicast addresses.', { mac: z.string().describe('MAC address') }, (c, a, request) =>
		c.mac(a.mac, request)
	);

	tool('mx', 'MX records for a domain.', { domain: z.string().describe('Domain name') }, (c, a, request) =>
		c.mx(a.domain, request)
	);
	tool(
		'useragent',
		'Parse a User-Agent string: browser, OS, device, bot detection.',
		{ ua: z.string().describe('The User-Agent string to parse'), deep },
		(c, a, request) => c.useragent(a.ua, { ...request, deep: a.deep })
	);

	// Decode
	tool(
		'vin',
		'Decode a 17-character VIN: year, make, model, trim, body, engine, drive, transmission, manufacturer, and assembly plant. Junk or a failed check digit answers valid false, never a 404. Deep adds open recall campaigns on paid plans.',
		{ vin: z.string().describe('The VIN as you have it. Spaces and punctuation fold out'), deep },
		(c, a, request) => c.vin(a.vin, { ...request, deep: a.deep })
	);
	tool(
		'tariff',
		'US import duty. Look up an HTS code: description, duty rates verbatim (general, special, column 2), units, parent lineage, and the official revision that answered. Deep with an origin country resolves the Chapter 99 tariff measures that apply from that origin, with a composed effective_rate when the components compose cleanly (null otherwise, null beats a guess). Unknown code is a 404. US schedule only.',
		{
			code: z.string().describe('HTS code, 4 to 10 digits, dots optional, e.g. 8471.30.01.00'),
			origin: iso2('country of origin for duty resolution, only read with deep').optional(),
			deep,
		},
		(c, a, request) => c.tariff(a.code, { ...request, deep: a.deep, origin: a.origin })
	);
	tool(
		'tariff_search',
		'Search US tariff schedule descriptions by product. Returns up to 20 lines, best match first, each with hts, description, and the general duty rate.',
		{ query: z.string().describe('Product words, e.g. sunglasses, laptop, coffee') },
		(c, a, request) => c.tariff.search(a.query, request)
	);
	tool(
		'currency',
		'Look up a currency: name, symbol, decimal places, countries using it.',
		{ code: z.string().describe('ISO 4217 code, e.g. USD') },
		(c, a, request) => c.currency(a.code, request)
	);
	tool(
		'currency_rate',
		'Reference exchange rate between two currencies. Pass date for a past business day, amount to convert.',
		{
			base: z.string().describe('Base currency ISO 4217 code, e.g. USD'),
			quote: z.string().describe('Quote currency ISO 4217 code, e.g. EUR'),
			date: z
				.string()
				.optional()
				.describe(
					'YYYY-MM-DD. Official rate for that business day. A weekend or holiday resolves to the last published day on or before it'
				),
			amount: z
				.number()
				.optional()
				.describe('Appends amount and converted, rounded to the quote currency minor-unit digits'),
		},
		(c, a, request) => c.currency.rate(a.base, a.quote, { ...request, date: a.date, amount: a.amount })
	);
	tool(
		'language',
		'Look up a language by BCP 47 or ISO 639-3 code: names, script, direction.',
		{ code: z.string().describe('Language code, e.g. en, ja, gsw') },
		(c, a, request) => c.language(a.code, request)
	);
	tool(
		'name',
		'Parse a person name: prefix, first, middle, last, suffix, gender, salutation. Junk input returns valid false. Gender comes from dictionary data and is null when the data does not decide.',
		{ name: z.string().describe('The name to parse, e.g. Smith, John or BILLY OSHALL') },
		(c, a, request) => c.name(a.name, request)
	);
	tool(
		'timezone',
		'Look up a timezone from an IANA id or from lat and lon. Offset, DST, local time. Pass at for a specific instant. Pass to with another IANA id to convert a time between zones: the response appends at (wall time in the from zone) and to.at (the converted time). Open ocean answers the nautical Etc/GMT zone.',
		{
			timezone: z.string().min(1).optional().describe('IANA timezone id, e.g. America/New_York'),
			lat: lat.optional(),
			lon: lon.optional(),
			at: z
				.string()
				.optional()
				.describe(
					'ISO 8601 time, default now. With to and no UTC offset, reads as wall time in the from zone'
				),
			to: z
				.string()
				.optional()
				.describe('Convert: the other IANA zone, e.g. Asia/Tokyo. Requires timezone, not lat/lon'),
		},
		(c, a, request) => {
			if (a.lat != null && a.lon != null) {
				return c.timezone.at(a.lat, a.lon, { ...request, at: a.at });
			}
			if (!a.timezone) {
				return Promise.reject(new Error('Pass timezone or lat and lon'));
			}
			return c.timezone(a.timezone, { ...request, at: a.at, to: a.to });
		},
		(schema) => schema.refine(
			(a) => a.timezone !== undefined
				? a.lat === undefined && a.lon === undefined
				: a.lat !== undefined && a.lon !== undefined && a.to === undefined,
			{ message: 'Pass either timezone (with optional to), or both lat and lon.' }
		)
	);
	tool(
		'date',
		'Parse a date in any common format (2026-03-29, March 29, 2026, 3/29/2026, 20260829) into calendar facts: ISO date, weekday, ISO week, day of year, quarter, leap year, unix time. Ambiguous numeric dates answer valid false unless format asserts a reading, never a guess. Pass to with another date for the signed days between. Omit date for today (UTC), so to alone answers days from today.',
		{
			date: z
				.string()
				.min(1)
				.optional()
				.describe('The date as you have it, any common format. Omit for today (UTC)'),
			format: z
				.enum(['mdy', 'dmy'])
				.optional()
				.describe('Breaks the month-first / day-first tie on numeric dates like 03/04/2026'),
			to: z
				.string()
				.optional()
				.describe('Another date. Appends to (normalized ISO) and days (signed days between)'),
		},
		(c, a, request) => {
			if (a.date == null) return c.date.today({ ...request, to: a.to });
			return c.date(a.date, { ...request, format: a.format, to: a.to });
		},
		(schema) => schema.refine(
			(a) => a.format === undefined || a.date !== undefined,
			{ message: 'Pass date when specifying format; omit both for today.' }
		)
	);
	tool(
		'holiday',
		'Public holidays and cultural observances for a country and year. Each row carries type: public or observance.',
		{
			country: iso2('country code'),
			year: z.number().int().optional().describe('Year, default current'),
		},
		(c, a, request) => c.holiday(a.country, { ...request, year: a.year })
	);
	tool(
		'holiday_date',
		'Whether a specific date is a holiday or observance in a country. holiday is null when it is not.',
		{ country: iso2('country code'), date: z.string().describe('Date as YYYY-MM-DD') },
		(c, a, request) => c.holiday.date(a.country, a.date, request)
	);
	tool(
		'emoji',
		'Look up an emoji by name or character: unicode, hex, skin tones.',
		{ emoji: z.string().describe('Emoji name or the character itself, e.g. rocket') },
		(c, a, request) => c.emoji(a.emoji, request)
	);
	tool(
		'emoji_search',
		'Search emoji by keyword.',
		{
			query: z.string().describe('Search keyword, e.g. fire'),
			limit: z.number().int().min(1).max(50).optional().describe('Max results'),
		},
		(c, a, request) => c.emoji.search(a.query, { ...request, limit: a.limit })
	);

	return server;
}
