import { McpServer } from '@modelcontextprotocol/server';
import { parseAPI, type RequestOptions } from '@parseapi/sdk';
import * as z from 'zod';
import { noKeyResult, ok, toErrorResult, type ToolResult } from './errors.js';
import { registerDiscovery, type CatalogMode, type CatalogOperation } from './discovery.js';
import { registerPreflight } from './preflight.js';

export const VERSION = '1.3.0';
const API_VERSION = '2.0.0';
const US_ROUTING_NOTICE = 'Routing reference attribution: https://parseapi.com/legal/attribution#routing-numbers';
const AU_POSTAL_NOTICE = 'Incorporates or developed using G-NAF © Geoscape Australia licensed by the Commonwealth of Australia under the Open Geo-coded National Address File (G-NAF) End User Licence Agreement. Geographic choices are not mailing-address verification. Source, adaptations and licence: https://parseapi.com/legal/attribution#postal-au';

type Client = ReturnType<typeof parseAPI>;
export type Transport = 'stdio' | 'http';

const deep = z
	.boolean()
	.optional()
	.describe('Include the nested deep object when available. Pricing depends on the operation.');
const lat = z.number().min(-90).max(90).describe('Latitude in decimal degrees');
const lon = z.number().min(-180).max(180).describe('Longitude in decimal degrees');
const iso2 = (what: string) => z.string().describe(`ISO 3166-1 alpha-2 ${what}, e.g. US`);
const tariffEdition = z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Exact immutable edition fingerprint. Without date, returns undated schedule context.');
const tariffDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD with verified source coverage. Combine with edition only when it covers this date.');
const countryOpt = z
	.string()
	.optional()
	.describe('ISO2, ISO3, or a country name. Optional when the lookup is unique.');

const languageTools = new Set(['ip', 'ip_self', 'asn', 'company', 'provider', 'continent', 'continent_countries', 'bloc_countries', 'country', 'country_states',
	'state', 'state_districts', 'district', 'city', 'city_id', 'city_search', 'city_nearest', 'city_nearby',
	'postal', 'postal_nearby', 'postal_distance', 'currency', 'language', 'date', 'time', 'timezone',
	'measure_units', 'emoji', 'emoji_search', 'point']);
const displayLanguage = z.string().min(2).max(64).optional()
	.describe('Optional display language, such as fr or zh-Hant. IDs, numeric values and input parsing stay unchanged.');

/**
 * One server, every ParseAPI lookup as a tool. `key` null serves the funnel:
 * tools list fine, calls return invalid_api_key pointing at signup.
 */
