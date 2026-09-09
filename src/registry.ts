import { McpServer } from '@modelcontextprotocol/server';
import { parseAPI, type RequestOptions } from '@parseapi/sdk';
import * as z from 'zod';
import { noKeyResult, ok, toErrorResult, type ToolResult } from './errors.js';

export const VERSION = '0.3.2';

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
 * One server, every ParseAPI lookup as a tool. `key` null serves the funnel:
 * tools list fine, calls return invalid_api_key pointing at signup.
 */
export function buildServer(key: string | null, transport: Transport): McpServer {
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
					// Keep the required notice with each copied BIC result. A per-call client
					// prevents concurrent tools from mixing attribution from different editions.
					let attribution: string | null = null;
					const client = name === 'swift' ? parseAPI(key!, {
						fetch: async (input, init) => {
							const response = await fetch(input, init);
							if (response.ok) {
								attribution = response.headers.get('x-attribution');
								const prefix = "notice*=UTF-8''";
								if (attribution?.startsWith(prefix)) {
									try { attribution = decodeURIComponent(attribution.slice(prefix.length)); }
									catch { /* Preserve an unexpected upstream notice verbatim. */ }
								}
							}
							return response;
						},
					}) : parse;
					const result = ok(await fn(client, args as z.infer<z.ZodObject<S>>, { signal: context.mcpReq.signal }));
					if (attribution) result.content.push({ type: 'text', text: attribution });
					return result;
				} catch (err) {
					return toErrorResult(err);
				}
			}
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
		'Look up a continent by code: name, area, population and population_period. The period is a reporting year or range, null when unknown or unverifiable.',
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
		'Country names, language codes, currency, calling code and timezones. Deep adds the country reference profile, including population with its reporting period, tax and locale conventions, on paid plans.',
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
		'Resolve a postal code to its place, coordinates and timezone. Deep adds area, population with its reporting period, tax references, neighbors and metro associations on paid plans. property_tax is a nullable area statistic with annual_median, currency and period: median annual tax payable on owner-occupied homes, adjusted to the final year of the period. It is not a rate or property bill. Unsupported, missing and censored estimates are null. Tax rates are percentages and alternative geographic references, not additive.',
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
		'point',
		'Locate coordinates in their country, state, district and actual IANA timezone. Deep adds terrain and a compact nearest-city summary on every plan. The timezone ID stays in core. Nearest city is null when none is within 200 km.',
		{ lat, lon, deep },
		(c, a, request) => c.point(a.lat, a.lon, { ...request, deep: a.deep })
	);
	tool('elevation', 'Elevation in meters at coordinates.', { lat, lon }, (c, a, request) =>
		c.elevation(a.lat, a.lon, request)
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
		'Parse an IBAN and check its format and checksum, with known bank identifiers. Deep adds check digits, branch and account decomposition on every plan. Does not verify an account exists.',
		{
			iban: z.string().describe('IBAN, with or without spaces, with or without the country prefix'),
			country: iso2('country code when the number has no prefix').optional(),
			deep: deep.describe('Include optional detail on every plan.'),
		},
		(c, a, request) => c.iban(a.iban, { ...request, deep: a.deep, country: a.country })
	);
	tool(
		'bin',
		'Look up a 6-11 digit payment-card prefix. Returns the actual longest matched prefix, issuer, country, brand, card type and prepaid status where known. Unknown fields are null. Does not confirm a card or account exists. Pooled request on every plan.',
		{
			bin: z.string().describe('Card prefix as a string, 6-11 digits. Preserve leading zeros. Spaces and hyphens are accepted.'),
			deep: z.boolean().optional().describe('Include an empty deep object. No extra fields or separate charge.'),
		},
		(c, a, request) => c.bin(a.bin, { ...request, deep: a.deep })
	);
	tool(
		'swift',
		'Check an 8- or 11-character SWIFT/BIC code and look up its institution name when known. Valid means syntax only. A null name means unknown or ambiguous in the available coverage, not an invalid code. Country is read from the code. This does not confirm payment reachability or account existence. Pooled request.',
		{ code: z.string().min(1).max(128).describe('SWIFT/BIC code, e.g. BOFAUS3N or BOFAUS3NXXX') },
		(c, a, request) => c.swift(a.code, request)
	);
	tool(
		'npi',
		'Validate an NPI and identify the registered provider, active/exclusion status, specialty and practice contact. Paid deep adds deactivation date and Medicare enrollment evidence.',
		{
			npi: z.string().describe('10-digit NPI number'),
			deep,
		},
		(c, a, request) => c.npi(a.npi, { ...request, deep: a.deep })
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
		'Look up the caller ID name (CNAM) for a US or Canada phone number. caller is the record verbatim, null when no record or outside NANP. Metered per lookup on a NANP number.',
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
		'vin',
		'Decode a VIN to year, make, model, trim, body and vehicle type. Paid deep adds specifications, manufacturing detail and recalls.',
		{ vin: z.string().describe('The VIN as you have it. Spaces and punctuation fold out'), deep },
		(c, a, request) => c.vin(a.vin, { ...request, deep: a.deep })
	);
	tool(
		'tariff',
		'Look up a tariff code, description, lineage and general rate. Paid deep adds statistical units and the special and other schedule columns. Optional origin with deep resolves country-specific measures. Without origin, schedule detail is available and origin-dependent fields are null. A null effective rate is not a zero rate.',
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
		'naics',
		'Look up a US NAICS 2022 code, title and parent hierarchy. Deep adds definition, children and exclusions on paid plans.',
		{ code: z.string().describe('NAICS code, e.g. 541511 or sector range 31-33'), deep: deep.describe('Include the complete detail bag on a paid plan.') },
		(c, a, request) => c.naics(a.code, { ...request, deep: a.deep })
	);
	tool(
		'naics_search',
		'Search US NAICS 2022 titles and activities. Matching text and corrections stay with the result. Deep adds definition, children and exclusions inside each result on paid plans.',
		{
			query: z.string().min(1).max(100).describe('Industry keywords, e.g. coffee shop'),
			limit: z.number().int().min(1).max(50).optional().describe('Maximum results, 1-50. Default 10.'),
			deep: deep.describe('Include the complete detail bag on a paid plan.'),
		},
		(c, a, request) => c.naics.search(a.query, { ...request, deep: a.deep, limit: a.limit })
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
		'Parse a name into prefix, first, middle, last and suffix. Paid deep adds dictionary membership, gender evidence, salutation and country associations. Country scopes evidence, never nationality. Junk returns valid false.',
		{
			name: z.string().describe('The name to parse, e.g. Smith, John or BILLY OSHALL'),
			country: z.string().optional().describe('ISO2 country context for gender, e.g. IT'),
			deep: deep.describe('Include the complete detail bag on a paid plan.'),
		},
		(c, a, request) => c.name(a.name, { ...request, deep: a.deep, country: a.country })
	);
	tool(
		'time',
		'Current local time, Unix seconds, exact UTC offset and DST. Omit timezone for UTC or pass both coordinates. at selects the moment; to converts it. Deep adds friendly name, numeric offsets and the next source clock transition on every plan.',
		{
			timezone: z.string().min(1).optional().describe('IANA timezone, e.g. America/New_York. Omit for UTC when coordinates are absent'),
			lat: lat.optional(),
			lon: lon.optional(),
			at: z.string().min(1).optional().describe('ISO 8601 time, default now. With to, a time without a UTC offset is source wall time. Otherwise it is UTC. Include an offset to disambiguate a repeated local time'),
			to: z.string().min(1).optional().describe('Destination IANA timezone, e.g. Asia/Tokyo. Returns to.at and to.unix at the same instant'),
			deep: deep.describe('Include optional detail on every plan.'),
		},
		(c, a, request) => a.lat !== undefined && a.lon !== undefined
			? c.time.at(a.lat, a.lon, { ...request, deep: a.deep, at: a.at, to: a.to })
			: c.time(a.timezone, { ...request, deep: a.deep, at: a.at, to: a.to }),
		(schema) => schema.refine(
			(a) => a.timezone !== undefined
				? a.lat === undefined && a.lon === undefined
				: (a.lat === undefined) === (a.lon === undefined),
			{ message: 'Pass a timezone, both lat and lon, or neither for UTC.' }
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

	return server;
}
