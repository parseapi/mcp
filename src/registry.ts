import { McpServer } from '@modelcontextprotocol/server';
import { parseAPI } from '@parseapi/sdk';
import * as z from 'zod';
import { noKeyResult, ok, toErrorResult, type ToolResult } from './errors.js';

export const VERSION = '0.2.0';

type Client = ReturnType<typeof parseAPI>;
export type Transport = 'stdio' | 'http';

const deep = z
	.boolean()
	.optional()
	.describe('Include the nested deep object with richer fields. Paid on most endpoints.');
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
				'Lookups for agents: IP and place data, email, VAT, IBAN, NPI, phone and domain validation, weather, currency, timezones, holidays. Real reference data instead of guessing.',
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
		'Look up an IPv4 or IPv6 address: country, region, ASN, timezone. Deep adds datacenter, relay, tor and vpn flags.',
		{ ip: z.string().describe('IPv4 or IPv6 address, e.g. 8.8.8.8'), deep },
		(c, a) => c.ip(a.ip, { deep: a.deep })
	);
	if (transport === 'stdio') {
		tool(
			'ip_self',
			'Look up the public IP of the machine running this MCP server.',
			{ deep },
			(c, a) => c.ip.self({ deep: a.deep })
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
		'bloc',
		'Look up a country group by code: EU, EEA, Schengen, Eurozone, SEPA, NATO, and more. Returns the official name and the current member count.',
		{
			code: z
				.string()
				.describe('Bloc code: EU, EEA, EFTA, SCHENGEN, EUROZONE, SEPA, NATO, OECD, G7, ASEAN, GCC, MERCOSUR'),
		},
		(c, a) => {
			const client = c as unknown as {
				bloc: ((code: string) => Promise<unknown>) & {
					countries: (code: string) => Promise<unknown>;
				};
			};
			return client.bloc(a.code);
		}
	);
	tool(
		'bloc_countries',
		'List the current members of a country group, each with name, flag, and calling code.',
		{
			code: z
				.string()
				.describe('Bloc code: EU, EEA, EFTA, SCHENGEN, EUROZONE, SEPA, NATO, OECD, G7, ASEAN, GCC, MERCOSUR'),
		},
		(c, a) => {
			const client = c as unknown as {
				bloc: ((code: string) => Promise<unknown>) & {
					countries: (code: string) => Promise<unknown>;
				};
			};
			return client.bloc.countries(a.code);
		}
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
		'Look up a state, province or region by code or name. Unique names resolve without a country. A colliding code 404s asking for ?country=. Country takes ISO2, ISO3, or a name.',
		{
			code: z.string().describe('State code or name, e.g. colorado, NC'),
			country: countryOpt,
		},
		(c, a) => c.state(a.code, { country: a.country })
	);
	tool(
		'state_districts',
		'List the districts, counties or departments of a state.',
		{
			code: z.string().describe('State code or name, e.g. NC, colorado'),
			country: countryOpt,
		},
		(c, a) => c.state.districts(a.code, { country: a.country })
	);
	tool(
		'district',
		'Look up a district, county or department by code or name. Pass state when a name collides.',
		{
			code: z.string().describe('District code or name, e.g. 37081, guilford county'),
			country: countryOpt,
			state: z.string().optional().describe('ADM1 code or name to disambiguate, e.g. NC or louisiana'),
		},
		(c, a) => c.district(a.code, { country: a.country, state: a.state })
	);
	tool(
		'city',
		'Look up a city by name: type, capital status (capital_of), district, elevation, area in km2, coordinates, timezone. Pass country or state to disambiguate name ties.',
		{
			name: z.string().describe('City name, e.g. charlotte'),
			country: countryOpt,
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
			country: countryOpt,
			state: z.string().optional().describe('State code filter'),
			limit: z.number().int().min(1).max(50).optional().describe('Max results'),
		},
		(c, a) => c.city.search(a.q, { country: a.country, state: a.state, limit: a.limit })
	);
	tool('city_nearest', 'Find the nearest city to coordinates.', { lat, lon }, (c, a) =>
		c.city.nearest(a.lat, a.lon)
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
		(c, a) =>
			c.city.nearby(a.name, {
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
		(c, a) => c.postal(a.code, { country: a.country })
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
		(c, a) => c.postal.nearby(a.code, { country: a.country, radius: a.radius, unit: a.unit })
	);
	tool(
		'postal_distance',
		'Distance between two postal codes in the same country. Unique codes resolve without a country.',
		{
			from: z.string().describe('First postal code'),
			to: z.string().describe('Second postal code'),
			country: countryOpt,
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
		'Current weather observation at coordinates from official national agencies. Every measurement ships metric and imperial side by side. Deep adds minute-by-minute rain, hourly and daily rows worldwide, alerts, and air quality. With deep, date returns a past day as deep.history.',
		{
			lat,
			lon,
			deep,
			date: z
				.string()
				.optional()
				.describe('A past UTC day, YYYY-MM-DD. Requires deep. Returns that day as deep.history'),
		},
		(c, a) => c.weather(a.lat, a.lon, { deep: a.deep, date: a.date })
	);

	// Validate
	tool(
		'email',
		'Validate an email address: syntax, domain, MX, disposable, role, and a typo suggestion when the host looks misspelled. Deep runs a live mailbox verification.',
		{ email: z.string().describe('Email address to validate'), deep },
		(c, a) => c.email(a.email, { deep: a.deep })
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
		(c, a) =>
			(
				c as Client & {
					vat: (
						number: string,
						opts?: { country?: string; from?: string; deep?: boolean }
					) => Promise<unknown>;
				}
			).vat(a.number, { country: a.country, from: a.from, deep: a.deep })
	);
	tool(
		'iban',
		'Parse an IBAN: checksum and structure. Returns the normalized number, the print form for display, country, checksum digits, and the bank, branch, and account identifiers sitting inside it. bank and branch are codes, not names. Junk answers valid false, never a 404. Pass country when the value has no prefix.',
		{
			iban: z.string().describe('IBAN, with or without spaces, with or without the country prefix'),
			country: iso2('country code when the number has no prefix').optional(),
		},
		(c, a) =>
			(
				c as Client & {
					iban: (iban: string, opts?: { country?: string }) => Promise<unknown>;
				}
			).iban(a.iban, { country: a.country })
	);
	tool(
		'npi',
		'Look up an NPI in the CMS NPPES registry: US healthcare provider name, specialty, practice address, deactivation date, and the OIG exclusion flag. Deep adds Medicare enrollment on paid plans.',
		{
			npi: z.string().describe('10-digit NPI number'),
			deep,
		},
		(c, a) =>
			(
				c as Client & {
					npi: (npi: string, opts?: { deep?: boolean }) => Promise<unknown>;
				}
			).npi(a.npi, { deep: a.deep })
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
		'carrier',
		'Look up the current carrier serving a phone number: carrier name, network type including voip, burner app flag, issuing city and state. Metered per lookup on a valid number.',
		{
			number: z.string().describe('Phone number, e.g. +14155552671'),
			country: iso2('country code for national-format numbers').optional(),
		},
		(c, a) => c.carrier(a.number, { country: a.country })
	);
	tool(
		'caller',
		'Look up the caller ID name (CNAM) for a US or Canada phone number. caller is the record verbatim, null when no record or outside NANP. Metered per lookup on a NANP number.',
		{
			number: z.string().describe('Phone number, e.g. +18004633339'),
			country: iso2('country code for national-format numbers').optional(),
		},
		(c, a) => c.caller(a.number, { country: a.country })
	);
	tool(
		'hlr',
		'Live network status for a phone number worldwide: live means assigned, connected means the handset is reachable right now. Outside North America adds roaming and network details. Metered per lookup on a valid number.',
		{
			number: z.string().describe('Phone number, e.g. +447712345678'),
			country: iso2('country code for national-format numbers').optional(),
		},
		(c, a) => c.hlr(a.number, { country: a.country })
	);
	tool(
		'domain',
		'Look up a domain: registration, DNS, mail setup. Deep adds richer checks.',
		{ domain: z.string().describe('Domain name, e.g. example.com'), deep },
		(c, a) => c.domain(a.domain, { deep: a.deep })
	);
	tool('mx', 'MX records for a domain.', { domain: z.string().describe('Domain name') }, (c, a) =>
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
		'vin',
		'Decode a 17-character VIN: year, make, model, trim, body, engine, drive, transmission, manufacturer, and assembly plant. Junk or a failed check digit answers valid false, never a 404. Deep adds open recall campaigns on paid plans.',
		{ vin: z.string().describe('The VIN as you have it. Spaces and punctuation fold out'), deep },
		(c, a) =>
			(
				c as Client & {
					vin: (vin: string, opts?: { deep?: boolean }) => Promise<unknown>;
				}
			).vin(a.vin, { deep: a.deep })
	);
	tool(
		'hts',
		'Look up a US Harmonized Tariff Schedule code: description, duty rates verbatim (general, special, column 2), units, parent lineage, and the official revision that answered. Deep with an origin country resolves the Chapter 99 tariff measures that apply from that origin, with a composed effective_rate when the components compose cleanly (null otherwise, null beats a guess). Unknown code is a 404.',
		{
			code: z.string().describe('HTS code, 4 to 10 digits, dots optional, e.g. 8471.30.01.00'),
			origin: iso2('country of origin for duty resolution, only read with deep').optional(),
			deep,
		},
		(c, a) =>
			(
				c as Client & {
					hts: (code: string, opts?: { deep?: boolean; origin?: string }) => Promise<unknown>;
				}
			).hts(a.code, { deep: a.deep, origin: a.origin })
	);
	tool(
		'hts_search',
		'Search US tariff schedule descriptions by product. Returns up to 20 lines, best match first, each with hts, description, and the general duty rate.',
		{ q: z.string().describe('Product words, e.g. sunglasses, laptop, coffee') },
		(c, a) =>
			(
				c as Client & {
					hts: { search: (q: string) => Promise<unknown> };
				}
			).hts.search(a.q)
	);
	tool(
		'currency',
		'Look up a currency: name, symbol, decimal places, countries using it.',
		{ code: z.string().describe('ISO 4217 code, e.g. USD') },
		(c, a) => c.currency(a.code)
	);
	tool(
		'currency_rate',
		'Exchange rate between two currencies from official central bank data. Pass date for a past business day, amount to convert.',
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
		(c, a) =>
			(
				c.currency.rate as (
					base: string,
					quote: string,
					opts?: { date?: string; amount?: number }
				) => ReturnType<typeof c.currency.rate>
			)(a.base, a.quote, { date: a.date, amount: a.amount })
	);
	tool(
		'language',
		'Look up a language by BCP 47 or ISO 639-3 code: names, script, direction.',
		{ code: z.string().describe('Language code, e.g. en, ja, gsw') },
		(c, a) => c.language(a.code)
	);
	tool(
		'name',
		'Parse a person name: prefix, first, middle, last, suffix, gender, salutation. Junk input returns valid false. Gender comes from dictionary data and is null when the data does not decide.',
		{ name: z.string().describe('The name to parse, e.g. Smith, John or BILLY OSHALL') },
		(c, a) => c.name(a.name)
	);
	tool(
		'timezone',
		'Look up a timezone from an IANA id or from lat and lon. Offset, DST, local time. Pass at for a specific instant. Pass to with another IANA id to convert a time between zones: the response appends at (wall time in the from zone) and to.at (the converted time). Open ocean answers the nautical Etc/GMT zone.',
		{
			timezone: z.string().optional().describe('IANA timezone id, e.g. America/New_York'),
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
		(c, a) => {
			if (a.lat != null && a.lon != null) {
				return (
					c.timezone as unknown as (
						lat: number,
						lon: number,
						opts?: { at?: string }
					) => ReturnType<Client['timezone']>
				)(a.lat, a.lon, { at: a.at });
			}
			if (!a.timezone) {
				return Promise.reject(new Error('Pass timezone or lat and lon'));
			}
			return (
				c.timezone as unknown as (
					id: string,
					opts?: { at?: string; to?: string }
				) => ReturnType<Client['timezone']>
			)(a.timezone, { at: a.at, to: a.to });
		}
	);
	tool(
		'date',
		'Parse a date in any common format (2026-03-29, March 29, 2026, 3/29/2026, 20260829) into calendar facts: ISO date, weekday, ISO week, day of year, quarter, leap year, unix time. Ambiguous numeric dates answer valid false unless format asserts a reading, never a guess. Pass to with another date for the signed days between. Omit date for today (UTC), so to alone answers days from today.',
		{
			date: z
				.string()
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
		(c, a) => {
			const client = c as unknown as {
				date: ((date: string, opts?: { format?: 'mdy' | 'dmy'; to?: string }) => Promise<unknown>) & {
					today: (opts?: { to?: string }) => Promise<unknown>;
				};
			};
			if (a.date == null || a.date === '') return client.date.today({ to: a.to });
			return client.date(a.date, { format: a.format, to: a.to });
		}
	);
	tool(
		'holiday',
		'Public holidays and cultural observances for a country and year. Each row carries type: public or observance.',
		{
			country: iso2('country code'),
			year: z.number().int().optional().describe('Year, default current'),
		},
		(c, a) => c.holiday(a.country, { year: a.year })
	);
	tool(
		'holiday_date',
		'Whether a specific date is a holiday or observance in a country. holiday is null when it is not.',
		{ country: iso2('country code'), date: z.string().describe('Date as YYYY-MM-DD') },
		(c, a) => c.holiday.date(a.country, a.date)
	);
	tool(
		'emoji',
		'Look up an emoji by name or character: unicode, hex, skin tones.',
		{ emoji: z.string().describe('Emoji name or the character itself, e.g. rocket') },
		(c, a) => c.emoji(a.emoji)
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