export function buildServer(key: string | null, transport: Transport, options: { mode?: CatalogMode } = {}): McpServer {
	const mode = options.mode ?? 'full';
	if (mode !== 'full' && mode !== 'compact') throw new Error('Unknown MCP catalog mode');
	const operations = new Map<string, CatalogOperation>();
	const server = new McpServer(
		{
			name: 'parseapi',
			version: VERSION,
			title: 'ParseAPI',
			description:
				'Lookups for agents: IP and place data, addresses, company numbers, email, VAT, IBAN, NPI, phone, domains, weather, currency, measurements, timezones, dates and holidays. Real reference data instead of guessing.',
			websiteUrl: 'https://parseapi.com',
		},
		{ capabilities: { tools: {} } }
	);

	const parse = key ? parseAPI(key, {
		// Tool descriptions and responses share this contract on both transports.
		fetch: (input, init) => {
			const headers = new Headers(init?.headers);
			headers.set('Parse-Version', API_VERSION);
			return fetch(input, { ...init, headers });
		},
	}) : null;

	function tool<S extends z.ZodRawShape>(
		name: string,
		description: string,
		shape: S,
		fn: (client: Client, args: z.infer<z.ZodObject<S>>, options: RequestOptions) => Promise<unknown>,
		refine?: (schema: z.ZodObject<S>) => z.ZodObject<S>
	): void {
		const localized = languageTools.has(name);
		const input = z.object(localized ? { ...shape, lang: displayLanguage } : shape);
		const schema = refine ? refine(input as z.ZodObject<S>) : input;
		const invoke = async (args: unknown, signal: AbortSignal): Promise<ToolResult> => {
			if (!parse) return noKeyResult(transport);
			try {
				const requested = (args as Record<string, unknown>).lang;
				const request: RequestOptions & { lang?: string } = { signal,
					...(localized && typeof requested === 'string' ? { lang: requested } : {}) };
				const data = await fn(parse, args as z.infer<z.ZodObject<S>>, request);
				const result = ok(data);
				if (['postal', 'postal_nearby', 'postal_distance'].includes(name) && data && typeof data === 'object' && 'country' in data && data.country === 'AU') {
					result.content.push({ type: 'text', text: AU_POSTAL_NOTICE });
				}
				if (name === 'bank_us_ach' && data && typeof data === 'object' && 'bank_name' in data && typeof data.bank_name === 'string' && data.bank_name.length > 0) {
					result.content.push({ type: 'text', text: US_ROUTING_NOTICE });
				}
				return result;
			} catch (err) {
				return toErrorResult(err);
			}
		};
		operations.set(name, { name, description, schema, invoke });
		if (mode === 'compact') return;
		server.registerTool(
			name,
			{
				description,
				inputSchema: schema,
				annotations: { readOnlyHint: true },
			},
			(args, context) => invoke(args, context.mcpReq.signal)
		);
	}

	tool(
		'measure',
		'Parse a measurement or convert it to a target unit. Supports mixed measurements such as 5 ft 11 in. Amount is a decimal string. Without to, returns the canonical unit for its type. Ambiguous input returns valid false, reason and choices. Use measure_units to discover accepted units. Pooled request, no separate check charge.',
		{
			measure: z.string().min(1).max(256).describe('Measurement to parse, e.g. 5 ft 11 in or 10 kg'),
			to: z.string().min(1).max(128).optional().describe('Target unit, e.g. cm or lb'),
			locale: z.string().min(1).max(32).optional().describe('Explicit number locale, e.g. de-DE'),
			system: z.enum(['us', 'imperial']).optional().describe('Resolve an ambiguous customary unit using the stated system'),
		},
		(c, a, request) => c.measure(a.measure, { ...request, to: a.to, locale: a.locale, system: a.system })
	);
	tool(
		'measure_units',
		'Discover the reviewed measurement units, canonical codes, types and aliases. With no filters, returns the full catalog. Pass unit to find compatible conversion targets. Combine query and type to narrow results.',
		{
			query: z.string().max(128).optional().describe('Search text, e.g. foot'),
			type: z.string().min(1).max(64).optional().describe('Measurement type, e.g. length'),
			unit: z.string().min(1).max(128).optional().describe('Return units compatible with this unit, e.g. m'),
		},
		(c, a, request) => c.measure.units({ ...request, query: a.query, type: a.type, unit: a.unit })
	);

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
		'Look up a continent by code: name, area and population.',
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
		'Country names, language codes, currency, calling code and timezones. Deep adds the country reference profile on paid plans, including population with its reporting period, land/water area in km2, coastline in km, mean and extreme elevations in metres, tax and locale conventions. Unknown geography values stay null.',
		{ code: iso2('country code'), deep: deep.describe('Include the complete detail bag on a paid plan.') },
		(c, a, request) => c.country(a.code, { ...request, deep: a.deep })
	);
	tool(
		'country_states',
		'List the states, provinces or regions of a country.',
		{ code: iso2('country code') },
		(c, a, request) => c.country.states(a.code, request)
	);
	tool(
		'state',
		'Look up a state or province by code or name. Deep adds its demographic and tax profile on paid plans, including population_period when verified. Pass country to resolve a colliding code.',
		{
			code: z.string().describe('State code or name, e.g. colorado, NC'),
			country: countryOpt,
			deep: deep.describe('Include the complete detail bag on a paid plan.'),
		},
		(c, a, request) => c.state(a.code, { ...request, deep: a.deep, country: a.country })
	);
	tool(
		'state_districts',
		'List the districts, counties or departments of a state. Deep adds population and its reporting period to each result on paid plans.',
		{
			code: z.string().describe('State code or name, e.g. NC, colorado'),
			country: countryOpt,
			deep: deep.describe('Include population and its reporting period in each district detail bag on a paid plan.'),
		},
		(c, a, request) => c.state.districts(a.code, { ...request, deep: a.deep, country: a.country })
	);
	tool(
		'district',
		'Look up a district, county or department by code or name. Deep adds area, population and seat on paid plans. Pass state to resolve a colliding name. Population includes a reporting year or period when verified. Paid deep property_tax contains annual_median, currency and period: median annual tax payable on owner-occupied homes in the area, adjusted to the final year of that period. It is not a rate or property bill. Unsupported, missing and censored estimates are null.',
		{
			code: z.string().describe('District code or name, e.g. 37081, guilford county'),
			country: countryOpt,
			state: z.string().optional().describe('ADM1 code or name to disambiguate, e.g. NC or louisiana'),
			deep: deep.describe('Include the complete detail bag on a paid plan.'),
		},
		(c, a, request) => c.district(a.code, { ...request, deep: a.deep, country: a.country, state: a.state })
	);
	tool(
		'city',
		'Resolve a city name to coordinates, timezone and administrative context. Deep adds demographic and geographic detail on paid plans. Pass country or state for name ties. Population includes a reporting year or period when verified.',
		{
			name: z.string().describe('City name, e.g. charlotte'),
			country: countryOpt,
			state: z.string().optional().describe('State code to disambiguate, e.g. NC'),
			deep: deep.describe('Include the complete detail bag on a paid plan.'),
		},
		(c, a, request) => c.city(a.name, { ...request, deep: a.deep, country: a.country, state: a.state })
	);
	tool(
		'city_id',
		'Resolve a stable city id. Deep adds the city profile on paid plans.',
		{ id: z.string().describe('Stable city id, e.g. city_mb8mbqrkz8zb'), deep: deep.describe('Include the complete detail bag on a paid plan.') },
		(c, a, request) => c.city.id(a.id, { ...request, deep: a.deep })
	);
	tool(
		'city_search',
		'Search city names. Deep adds the profile inside each returned city on paid plans.',
		{
			query: z.string().describe('Name prefix, e.g. char'),
			country: countryOpt,
			state: z.string().optional().describe('State code filter'),
			limit: z.number().int().min(1).max(50).optional().describe('Max results'),
			deep: deep.describe('Include the complete detail bag on a paid plan.'),
		},
		(c, a, request) => c.city.search(a.query, { ...request, deep: a.deep, country: a.country, state: a.state, limit: a.limit })
	);
	tool('city_nearest', 'Find the nearest city with distance. Deep adds the city profile on paid plans.', { lat, lon, deep }, (c, a, request) =>
		c.city.nearest(a.lat, a.lon, { ...request, deep: a.deep })
	);
	tool(
		'city_nearby',
		'Find nearby cities with distances. Deep adds the profile inside each returned city on paid plans.',
		{
			name: z.string().describe('Anchor city name, e.g. denver'),
			country: countryOpt,
			state: z.string().optional().describe('State code to disambiguate the anchor'),
			radius: z.number().positive().optional().describe('Search radius, default 40 km'),
			unit: z.enum(['km', 'mi']).optional().describe('Radius unit, default km'),
			limit: z.number().int().min(1).max(50).optional().describe('Max results, default 10'),
			deep: deep.describe('Include the complete detail bag on a paid plan.'),
		},
		(c, a, request) =>
			c.city.nearby(a.name, {
				...request,
				deep: a.deep,
				country: a.country,
				state: a.state,
				radius: a.radius,
				unit: a.unit,
				limit: a.limit,
			})
	);
	tool(
		'postal',
		'Resolve a postal code to its place, coordinates and timezone. Australian core localities lists suburb choices with city, state and state_name. Null or missing means unknown, and [] means no eligible choices in the reviewed reference. A single choice can coexist with city null, so do not infer a city or a user selection. These are geographic choices, not mailing-address verification. Deep adds area, population with its reporting period, tax references, neighbors and metro associations on paid plans. property_tax is a nullable area statistic with annual_median, currency and period: median annual tax payable on owner-occupied homes, adjusted to the final year of the period. It is not a rate or property bill. Unsupported, missing and censored estimates are null. Tax rates are percentages and alternative geographic references, not additive.',
		{
			code: z.string().describe('Postal or ZIP code, e.g. SW1A 1AA, 28202'),
			country: countryOpt,
			deep: deep.describe('Include the complete detail bag on a paid plan.'),
		},
		(c, a, request) => c.postal(a.code, { ...request, deep: a.deep, country: a.country })
	);
	tool(
		'postal_nearby',
		'Find nearby postal codes with distances. Deep adds metropolitan associations to the origin and each result on paid plans.',
		{
			code: z.string().describe('Postal code to search around'),
			country: countryOpt,
			radius: z.number().positive().optional().describe('Search radius'),
			unit: z.enum(['km', 'mi']).optional().describe('Radius unit, default km'),
			deep: deep.describe('Include the complete detail bag on a paid plan.'),
		},
		(c, a, request) => c.postal.nearby(a.code, { ...request, deep: a.deep, country: a.country, radius: a.radius, unit: a.unit })
	);
	tool(
		'postal_distance',
		'Distance between two postal codes. Deep adds metropolitan associations inside each endpoint on paid plans.',
		{
			from: z.string().describe('First postal code'),
			to: z.string().describe('Second postal code'),
			country: countryOpt,
			deep: deep.describe('Include the complete detail bag on a paid plan.'),
		},
		(c, a, request) => c.postal.distance(a.from, a.to, { ...request, deep: a.deep, country: a.country })
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
		'Search street addresses from a partial address. Prefer postal, or city and state, from the form. An optional end-user IP hints at locality. Empty results explain themselves with reason: more_input, missing_context or no_matches. With suggestions reason is null. Operational failures use API errors. French search requires country FR and either postal or city.',
		{
			query: z.string().describe('Partial street address, e.g. 1600 Pennsylvania'),
			country: z.string().optional().describe('Country: US or FR. Defaults to US.'),
			postal: z.string().optional().describe('Postal code from the address form, preferred for locality context'),
			city: z.string().optional().describe('City filter'),
			state: z.string().optional().describe('State code filter'),
			ip: z.string().optional().describe('End-user IP locality hint for server-side calls. Prefer explicit form context.'),
		},
		(c, a, request) => c.address.search(a.query, { ...request, country: a.country, postal: a.postal, city: a.city, state: a.state, ip: a.ip })
	);
	tool(
		'company',
		'Parse a company number and its registered identity, status and address. Paid deep adds business activity and associated identifiers. Geography lookups are separate calls.',
		{
			number: z.string().describe('Company registration number, e.g. 552100554 with country FR'),
			country: countryOpt,
			deep,
		},
		(c, a, request) => c.company(a.number, { ...request, country: a.country, deep: a.deep })
	);
	tool(
		'company_id',
		'Look up a company directory profile by its stable co_ ID. Deep adds legal/reference details and selected description, logo, socials, founding precision, reported employees and field-level sources when available. Employee counts retain their measurement date, organization scope and approximation flag; null means unknown. Reviewed registrations retain authority-scoped numbers, legal form, administrative status, register-specific formation dates and principal-address roles; they do not establish operations or tax exemption. Registration sources use business_register, with original observation time and nullable update time. A website claim is not legal ownership proof. National registration numbers use company.',
		{ id: z.string().min(1).describe('Stable company directory ID returned by company_search'), deep },
		(c, a, request) => c.company.id(a.id, { ...request, deep: a.deep })
	);
	tool(
		'company_search',
		'Find company directory candidates using at most one of query, domain, ticker or identifier, or discover by country, an exact industry pair or selected registration authority. Registration form/status are exact source values; administrative status does not establish current business activity. Returns companies and an opaque next cursor without choosing a match. Deep belongs to each result. Keep the same selector, filters and limit when sending cursor. Empty listings do not establish private ownership.',
		{
			query: z.string().min(1).optional().describe('Company name search, sent as q'),
			domain: z.string().min(1).optional().describe('Company website domain or URL'),
			ticker: z.string().min(1).optional().describe('Security ticker, optionally scoped by exchange'),
			identifier: z.string().min(1).optional().describe('Business identifier, preserving leading zeros'),
			country: z.string().regex(/^[A-Za-z]{2}$/).optional().describe('ISO2 profile-country filter; does not mean headquarters or operating presence'),
			industry: z.string().regex(/^[0-9]{4}$/).optional().describe('Exact four-digit SIC code string, preserving leading zeros; requires industry_type'),
			industry_type: z.literal('sic').optional().describe('Industry namespace; currently sic; requires industry'),
			registration_authority: z.string().regex(/^RA[0-9]{6}$/i).optional().describe('Selected registration authority, such as RA000599; ASCII case is normalized to uppercase; allows filter-only discovery'),
			registration_form: z.string().min(1).max(200).refine(value => value.trim().length > 0 && !/\p{Cc}/u.test(value), 'Use a nonblank source string without control characters.').optional().describe('Exact case-sensitive source legal-form code; requires registration_authority. DPC does not establish public/private ownership; DNC does not establish tax exemption'),
			registration_status: z.string().min(1).max(200).refine(value => value.trim().length > 0 && !/\p{Cc}/u.test(value), 'Use a nonblank source string without control characters.').optional().describe('Exact case-sensitive administrative source status, such as Good Standing; requires registration_authority; does not establish trading, solvency or present business existence'),
			exchange: z.string().optional().describe('Exchange filter for ticker searches'),
			authority: z.string().optional().describe('Issuing authority filter for identifier searches'),
			limit: z.number().int().min(1).max(50).optional().describe('Maximum candidates on this page, from 1 to 50'),
			cursor: z.string().optional().describe('Opaque next cursor returned by the same search'),
			deep,
		},
		(c, a, request) => c.company.search({ ...request, query: a.query, domain: a.domain, ticker: a.ticker, identifier: a.identifier, country: a.country, industry: a.industry, industry_type: a.industry_type, registration_authority: a.registration_authority?.toUpperCase(), registration_form: a.registration_form, registration_status: a.registration_status, exchange: a.exchange, authority: a.authority, limit: a.limit, cursor: a.cursor, deep: a.deep }),
		(schema) => schema
			.refine(args => (args.industry === undefined) === (args.industry_type === undefined), { message: 'Supply industry and industry_type together.' })
			.refine(args => (args.registration_form === undefined && args.registration_status === undefined) || args.registration_authority !== undefined, { message: 'Registration form and status require registration_authority.' })
			.refine(args => {
				const selectors = [args.query, args.domain, args.ticker, args.identifier].filter(value => value !== undefined).length;
				return selectors <= 1 && (selectors === 1 || args.country !== undefined || args.registration_authority !== undefined || (args.industry !== undefined && args.industry_type !== undefined));
			}, { message: 'Use at most one selector, or supply country, a complete industry pair or registration_authority.' })
	);
	tool(
		'company_coverage',
		'Describe the company directory edition, countries and record counts. Counts describe this edition and do not establish complete country or worldwide coverage. A missing profile does not establish that a company does not exist.',
		{},
		(c, _a, request) => c.company.coverage(request)
	);

	tool(
		'point',
		'Locate coordinates in their country, state, district and actual IANA timezone. Deep adds terrain and a compact nearest-city summary on every plan. The timezone ID stays in core. Nearest city is null when none is within 200 km.',
		{ lat, lon, deep },
		(c, a, request) => c.point(a.lat, a.lon, { ...request, deep: a.deep })
	);
	tool(
		'elevation',
		'Elevation in meters and feet with grid resolution in meters. Choose lat and lon for one sample, points for supplied coordinates in order, or path with samples for evenly spaced great-circle samples including both endpoints. Lists and paths use one pooled request. Unknown elevations stay null.',
		{
			lat: lat.optional(),
			lon: lon.optional(),
			points: z.string().min(1).max(12000).optional().describe('lat,lon pairs separated by |, or enc: followed by a Google polyline. At most 512 points and 12000 characters. Omit lat and lon.'),
			path: z.string().min(1).max(12000).optional().describe('Path with 2-512 vertices as lat,lon pairs separated by |, or enc: followed by a Google polyline. At most 12000 characters. Segments follow the shortest great-circle arc. Segments with antipodal endpoints are invalid. Requires samples. Omit lat, lon and points.'),
			samples: z.number().int().min(2).max(512).optional().describe('Number of evenly spaced samples along the path, including both endpoints. Required with path and invalid without it.'),
		},
		(c, a, request) => {
			if (a.path !== undefined) {
				return c.elevation.path(a.path, a.samples!, request);
			}
			if (a.points !== undefined) {
				return c.elevation.points(a.points, request);
			}
			return c.elevation(a.lat!, a.lon!, request);
		},
		(schema) => schema.refine(args => args.path !== undefined
			? args.samples !== undefined && args.lat === undefined && args.lon === undefined && args.points === undefined
			: args.samples === undefined && (args.points !== undefined
				? args.lat === undefined && args.lon === undefined
				: args.lat !== undefined && args.lon !== undefined),
		{ message: 'Pass lat and lon, points, or path with samples.' })
	);
	tool(
		'weather',
		'Current weather with observation time and station distance. Paid deep adds specialist current measurements, forecast, alerts, hourly and daily outlook, air quality and optional history. Metric and imperial pairs stay together. A date requires paid deep and adds the past UTC day in deep.history alongside current conditions.',
		{
			lat,
			lon,
			deep,
			date: z
				.string()
				.optional()
				.describe('A past UTC day, YYYY-MM-DD. Requires paid deep. Adds deep.history alongside current conditions.'),
		},
		(c, a, request) => c.weather(a.lat, a.lon, { ...request, deep: a.deep, date: a.date })
	);

	// Validate
	tool(
		'email',
		'Validate an email address: syntax, domain, mail routing, consumer mailbox, disposable, role, reserved domain type and typo suggestion. Deep adds mailbox deliverability, catch-all, status and the reason for the result, such as mailbox_full or mailbox_not_found. It also includes a suggested first name, no-reply flag, plus-address tag and mail service, such as Google or Microsoft. The suggested name is not a verified identity. Unavailable details are null.',
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
		'bank',
		'Send an IBAN in a POST JSON body, keeping it out of the request URL. Parse with core checks and issues for input, country, length, structure, ISO checksum and supported national checks. not_supported is not a failed national check. Known bank names and BICs are independent nullable directory facts. Deep adds check digits, branch, the BBAN account remainder and source edition/match grain when a directory lookup ran, on every plan. Does not verify account existence, ownership or payment reachability.',
		{
			iban: z.string().describe('Original IBAN input, with or without the country prefix. Preserve characters exactly so the API can report invalid input. Do not strip punctuation or decode percent escapes.'),
			country: iso2('country code when the number has no prefix').optional(),
			deep: deep.describe('Include optional detail on every plan.'),
		},
		(c, a, request) => c.bank(a.iban, { ...request, deep: a.deep, country: a.country })
	);
	tool(
		'bank_us_ach',
		'Check US routing-number format and ABA checksum plus account-field syntax. Sends original strings in a POST JSON body. No universal account checksum is available. A nullable bank_name is routing-directory identity only; this does not establish ACH eligibility, account existence or ownership. No deep option.',
		{
			routing: z.string().describe('Original US routing string. Preserve leading zeros and characters; the API validates accepted separators.'),
			account: z.string().describe('Original account string. Preserve all characters, letter case and leading zeros; do not trim, normalize or decode.'),
		},
		(c, a, request) => c.bankUsAch({ routing: a.routing, account: a.account }, request)
	);
	tool(
		'bank_requirements',
		'Describe supported Bank input fields, normalization rules, check scope and limitations for a country and format. Metadata only: support does not establish directory completeness or payment reachability.',
		{
			country: iso2('country code'),
			format: z.string().optional().describe('Input format, currently iban (default) or us_ach. Unknown formats report supported false.'),
		},
		(c, a, request) => c.bankRequirements(a.country, { ...request, format: a.format })
	);

	tool(
		'card',
		'Identify a network and its CDN SVG logo from 2-11 leading digits, including processor-provided BIN/IIN prefixes. Unknown or ambiguous networks return null brand and a generic logo. Optional deep adds the longest recorded prefix, issuer, country, funding type and nullable prepaid status. Core identity is independent of issuer coverage. A shorter deep.prefix is broader coverage; missing fields never inherit from a parent row. Partial reference data does not prove card validity, account existence or payment acceptance. One pooled request on every plan, including deep.',
		{
			bin: z.string().max(64, 'Send a prefix only: 2-11 digits.')
				.regex(/^[ \t\r\n-]*(?:[0-9][ \t\r\n-]*){2,11}$/, 'Send a prefix only: 2-11 digits.')
				.describe('Processor-provided leading digits as a string, 2-11 ASCII digits. Preserve zeros. Only ASCII space, tab, CR, LF and hyphen separators; at most 64 raw characters. Never send a full card number. Six or more digits enable issuer lookup.'),
			deep: deep.describe('Include recorded issuer details, pooled on every plan. Omitted by default; fewer than six digits returns all-null Deep fields.'),
		},
		(c, a, request) => c.card(a.bin, { ...request, deep: a.deep })
	);
	tool(
		'provider',
		'Look up an NPI in stored provider-directory sources. valid is format/checksum only; registered means found in the NPPES snapshot; active is recorded NPI activation, not licensure. excluded is an NPI-only OIG LEIE match, and false is not complete exclusion clearance. Returns identity, specialty and practice contact where held. Core sources provides nullable edition metadata on every plan. Paid deep adds all published taxonomies and reported license details, provider enumeration/update/reactivation dates, deactivation date, Medicare enrollment, opt-out and enrollment rows. Reported licenses are not verified licenses; provider update dates are not source freshness. Null means unknown. No live credential or payment-eligibility verification. Pooled request; no separate check meter.',
		{
			npi: z.string().describe('Original NPI input as a string, normally 10 digits. Preserve the input; invalid values return valid=false with unknown provider fields. Do not URI-decode it.'),
			deep: deep.describe('Include taxonomies, enumerated_at, updated_at, reactivated_at, deactivated_at, medicare, opt_out and enrollments from stored sources on paid plans. Omitted by default; Free returns {}. Null lists are unavailable; [] means the source recorded no rows.'),
		},
		(c, a, request) => c.provider(a.npi, { ...request, deep: a.deep })
	);
	tool(
		'phone',
		'Parse and validate a phone number with national and international display formats. Deep adds numbering-plan state and timezone on every plan. These do not locate a handset.',
		{
			number: z.string().describe('Phone number, e.g. +14155552671'),
			country: iso2('country code for national-format numbers').optional(),
			deep,
		},
		(c, a, request) => c.phone(a.number, { ...request, country: a.country, deep: a.deep })
	);
	tool(
		'carrier',
		'Look up current carrier, real line type and burner flag. Deep adds issuing city and state in the same metered lookup, including Free allowance units. No extra check or second paid gate.',
		{
			number: z.string().describe('Phone number, e.g. +14155552671'),
			country: iso2('country code for national-format numbers').optional(),
			deep: deep.describe('Include available detail within the same metered core unit. No extra charge or paid-plan gate.'),
		},
		(c, a, request) => c.carrier(a.number, { ...request, deep: a.deep, country: a.country })
	);
	tool(
		'caller',
		'Look up the caller ID name (CNAM) for a NANP (+1) phone number. caller is the record verbatim, null when no record or outside NANP. Metered per lookup on a NANP number.',
		{
			number: z.string().describe('Phone number, e.g. +18004633339'),
			country: iso2('country code for national-format numbers').optional(),
		},
		(c, a, request) => c.caller(a.number, { ...request, country: a.country })
	);
	tool(
		'hlr',
		'Phone status at the last check: live means assigned and connected means reachable at that check. Cached results may be returned. Deep adds available roaming and network diagnostics in the same metered lookup, including Free allowance units. Null is unconfirmed.',
		{
			number: z.string().describe('Phone number, e.g. +447712345678'),
			country: iso2('country code for national-format numbers').optional(),
			deep: deep.describe('Include available detail within the same metered core unit. No extra charge or paid-plan gate.'),
		},
		(c, a, request) => c.hlr(a.number, { ...request, deep: a.deep, country: a.country })
	);
	tool(
		'stack',
		'Identify website technologies and available versions by category. Requires a hostname only. CMS, servers, frameworks, ecommerce, analytics, chat, payments and hosting are arrays of technology, name and nullable version. checked_at gives the check time. Scope is homepage or site; pages counts successfully checked HTML pages. Partial is true for homepage-only or incomplete bounded checks, false only when known in-scope candidates finished, never a guarantee every page was visited. When no page could be checked, checked_at and all categories are null, pages is 0 and partial is null. Empty arrays mean no matches. Missing detections do not prove absence. Uses one request from the plan allowance. Successful checks may be reused for up to 24 hours.',
		{ domain: z.string().min(1).max(253).describe('Public website hostname only, e.g. example.com. No scheme, path, port or IP address.'), pretty: z.boolean().optional().describe('Format the JSON response.') },
		(c, a, request) => c.stack(a.domain, { ...request, pretty: a.pretty })
	);

	tool(
		'domain',
		'Check whether a domain is registered. Deep adds registration dates, registrar, status and DNSSEC, included on paid plans. Use dns for DNS records and mx for mail routing.',
		{ domain: z.string().describe('Domain name, e.g. example.com'), deep: deep.describe('Include registration details on a paid plan.') },
		(c, a, request) => c.domain(a.domain, { ...request, deep: a.deep })
	);
	tool('asn', 'Network name and country for an autonomous system number.', { asn: z.string().describe('Autonomous system number, such as AS13335 or 13335') }, (c, a, request) =>
		c.asn(a.asn, request)
	);

	tool('mac', 'Normalize a 48-bit MAC address and return its registered assignment holder, local flag, and multicast flag. Vendor is null for local or multicast addresses.', { mac: z.string().describe('MAC address') }, (c, a, request) =>
		c.mac(a.mac, request)
	);

	tool(
		'dns',
		'Look up published DNS records with TTLs. Pooled on every plan. Omit type to check all ten supported types. The selected question may include its CNAME chain. Values retain DNS presentation syntax, including TXT quoting.',
		{
			domain: z.string().describe('Domain or DNS name, including service names such as _dmarc.example.com'),
			type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'CAA', 'SRV', 'PTR']).optional().describe('DNS question type. Omit to check all supported types.'),
		},
		(c, a, request) => c.dns(a.domain, { ...request, type: a.type })
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
		'vehicle',
		'Identify a vehicle by VIN: year, make, model, trim, body and vehicle type. Paid deep adds specifications, manufacturing detail and model-level recall campaigns. These do not establish whether this VIN needs a repair.',
		{ vin: z.string().describe('The VIN as you have it. Spaces and punctuation fold out'), deep },
		(c, a, request) => c.vehicle(a.vin, { ...request, deep: a.deep })
	);

	tool(
		'vin',
		'Compatibility entry for vehicle. Decode a VIN to year, make, model, trim, body and vehicle type. Paid deep adds specifications, manufacturing detail and model-level recall campaigns.',
		{ vin: z.string().describe('The VIN as you have it. Spaces and punctuation fold out'), deep },
		(c, a, request) => c.vin(a.vin, { ...request, deep: a.deep })
	);
	tool(
		'tariff',
		'Look up a US tariff code, description, lineage, published base general rate, exact edition and answering date. Paid deep adds schedule columns, units and matched Chapter 99 measures. Origin is the country where goods originate, not the shipping country. Optional edition pins immutable source bytes. Optional date requires verified source coverage; edition without date returns date null and no effective rate. Default requests use today. deep.reason explains a null effective_rate, including incomplete_coverage; null never means zero. Matched measures are inspectable candidates, not complete duty or landed cost.',
		{
			code: z.string().describe('US HTS code: 4, 6, 8 or 10 ASCII digits, dots and whitespace optional, e.g. 8471.30.01.00'),
			origin: iso2('country where the goods originate, not the shipping country; only read with deep').optional(),
			edition: tariffEdition,
			date: tariffDate,
			deep,
		},
		(c, a, request) => c.tariff(a.code, { ...request, deep: a.deep, origin: a.origin, edition: a.edition, date: a.date })
	);
	tool(
		'tariff_search',
		'Search US tariff schedule descriptions by product words. Returns up to 20 candidate lines with hts, description, general rate and parent lineage, plus the exact edition and answering date. Optional edition pins immutable source bytes. Optional date requires verified source coverage; combine only when that edition covers the date. Edition without date returns date null. Description search is not product classification.',
		{ query: z.string().describe('Product words, e.g. sunglasses, laptop, coffee'), edition: tariffEdition, date: tariffDate },
		(c, a, request) => c.tariff.search(a.query, { ...request, edition: a.edition, date: a.date })
	);
	tool(
		'industry',
		'Look up a US NAICS 2022 code, title and parent hierarchy. Deep adds definition, children and exclusions on paid plans.',
		{ code: z.string().describe('NAICS code, e.g. 541511 or sector range 31-33'), deep: deep.describe('Include the complete detail bag on a paid plan.') },
		(c, a, request) => c.industry(a.code, { ...request, deep: a.deep })
	);
	tool(
		'industry_search',
		'Search US NAICS 2022 titles and activities. Matching text and corrections stay with the result. Deep adds definition, children and exclusions inside each result on paid plans.',
		{
			query: z.string().min(1).max(100).describe('Industry keywords, e.g. coffee shop'),
			limit: z.number().int().min(1).max(50).optional().describe('Maximum results, 1-50. Default 10.'),
			deep: deep.describe('Include the complete detail bag on a paid plan.'),
		},
		(c, a, request) => c.industry.search(a.query, { ...request, deep: a.deep, limit: a.limit })
	);
	tool(
		'naics',
		'Compatibility name for industry. Look up a US NAICS 2022 code, title and parent hierarchy. Deep adds definition, children and exclusions on paid plans.',
		{ code: z.string().describe('NAICS code, e.g. 541511 or sector range 31-33'), deep: deep.describe('Include the complete detail bag on a paid plan.') },
		(c, a, request) => c.industry(a.code, { ...request, deep: a.deep })
	);
	tool(
		'naics_search',
		'Compatibility name for industry_search. Search US NAICS 2022 titles and activities. Matching text and corrections stay with the result. Deep adds definition, children and exclusions inside each result on paid plans.',
		{
			query: z.string().min(1).max(100).describe('Industry keywords, e.g. coffee shop'),
			limit: z.number().int().min(1).max(50).optional().describe('Maximum results, 1-50. Default 10.'),
			deep: deep.describe('Include the complete detail bag on a paid plan.'),
		},
		(c, a, request) => c.industry.search(a.query, { ...request, deep: a.deep, limit: a.limit })
	);
	tool(
		'currency',
		'Currency name, symbols and decimal places. Deep adds numeric code, plural name and using countries on every plan.',
		{ code: z.string().describe('ISO 4217 code, e.g. USD'), deep: deep.describe('Include optional detail on every plan.') },
		(c, a, request) => c.currency(a.code, { ...request, deep: a.deep })
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
		'Language names, script and writing direction. Deep adds ISO3 and country associations on every plan.',
		{ code: z.string().describe('Language code, e.g. en, ja, gsw'), deep: deep.describe('Include optional detail on every plan.') },
		(c, a, request) => c.language(a.code, { ...request, deep: a.deep })
	);
	tool(
		'name',
		'Parse a name into prefix, first, middle, last and suffix. Paid deep adds gender evidence, salutation, short and directory formats, and initials. Country scopes gender evidence. name_locale selects formatting rules. Junk returns valid false.',
		{
			name: z.string().describe('The name to parse, e.g. Smith, John or BILLY OSHALL'),
			country: z.string().optional().describe('ISO2 country context for gender, e.g. IT'),
			name_locale: z.string().min(2).max(64).optional().describe('Name-formatting locale, e.g. en or ja. Defaults to en. Changes formatting only, not parsing or gender evidence.'),
			deep: deep.describe('Include the complete detail bag on a paid plan.'),
		},
		(c, a, request) => c.name(a.name, { ...request, deep: a.deep, country: a.country, name_locale: a.name_locale })
	);
	tool(
		'time',
		'Current local time, Unix seconds, exact offset and DST. Use an IANA zone, both coordinates, or one explicit IP, city, country, airport, port or address selector. Omit all for UTC. Ambiguous or missing locations return null clock fields with location candidates; never choose a candidate for the user. to or targets converts one instant. Deep adds rule edition, wall-time resolution, standard/seasonal offsets and actual DST-season transitions on every plan.',
		{
			timezone: z.string().min(1).refine(zone => !['zones', 'help'].includes(zone.trim().toLowerCase()), { message: 'Time source must be an IANA timezone ID. Use time_zones to list IDs.' }).optional().describe('IANA timezone, e.g. America/New_York. Omit for UTC when all source selectors are absent'),
			lat: lat.optional(),
			lon: lon.optional(),
			ip: z.string().min(1).max(45).refine(value => Boolean(value.trim()), { message: "Time source must not be empty." }).optional().describe('Explicit IPv4 or IPv6 input. Never use a hosted server IP as the user location.'),
			city: z.string().min(1).max(200).refine(value => Boolean(value.trim()), { message: "Time source must not be empty." }).optional().describe('Exact city name or stable city_ identifier. Country and state can narrow candidates.'),
			country: z.string().regex(/^[A-Za-z]{2}$/).optional().describe('ISO2 country as the source, or context with city/address. Multiple country timezones remain candidates.'),
			state: z.string().min(1).max(6).optional().describe('State context with city/address and country, as a bare code or matching country-prefixed code.'),
			iata: z.string().regex(/^[A-Za-z]{3}$/).optional().describe('Three-letter IATA airport identifier.'),
			icao: z.string().regex(/^[A-Za-z]{4}$/).optional().describe('Four-letter ICAO airport identifier.'),
			unlocode: z.string().regex(/^[A-Za-z]{2} ?[A-Za-z2-9]{3}$/).optional().describe('UN/LOCODE port identifier. Results use the reviewed port reference, not every assigned UN/LOCODE.'),
			address: z.string().min(1).max(200).refine(value => Boolean(value.trim()), { message: "Time source must not be empty." }).optional().describe('Full address with explicit country. Strict point matches are currently supported for US; ambiguity stays unresolved.'),
			at: z.string().min(1).optional().describe('ISO 8601 time, default now. With to or targets, a time without a UTC offset is source wall time. Otherwise it is UTC. Include an offset to disambiguate a repeated local time'),
			disambiguation: z.enum(['compatible', 'earlier', 'later', 'reject']).optional().describe('For offsetless at with to or targets at a clock change. Default compatible chooses the earlier repeated time or advances a skipped time. earlier and later choose the respective instant. For user-entered appointments prefer reject: repeated times return ambiguous_time and skipped times nonexistent_time. Ask for an explicit offset or earlier/later choice. Deep resolution explains a successful choice. Explicit offsets select the instant directly.'),
			targets: z.array(z.string().trim().min(1).max(64).refine(zone => !zone.includes(','), { message: 'Pass one timezone ID per target.' })).min(1).max(10).optional().describe('Destination IANA IDs, preserving order and duplicates. Use instead of to. All targets share one instant. An unresolved or ambiguous source returns targets null.'),
			to: z.string().min(1).optional().describe('Destination IANA timezone, e.g. Asia/Tokyo. Returns to.at and to.unix at the same instant'),
			deep: deep.describe('Include optional detail on every plan.'),
		},
		(c, a, request) => a.lat !== undefined && a.lon !== undefined
			? c.time.at(a.lat, a.lon, { ...request, deep: a.deep, at: a.at, to: a.to, targets: a.targets, disambiguation: a.disambiguation })
			: c.time(a.timezone, { ...request, ip: a.ip, city: a.city, country: a.country, state: a.state, iata: a.iata, icao: a.icao, unlocode: a.unlocode, address: a.address, deep: a.deep, at: a.at, to: a.to, targets: a.targets, disambiguation: a.disambiguation }),
		(schema) => schema.refine(
			(a) => {
				const sources = [a.timezone, a.ip, a.city, a.iata, a.icao, a.unlocode, a.address].filter(value => value !== undefined).length
					+ (a.lat !== undefined ? 1 : 0) + (a.country !== undefined && a.city === undefined && a.address === undefined ? 1 : 0);
				return sources <= 1 && (a.lat === undefined) === (a.lon === undefined)
					&& (a.address === undefined || a.country !== undefined)
					&& (a.state === undefined || (a.country !== undefined && (a.city !== undefined || a.address !== undefined)));
			},
			{ message: 'Pass one Time source. Country/state can narrow city or address; state and address require country.' }
		).refine(a => a.to === undefined || a.targets === undefined, { message: 'Pass to or targets, not both.' })
	);
	tool(
		'time_zones',
		'Search serving IANA timezone identifiers and their pinned rule edition. Filter by country, IANA area, exact offset, abbreviation or DST facts at one instant. Abbreviations return candidate identifiers and never choose a timezone. Empty timezones means no match. Details adds aligned rows and the evaluation instant. One pooled request.',
		{
			query: z.string().trim().max(64).optional().describe('Identifier search, e.g. New York or Europe. Spaces and underscores match the same way.'),
			country: z.string().regex(/^[A-Za-z]{2}$/).optional().describe('ISO2 country association, e.g. US.'),
			area: z.string().min(1).max(64).optional().describe('IANA identifier prefix, e.g. America.'),
			offset: z.string().regex(/^[+-]\d{2}:\d{2}(?::\d{2})?$/).optional().describe('Exact UTC offset at the selected instant, e.g. +05:45 or +00:09:21.'),
			abbreviation: z.string().min(1).max(64).optional().describe('Timezone abbreviation to find candidates for, e.g. CST. Never infer a unique zone from an abbreviation.'),
			dst: z.boolean().optional().describe('Whether the rule DST flag is active at the selected instant. Includes negative seasonal adjustments.'),
			observes_dst: z.boolean().optional().describe('Whether a DST-flagged state occurs during the UTC calendar year containing at.'),
			at: z.string().min(1).optional().describe('ISO instant for all filters and detailed rows. Default now. Offsetless input means UTC.'),
			details: z.boolean().optional().describe('Include zones rows with country associations, area, offset, abbreviation and DST facts, plus the common evaluation instant.'),
			sort: z.enum(['timezone', 'offset']).optional().describe('Order by identifier (default) or actual UTC offset, then identifier.'),
		},
		(c, a, request) => c.time.zones(a.query, { ...request, country: a.country, area: a.area, offset: a.offset, abbreviation: a.abbreviation, dst: a.dst, observes_dst: a.observes_dst, at: a.at, details: a.details, sort: a.sort })
	);
	tool(
		'timezone',
		'Compatibility tool; use time for new integrations. Look up a timezone from an IANA id or from lat and lon. Offset, DST, local time. Pass at for a specific instant. Pass to with another IANA id to convert a time between zones: the response appends at (wall time in the from zone) and to.at (the converted time). Open ocean answers the nautical Etc/GMT zone.',
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
		'Parse a date to ISO date, validity and Unix midnight. Ambiguous numeric dates need format. to adds signed days between; omit date for UTC today. Deep adds calendar details on every plan.',
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
			deep: deep.describe('Include optional detail on every plan.'),
		},
		(c, a, request) => {
			if (a.date == null) return c.date.today({ ...request, deep: a.deep, to: a.to });
			return c.date(a.date, { ...request, deep: a.deep, format: a.format, to: a.to });
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
		'Resolve an emoji character, shortcode or name. Deep adds encoding, keywords and skin variants on every plan.',
		{ emoji: z.string().describe('Emoji name or the character itself, e.g. rocket'), deep: deep.describe('Include optional detail on every plan.') },
		(c, a, request) => c.emoji(a.emoji, { ...request, deep: a.deep })
	);
	tool(
		'emoji_search',
		'Search emoji by keyword. Deep adds encoding and skin-variant detail inside each result on every plan.',
		{
			query: z.string().describe('Search keyword, e.g. fire'),
			limit: z.number().int().min(1).max(50).optional().describe('Max results'),
			deep: deep.describe('Include optional detail on every plan.'),
		},
		(c, a, request) => c.emoji.search(a.query, { ...request, deep: a.deep, limit: a.limit })
	);

	registerDiscovery(server, operations, mode, API_VERSION);
	registerPreflight(server, parse, transport);
	return server;
}
