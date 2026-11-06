import { McpServer } from '@modelcontextprotocol/server';
import { parseAPI, type RequestOptions, type EmojiMetadata } from '@parseapi/sdk';
import * as z from 'zod';
import { noKeyResult, ok, toErrorResult, type ToolResult } from './errors.js';
import { registerDiscovery, type CatalogMode, type CatalogOperation } from './discovery.js';
import { registerPreflight } from './preflight.js';
import { registerTasks } from './task.js';
import { registerBulk } from './bulk.js';

import packageJson from '../package.json' with { type: 'json' };
export const VERSION = packageJson.version;
const API_VERSION = '2.1.0';
const AU_POSTAL_NOTICE = 'Incorporates or developed using G-NAF © Geoscape Australia licensed by the Commonwealth of Australia under the Open Geo-coded National Address File (G-NAF) End User Licence Agreement. Geographic choices are not mailing-address verification. Source, adaptations and licence: https://parseapi.com/legal/attribution#postal-au';

type Client = ReturnType<typeof parseAPI>;
export type Transport = 'stdio' | 'http';

const deep = z
	.boolean()
	.optional()
	.describe('Legacy profile request flag. API 2.1 paid plans include profile detail automatically. Existing access rules and explicit metered operations remain unchanged.');
const lat = z.number().min(-90).max(90).describe('Latitude in decimal degrees');
const lon = z.number().min(-180).max(180).describe('Longitude in decimal degrees');
const iso2 = (what: string) => z.string().describe(`ISO 3166-1 alpha-2 ${what}, e.g. US`);
const countryOpt = z
	.string()
	.optional()
	.describe('ISO2, ISO3, or a country name. Optional when the lookup is unique.');

const titleWords: Record<string, string> = {
	ip: 'IP', asn: 'ASN', id: 'ID', dns: 'DNS', mx: 'MX',
	iban: 'IBAN', naics: 'NAICS',
	us: 'US', ach: 'ACH', url: 'URL', hlr: 'HLR', useragent: 'User Agent',
};

const cityScope = {
	type: z.string().min(1).max(60).optional().describe('Stored place type, such as city or ward; filters eligible places without inferring legal status.'),
	grain: z.enum(['municipality', 'subdivision', 'locality', 'metropolitan_area']).optional().describe('Reviewed entity grain. Unreviewed places do not match; requires City foundation readiness.'),
	hierarchy: z.boolean().optional().describe('Include reviewed grain and immediate parent summary, or null when unknown. Requires foundation readiness; otherwise 503.'),
};
const cityAliases = z.boolean().optional().describe('Match reviewed normalized aliases. Compatibility characters, case and whitespace normalize; native marks and accents remain. No spelling guesses. Requires foundation readiness.');
const cityAmbiguity = z.literal('error').optional().describe('Reject an exact name or nearby anchor matching multiple eligible places with HTTP 409 ambiguous_city and bounded candidate identities. Add filters or choose a stable id from city_search.');
const cityRomanized = z.boolean().optional().describe('Include a reviewed official romanized name and its language. No ASCII-folding fallback; missing or conflicting forms are null.');
const cityResourceResponse = { romanized: cityRomanized };
const cityListResponse = { romanized: cityRomanized };
const citySort = (terms: readonly string[]) => z.string().min(1).max(100).regex(new RegExp(`^[+-]?(${terms.join('|')})(,[+-]?(${terms.join('|')}))*$`)).optional().describe('Comma-separated sort terms. Prefix a term with + or - for its direction. Stable ids break ties; unknown values sort last.');
const cityCodeList = z.union([z.string().min(2).max(149), z.array(z.string().regex(/^[a-zA-Z]{2}$/)).min(1).max(50)]).optional();
const cityCollectionFilters = {
	min_population: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('Minimum stored population. Unknown values do not match; the count may be undated.'),
	max_population: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('Maximum stored population. Unknown values do not match; the count may be undated.'),
	min_elevation: z.number().finite().optional().describe('Minimum stored elevation in meters. Unknown values do not match.'),
	max_elevation: z.number().finite().optional().describe('Maximum stored elevation in meters. Unknown values do not match.'),
	countries: cityCodeList.describe('Include ISO2 countries, as CSV or an array. Intersects with a single country filter; on named nearby, country selects the anchor.'),
	exclude_countries: cityCodeList.describe('Exclude ISO2 countries, as CSV or an array.'),
	timezones: z.union([z.string().min(1).max(5049), z.array(z.string().min(1).max(100)).min(1).max(50)]).optional().describe('Include exact IANA timezones, as CSV or an array.'),
	bbox: z.string().optional().describe('Stored-center bounds as west,south,east,north in degrees. West greater than east crosses the date line.'),
	cursor: z.string().optional().describe('Opaque continuation cursor. Reuse with exactly the same query, filters, limit, display language, Deep, hierarchy and origin.'),
};
const cityPage = z.boolean().optional().describe('Opt into next_cursor on search or named-nearby collections. A cursor also enables paging.');
function cityCollectionArguments(args: { min_population?: number; max_population?: number; min_elevation?: number; max_elevation?: number; countries?: string | string[]; exclude_countries?: string | string[]; timezones?: string | string[]; bbox?: string; sort?: string; page?: boolean; cursor?: string; romanized?: boolean }) {
	return { minPopulation: args.min_population, maxPopulation: args.max_population, minElevation: args.min_elevation, maxElevation: args.max_elevation,
		countries: args.countries, excludeCountries: args.exclude_countries, timezones: args.timezones,
		bbox: args.bbox, sort: args.sort, page: args.page || undefined, cursor: args.cursor, romanized: args.romanized || undefined };
}

const languageTools = new Set(["ip","ip_self","asn","company","continent","continent_countries","country","country_states","state","state_districts","district","city","city_id","city_search","city_nearest","city_nearby","postal","postal_nearby","postal_distance","currency","language","date","time","timezone","emoji","emoji_search","emoji_browse","emoji_parse","emoji_catalog","point","city_list","city_nearby_coordinates","city_children","city_ancestors","city_siblings"]);
const displayLanguage = z.string().min(2).max(64).optional()
	.describe('Optional display language, such as fr or zh-Hant. IDs, numeric values and input parsing stay unchanged.');

const emojiFilters = {
	limit: z.number().int().min(1).max(50).optional().describe('Maximum results per page.'),
	category: z.string().optional().describe('Category from emoji_categories.'),
	subcategory: z.string().optional().describe('Subcategory from emoji_categories.'),
	version: z.string().optional().describe('Exact Emoji release version, such as 17.0.'),
	max_version: z.string().optional().describe('Latest Emoji release to include, such as 16.0.'),
	include_skin_tones: z.boolean().optional().describe('Include skin-tone variants. Explicit false excludes them.'),
	offset: z.number().int().min(0).max(100000).optional().describe('Page offset. Reuse next_offset with the same filters.'),
	deep: deep.describe("Include optional detail when supported; access follows this operation's plan or included-unit rules."),
};


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
				'Lookups for agents: IP and place data, addresses, company numbers, email, phone, domains, weather, timezones, dates and holidays. Real reference data instead of guessing.',
			websiteUrl: 'https://parseapi.com',
		},
		{ capabilities: { tools: {} } }
	);

	const parse = key ? parseAPI(key, {
		// Tool descriptions and responses share this contract on both transports.
		fetch: (input, init) => {
			const headers = new Headers(init?.headers);
			headers.set('X-API-Version', API_VERSION);
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
				title: name.split('_').map(word => titleWords[word] ?? word.charAt(0).toUpperCase() + word.slice(1)).join(' '),
				description,
				inputSchema: schema,
				annotations: { readOnlyHint: true },
			},
			(args, context) => invoke(args, context.mcpReq.signal)
		);
	}

	// Locate
	tool(
		'ip',
		'Look up an IPv4 or IPv6 address: country, continent and origin ASN/operator. Paid plans automatically include supported approximate city/state, state name, postal code, latitude/longitude, timezone, routed network, ASN category and datacenter/relay/Tor/VPN/proxy flags. Unknown location values are null. ASN category is not subscriber connection technology; proxy/VPN false means unlisted.',
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
		'country',
		'Country everyday reference: name, name_full, name_local, demonym, iso_alpha3 and iso_numeric identifiers, continent, region and subregion, currency, languages, calling code, flag, timezones, borders, bloc memberships, capital object (name, latitude, longitude), postal_format guidance and postal_regex syntax checking on every plan. Postal patterns do not establish assignment or deliverability. Paid plans automatically include population, total area and national statistics (gdp_usd, gdp_per_capita_usd, population_growth_percent, urban_population_percent and internet_users_percent), geography including elevation_average in meters, and a tax reference object (name, rate) and locale conventions. Unknown values stay null.',
		{ code: iso2('country code'), deep: deep.describe('Compatibility flag; paid plans include this profile detail automatically.') },
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
		'Look up a state or province by code or name, with its full iso_subdivision identifier. Paid plans include its demographic and tax profile automatically. Pass country to resolve a colliding code.',
		{
			code: z.string().describe('State code or name, e.g. colorado, NC'),
			country: countryOpt,
			deep: deep.describe('Compatibility flag; paid plans include this profile detail automatically.'),
		},
		(c, a, request) => c.state(a.code, { ...request, deep: a.deep, country: a.country })
	);
	tool(
		'state_districts',
		'List the districts, counties or departments of a state. Paid plans include population to each result automatically.',
		{
			code: z.string().describe('State code or name, e.g. NC, colorado'),
			country: countryOpt,
			deep: deep.describe('Include population in each district on a paid plan.'),
		},
		(c, a, request) => c.state.districts(a.code, { ...request, deep: a.deep, country: a.country })
	);
	tool(
		'district',
		'Look up a district, county or department by code or name. Paid plans include area, population and seat automatically. Pass state to resolve a colliding name. Paid deep property_tax contains annual_median, currency and period: median annual tax payable on owner-occupied homes in the area, adjusted to the final year of that period. It is not a rate or property bill. Unsupported, missing and censored estimates are null.',
		{
			code: z.string().describe('District code or name, e.g. 37081, guilford county'),
			country: countryOpt,
			state: z.string().optional().describe('ADM1 code or name to disambiguate, e.g. NC or louisiana'),
			deep: deep.describe('Compatibility flag; paid plans include this profile detail automatically.'),
		},
		(c, a, request) => c.district(a.code, { ...request, deep: a.deep, country: a.country, state: a.state })
	);
	tool(
		'city',
		'Resolve a city name to coordinates, timezone and administrative context. Paid plans include demographic and geographic detail automatically. Pass country or state for name ties.',
		{
			name: z.string().describe('City name, e.g. charlotte'),
			country: countryOpt,
			state: z.string().optional().describe('State code to disambiguate, e.g. NC'),
			...cityScope, ...cityResourceResponse, aliases: cityAliases, ambiguity: cityAmbiguity,
			deep: deep.describe('Compatibility flag; paid plans include this profile detail automatically.'),
		},
		(c, a, request) => c.city(a.name, { ...request, deep: a.deep, country: a.country, state: a.state, type: a.type, grain: a.grain, aliases: a.aliases || undefined, hierarchy: a.hierarchy || undefined, ambiguity: a.ambiguity, romanized: a.romanized || undefined })
	);
	tool(
		'city_id',
		'Resolve a stable city id. Paid plans include the city profile automatically.',
		{ id: z.string().describe('Stable city id, e.g. city_mb8mbqrkz8zb'), ...cityResourceResponse, hierarchy: cityScope.hierarchy, deep: deep.describe('Compatibility flag; paid plans include this profile detail automatically.') },
		(c, a, request) => c.city.id(a.id, { ...request, deep: a.deep, hierarchy: a.hierarchy || undefined, romanized: a.romanized || undefined })
	);
	tool(
		'city_search',
		'Search city names. Explicit match uses the spelling search route; numeric/map/timezone/sort filters apply to default prefix search only. Paid plans include the profile inside each returned city automatically.',
		{
			query: z.string().describe('City name query, e.g. char'),
			match: z.enum(['exact', 'prefix', 'fuzzy']).optional().describe('Explicit matching mode; default prefix. Fuzzy results carry suggestion evidence.'),
			max_distance: z.union([z.literal(1), z.literal(2)]).optional().describe('Maximum edit distance for fuzzy matching.'),
			country: countryOpt,
			state: z.string().optional().describe('State code filter'),
			...cityScope, aliases: cityAliases, ...cityCollectionFilters, ...cityListResponse,
			sort: citySort(['relevance', 'name', 'population', 'country', 'elevation']),
			page: cityPage,
			limit: z.number().int().min(1).max(50).optional().describe('Max results'),
			deep: deep.describe('Compatibility flag; paid plans include this profile detail automatically.'),
		},
		(c, a, request) => c.city.search(a.query, { ...request, deep: a.deep, country: a.country, state: a.state, limit: a.limit, match: a.match, maxDistance: a.max_distance, type: a.type, grain: a.grain, aliases: a.aliases || undefined, hierarchy: a.hierarchy || undefined, ...cityCollectionArguments(a) })
	);
	tool('city_nearest', 'Find the nearest eligible stored city center within 2,000 km, with distance. Country/state/type/grain constrain candidates; this does not determine which municipality contains the point. Paid plans automatically include the profile and reviewed observation date/basis when known.', { lat, lon, country: countryOpt, state: z.string().optional().describe('State code filter'), ...cityScope, ...cityResourceResponse, deep }, (c, a, request) =>
		c.city.nearest(a.lat, a.lon, { ...request, deep: a.deep, country: a.country, state: a.state, type: a.type, grain: a.grain, hierarchy: a.hierarchy || undefined, romanized: a.romanized || undefined })
	);
	tool(
		'city_nearby',
		'Find nearby cities with distances. Paid plans include the profile inside each returned city automatically.',
		{
			name: z.string().describe('Anchor city name, e.g. denver'),
			country: countryOpt,
			state: z.string().optional().describe('State code to disambiguate the anchor'),
			...cityScope, aliases: cityAliases, ambiguity: cityAmbiguity, ...cityCollectionFilters, ...cityListResponse,
			sort: citySort(['distance', 'name', 'population', 'country', 'elevation']),
			page: cityPage,
			radius: z.number().positive().optional().describe('Search radius, default 40 km'),
			unit: z.enum(['km', 'mi']).optional().describe('Radius unit, default km'),
			limit: z.number().int().min(1).max(50).optional().describe('Max results, default 10'),
			deep: deep.describe('Compatibility flag; paid plans include this profile detail automatically.'),
		},
		(c, a, request) =>
			c.city.nearby(a.name, {
				...request, ...cityCollectionArguments(a),
				deep: a.deep,
				country: a.country,
				state: a.state,
				type: a.type, grain: a.grain, aliases: a.aliases || undefined, hierarchy: a.hierarchy || undefined, ambiguity: a.ambiguity,
				radius: a.radius,
				unit: a.unit,
				limit: a.limit,
			})
	);

	tool(
		'city_list',
		'Browse the stored City catalog with filters, stable sorting and opaque cursor paging. Coverage remains curated, not worldwide. Paid plans automatically include the profile detail within each record.',
		{
			country: countryOpt, state: z.string().optional().describe('State code filter'),
			...cityScope, ...cityCollectionFilters, ...cityListResponse,
			sort: citySort(['name', 'population', 'country', 'elevation']),
			limit: z.number().int().min(1).max(50).optional().describe('Max results per page'),
			deep: deep.describe('Compatibility flag; paid plans include this profile detail automatically.'),
		},
		(c, a, request) => c.city.list({ ...request, ...cityCollectionArguments(a), country: a.country, state: a.state, type: a.type, grain: a.grain, hierarchy: a.hierarchy || undefined, limit: a.limit, deep: a.deep })
	);
	tool(
		'city_nearby_coordinates',
		'List stored city centers near arbitrary coordinates, with radius, collection filters and cursor paging. The point and distances do not infer municipality containment. Paid plans automatically include the profile detail within each record.',
		{
			lat, lon, country: countryOpt, state: z.string().optional().describe('State code filter for returned neighbors'),
			...cityScope, ...cityCollectionFilters, ...cityListResponse,
			radius: z.number().positive().optional().describe('Search radius, default 40 km'),
			unit: z.enum(['km', 'mi']).optional().describe('Radius unit, default km'),
			sort: citySort(['distance', 'name', 'population', 'country', 'elevation']),
			limit: z.number().int().min(1).max(50).optional().describe('Max results per page'),
			deep: deep.describe('Compatibility flag; paid plans include this profile detail automatically.'),
		},
		(c, a, request) => c.city.nearbyCoordinates(a.lat, a.lon, { ...request, ...cityCollectionArguments(a), country: a.country, state: a.state, type: a.type, grain: a.grain, hierarchy: a.hierarchy || undefined, radius: a.radius, unit: a.unit, limit: a.limit, deep: a.deep })
	);

	const cityRelationId = z.string().regex(/^city_[23456789abcdefghjkmnpqrstuvwxyz]{12}$/).describe('Stable City id selected from a lookup or search.');
	const cityRelationOptions = { id: cityRelationId, romanized: cityRomanized, hierarchy: cityScope.hierarchy, deep,
		limit: z.number().int().min(1).max(50).optional().describe('Maximum records per page.'),
		cursor: cityCollectionFilters.cursor };
	tool('city_children', 'List reviewed immediate children of a City id. Returns a canonical list with coverage:partial. It does not infer missing relationships.', cityRelationOptions, (c, a, request) => c.city.children(a.id, { ...request, romanized: a.romanized || undefined, limit: a.limit, cursor: a.cursor, hierarchy: a.hierarchy || undefined, deep: a.deep }));
	tool('city_ancestors', 'Follow reviewed parents of a City id, immediate parent first. Returns a canonical list with coverage:partial; an empty list does not prove the city has no administrative parent.', { id: cityRelationId, romanized: cityRomanized, hierarchy: cityScope.hierarchy, deep }, (c, a, request) => c.city.ancestors(a.id, { ...request, romanized: a.romanized || undefined, hierarchy: a.hierarchy || undefined, deep: a.deep }));
	tool('city_siblings', 'List reviewed places sharing the selected City id’s immediate parent. Returns a canonical list with parent_id and coverage:partial.', cityRelationOptions, (c, a, request) => c.city.siblings(a.id, { ...request, romanized: a.romanized || undefined, limit: a.limit, cursor: a.cursor, hierarchy: a.hierarchy || undefined, deep: a.deep }));
	tool('city_distance', 'Great-circle kilometers and miles between two stored City centers. Unknown coordinates return null; this is not travel distance or boundary containment.', { from: cityRelationId, to: cityRelationId }, (c, a, request) => c.city.distance(a.from, a.to, request));


	tool(
		'postal',
		'Resolve a postal code to its place, coordinates and timezone. Australian core localities lists suburb choices with city, state and state_name. Null or missing means unknown, and [] means no eligible choices in the reviewed reference. A single choice can coexist with city null, so do not infer a city or a user selection. These are geographic choices, not mailing-address verification. Paid plans include area, elevation, population, currency, grouped tax references, neighbors and metro associations automatically. property_tax is a nullable area statistic with annual_median in the response currency: median annual tax payable on owner-occupied homes. It is not a rate or property bill. Unsupported, missing and censored estimates are null. Tax rates are percentages and alternative geographic references, not additive.',
		{
			code: z.string().describe('Postal or ZIP code, e.g. SW1A 1AA, 28202'),
			country: countryOpt,
			deep: deep.describe('Compatibility flag; paid plans include this profile detail automatically.'),
		},
		(c, a, request) => c.postal(a.code, { ...request, deep: a.deep, country: a.country })
	);
	tool(
		'postal_nearby',
		'Find nearby postal codes with distances. Paid plans include metropolitan associations to the origin and each result automatically.',
		{
			code: z.string().describe('Postal code to search around'),
			country: countryOpt,
			radius: z.number().positive().optional().describe('Search radius'),
			unit: z.enum(['km', 'mi']).optional().describe('Radius unit, default km'),
			deep: deep.describe('Compatibility flag; paid plans include this profile detail automatically.'),
		},
		(c, a, request) => c.postal.nearby(a.code, { ...request, deep: a.deep, country: a.country, radius: a.radius, unit: a.unit })
	);
	tool(
		'postal_distance',
		'Distance between two postal codes. Paid plans include metropolitan associations inside each endpoint automatically.',
		{
			from: z.string().describe('First postal code'),
			to: z.string().describe('Second postal code'),
			country: countryOpt,
			deep: deep.describe('Compatibility flag; paid plans include this profile detail automatically.'),
		},
		(c, a, request) => c.postal.distance(a.from, a.to, { ...request, deep: a.deep, country: a.country })
	);
	tool(
		'address',
		'Look up a US or French street address: house number, street, unit, city, state, postal code and registration status. Registration does not establish deliverability or verify an apartment. On supported US results, optional Deep includes electoral code, name and Congress number on paid plans; existing accounts retain their current Deep access.',
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
		'Look up a company directory profile by its stable co_ ID. Paid plans automatically include available legal details, identifiers, industry, business description, logo, other domains, social profiles, public business contacts, founding precision and reported employees. Employee counts retain their measurement date, organization scope and measurement basis. Reported counts may be rounded. Unavailable details are omitted; source evidence stays internal. A website claim is not legal ownership proof. National registration numbers use company.',
		{ id: z.string().min(1).describe('Stable company directory ID returned by company_search'), deep },
		(c, a, request) => c.company.id(a.id, { ...request, deep: a.deep })
	);
	tool(
		'company_search',
		'Find company directory candidates using at most one of query, domain, ticker or identifier, or discover by country, an exact industry pair. Returns companies and an opaque next cursor without choosing a match. Deep belongs to each result. Keep the same selector, filters and limit when sending cursor. Empty listings do not establish private ownership.',
		{
			query: z.string().min(1).optional().describe('Company name search, sent as q'),
			domain: z.string().min(1).optional().describe('Company website domain or URL'),
			ticker: z.string().min(1).optional().describe('Security ticker, optionally scoped by exchange'),
			identifier: z.string().min(1).optional().describe('Business identifier, preserving leading zeros'),
			country: z.string().regex(/^[A-Za-z]{2}$/).optional().describe('ISO2 profile-country filter; does not mean headquarters or operating presence'),
			industry: z.string().regex(/^[0-9]{4}$/).optional().describe('Exact four-digit SIC code string, preserving leading zeros; requires industry_type'),
			industry_type: z.literal('sic').optional().describe('Industry namespace; currently sic; requires industry'),
			exchange: z.string().optional().describe('Exchange filter for ticker searches'),
			authority: z.string().optional().describe('Issuing authority filter for identifier searches'),
			limit: z.number().int().min(1).max(50).optional().describe('Maximum candidates on this page, from 1 to 50'),
			cursor: z.string().optional().describe('Opaque next cursor returned by the same search'),
			deep,
		},
		(c, a, request) => c.company.search({ ...request, query: a.query, domain: a.domain, ticker: a.ticker, identifier: a.identifier, country: a.country, industry: a.industry, industry_type: a.industry_type, exchange: a.exchange, authority: a.authority, limit: a.limit, cursor: a.cursor, deep: a.deep }),
		(schema) => schema
			.refine(args => (args.industry === undefined) === (args.industry_type === undefined), { message: 'Supply industry and industry_type together.' })
			.refine(args => {
				const selectors = [args.query, args.domain, args.ticker, args.identifier].filter(value => value !== undefined).length;
				return selectors <= 1 && (selectors === 1 || args.country !== undefined || (args.industry !== undefined && args.industry_type !== undefined));
			}, { message: 'Use at most one selector, or supply country, a complete industry pair.' })
	);

	tool(
		'point',
		'Locate coordinates in their country, state, district and actual IANA timezone. Paid plans automatically include terrain and a compact nearest-city summary with its ID and distance; existing accounts retain their current Deep access. The timezone ID stays in core. Nearest city is null when none is within 200 km.',
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
		'Current weather with observation time and station distance. Paid deep adds specialist current measurements, forecast, alerts, hourly and daily outlook, air quality and optional history. Minute precipitation_rate (mm/h) and precipitation_rate_in (in/h) are rates; history.precipitation and precipitation_in are daily totals. Metric and imperial pairs stay together. A date requires paid deep and adds the past UTC day in history alongside current conditions.',
		{
			lat,
			lon,
			deep,
			date: z
				.string()
				.optional()
				.describe('A past UTC day, YYYY-MM-DD. Requires paid deep. Adds history alongside current conditions.'),
		},
		(c, a, request) => c.weather(a.lat, a.lon, { ...request, deep: a.deep, date: a.date })
	);

	tool('email_verify', 'Run an explicit metered mailbox check. Returns the complete result, including nullable deliverable, catchall, status and reason. No automatic retries by default. App keys are not allowed. A suggested first name is not verified identity.', { email: z.string().describe('Email address to verify') }, (c, a, request) => c.email.verify(a.email, request));

	// Validate
	tool(
		'email',
		'Validate an email address: syntax, domain, mail routing, consumer mailbox, disposable, role, reserved domain type and typo suggestion. Use email_verify for a metered mailbox check and the complete result. The basic email tool does not establish deliverability.',
		{ email: z.string().describe('Email address to validate'), deep: deep.describe('Deprecated compatibility input. true runs email_verify, a metered check. Use email_verify explicitly.') },
		(c, a, request) => c.email(a.email, { ...request, deep: a.deep })
	);

	tool(
		'card',
		'Identify a network and its CDN SVG logo from 2-11 leading digits, including processor-provided BIN/IIN prefixes. Unknown or ambiguous networks return null brand and a generic logo. Optional Deep on paid plans adds the longest recorded prefix, issuer, country, funding type and nullable prepaid status; existing accounts retain their current Deep access. Core identity is independent of issuer coverage. A shorter prefix is broader coverage; missing fields never inherit from a parent row. Partial reference data does not prove card validity, account existence or payment acceptance. Core uses one pooled request on every plan. Optional Deep follows paid-plan or retained-access rules in that same request.',
		{
			bin: z.string().max(64, 'Send a prefix only: 2-11 digits.')
				.regex(/^[ \t\r\n-]*(?:[0-9][ \t\r\n-]*){2,11}$/, 'Send a prefix only: 2-11 digits.')
				.describe('Processor-provided leading digits as a string, 2-11 ASCII digits. Preserve zeros. Only ASCII space, tab, CR, LF and hyphen separators; at most 64 raw characters. Never send a full card number. Six or more digits enable issuer lookup.'),
			deep: deep.describe('Include recorded issuer details on paid plans in the same pooled request; existing accounts retain their current Deep access. Omitted by default; locked optional fields are absent. With access, fewer than six digits returns all-null Deep fields.'),
		},
		(c, a, request) => c.card(a.bin, { ...request, deep: a.deep })
	);
	tool(
		'phone',
		'Parse and validate a phone number with national and international display formats. Paid plans automatically include numbering-plan state and timezone; existing accounts retain their current Deep access. These do not locate a handset.',
		{
			number: z.string().describe('Phone number, e.g. +14155552671'),
			country: iso2('country code for national-format numbers').optional(),
			deep,
		},
		(c, a, request) => c.phone(a.number, { ...request, country: a.country, deep: a.deep })
	);
	tool(
		'carrier',
		'Look up current carrier, line type and burner flag. Type uses the provider observation when mapped; otherwise it retains the numbering-plan type. The complete result includes issuing city and state when known, within the same metered lookup, including Free allowance units.',
		{
			number: z.string().describe('Phone number, e.g. +14155552671'),
			country: iso2('country code for national-format numbers').optional(),
			deep: deep.describe('Deprecated compatibility input. The complete metered result is always returned.'),
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
		'Phone status at the last check: live means assigned and connected means reachable at that check. Cached results may be returned. Available roaming and network diagnostics are included in the complete metered result, including Free allowance units. Null is unconfirmed.',
		{
			number: z.string().describe('Phone number, e.g. +447712345678'),
			country: iso2('country code for national-format numbers').optional(),
			deep: deep.describe('Deprecated compatibility input. The complete metered result is always returned.'),
		},
		(c, a, request) => c.hlr(a.number, { ...request, deep: a.deep, country: a.country })
	);
	tool(
		'stack',
		'Identify website technologies and available versions by category. Requires a hostname only. CMS, servers, frameworks, ecommerce, analytics, chat, payments and hosting are arrays of technology, name and nullable version. checked_at gives the check time. The check covers static homepage HTML and response headers. When no page could be checked, checked_at and all categories are null. Empty arrays mean no matches. Detections describe the checked homepage. Uses one request from the plan allowance. Successful checks may be reused for up to 24 hours.',
		{ domain: z.string().min(1).max(253).describe('Public website hostname only, e.g. example.com. No scheme, path, port or IP address.'), pretty: z.boolean().optional().describe('Format the JSON response.') },
		(c, a, request) => c.stack(a.domain, { ...request, pretty: a.pretty })
	);

	tool(
		'domain',
		'Check whether a domain is registered: available is true for unregistered, false for registered, and null when unknown. Paid plans include available registration dates, registrar, status and DNSSEC automatically. Missing or null DNSSEC is unknown, while false means unsigned. Use dns for DNS records and mx for mail routing.',
		{ domain: z.string().describe('Domain name, e.g. example.com'), deep: deep.describe('Include registration details on a paid plan.') },
		(c, a, request) => c.domain(a.domain, { ...request, deep: a.deep })
	);
	tool('asn', 'Network name and country for an autonomous system number.', { asn: z.string().describe('Autonomous system number, such as AS13335 or 13335') }, (c, a, request) =>
		c.asn(a.asn, request)
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
	tool(
		'industry',
		'Look up a US NAICS 2022 code, title and parent hierarchy. Paid plans include definition, children and exclusions automatically.',
		{ code: z.string().describe('NAICS code, e.g. 541511 or sector range 31-33'), deep: deep.describe('Compatibility flag; paid plans include this profile detail automatically.') },
		(c, a, request) => c.industry(a.code, { ...request, deep: a.deep })
	);
	tool(
		'industry_search',
		'Search US NAICS 2022 titles and activities. Matching text and corrections stay with the result. Paid plans include definition, children and exclusions inside each result automatically.',
		{
			query: z.string().min(1).max(100).describe('Industry keywords, e.g. coffee shop'),
			limit: z.number().int().min(1).max(50).optional().describe('Maximum results, 1-50. Default 10.'),
			deep: deep.describe('Compatibility flag; paid plans include this profile detail automatically.'),
		},
		(c, a, request) => c.industry.search(a.query, { ...request, deep: a.deep, limit: a.limit })
	);
	tool(
		'naics',
		'Compatibility name for industry. Look up a US NAICS 2022 code, title and parent hierarchy. Paid plans include definition, children and exclusions automatically.',
		{ code: z.string().describe('NAICS code, e.g. 541511 or sector range 31-33'), deep: deep.describe('Compatibility flag; paid plans include this profile detail automatically.') },
		(c, a, request) => c.industry(a.code, { ...request, deep: a.deep })
	);
	tool(
		'naics_search',
		'Compatibility name for industry_search. Search US NAICS 2022 titles and activities. Matching text and corrections stay with the result. Paid plans include definition, children and exclusions inside each result automatically.',
		{
			query: z.string().min(1).max(100).describe('Industry keywords, e.g. coffee shop'),
			limit: z.number().int().min(1).max(50).optional().describe('Maximum results, 1-50. Default 10.'),
			deep: deep.describe('Compatibility flag; paid plans include this profile detail automatically.'),
		},
		(c, a, request) => c.industry.search(a.query, { ...request, deep: a.deep, limit: a.limit })
	);
	tool(
		'language',
		'Language names, script, writing direction, iso_alpha3 identifier and country associations.',
		{ code: z.string().describe('Language code, e.g. en, ja, gsw'), deep: deep.describe('All language facts are in Core. This option does not add fields.') },
		(c, a, request) => c.language(a.code, { ...request, deep: a.deep })
	);
	tool(
		'name',
		'Parse a name into prefix, first, middle, last and suffix. Paid deep adds gender evidence, salutation, short and directory formats, and initials. Country scopes gender evidence. name_locale selects formatting rules. Junk returns valid false.',
		{
			name: z.string().describe('The name to parse, e.g. Smith, John or BILLY OSHALL'),
			country: z.string().optional().describe('ISO2 country context for gender, e.g. IT'),
			name_locale: z.string().min(2).max(64).optional().describe('Name-formatting locale, e.g. en or ja. Defaults to en. Changes formatting only, not parsing or gender evidence.'),
			deep: deep.describe('Compatibility flag; paid plans include this profile detail automatically.'),
		},
		(c, a, request) => c.name(a.name, { ...request, deep: a.deep, country: a.country, name_locale: a.name_locale })
	);
	tool(
		'time',
		'Current local time, Unix seconds, exact offset and DST. Use an IANA zone, both coordinates, or one explicit IP, city, country, airport, port or address selector. Omit all for UTC. Resolved place lookups include a compact location with the matched identity and coordinates. Ambiguous or missing locations return null clock fields with location candidates; never choose a candidate for the user. to or targets converts one instant. Paid plans automatically include actual wall-time resolution, standard/seasonal offsets and DST-season transitions; existing accounts retain their current Deep access.',
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
			deep: deep.describe('Compatibility flag; paid plans include profile detail automatically. Existing accounts retain their access; unavailable fields are absent.'),
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
		'Search serving IANA timezone identifiers. Filter by country, IANA area, exact offset, abbreviation or DST facts at one instant. Abbreviations return candidate identifiers and never choose a timezone. Empty timezones means no match. Details adds aligned rows and the evaluation instant. One pooled request.',
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
		'Parse a date to ISO date, validity and Unix midnight. Ambiguous numeric dates need format. to adds signed days between; omit date for UTC today. Paid plans automatically include calendar details; existing accounts retain their current Deep access.',
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
			deep: deep.describe('Compatibility flag; paid plans include profile detail automatically. Existing accounts retain their access; unavailable fields are absent.'),
		},
		(c, a, request) => {
			if (a.date == null) return c.date.today({ ...request, deep: a.deep, to: a.to });
			return c.date(a.date, { ...request, format: a.format, deep: a.deep, to: a.to });
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
		'Resolve an emoji character, shortcode, name or codepoint sequence. Paid plans automatically include encoding, keywords, tone relationships and artwork; existing accounts retain their current Deep access. Artwork is keyed by style: artwork.openmoji.svg and artwork.openmoji.png["72"].',
		{ emoji: z.string().describe('Emoji input, e.g. rocket, :rocket:, 🚀 or U+1F680'), shortcode_source: z.enum(['cldr', 'github', 'slack', 'discord']).optional().describe('Resolve the shortcode within this source.'), deep: deep.describe('Compatibility flag; paid plans include profile detail automatically. Existing accounts retain their access; unavailable fields are absent.') },
		(c, a, request) => c.emoji(a.emoji, { ...request, deep: a.deep, shortcodeSource: a.shortcode_source })
	);
	tool(
		'emoji_search',
		'Search emoji by keyword with optional catalog filters. Explicit offset or filters return total and next_offset. Deep belongs to each result.',
		{
			query: z.string().describe('Search keyword, e.g. fire'),
			...emojiFilters,
		},
		(c, a, request) => c.emoji.search(a.query, { ...request, ...a, maxVersion: a.max_version, includeSkinTones: a.include_skin_tones })
	);
	tool(
		'emoji_browse',
		'Browse the emoji catalog by category, subcategory or Emoji release. Returns total and next_offset for pagination; omit a search query.',
		emojiFilters,
		(c, a, request) => c.emoji.browse({ ...request, ...a, maxVersion: a.max_version, includeSkinTones: a.include_skin_tones })
	);
	tool(
		'emoji_catalog',
		'Get the JSON catalog download URL. Download it with your API key; the catalog carries inventory and required notices. This tool makes no API request.',
		{ category: emojiFilters.category, subcategory: emojiFilters.subcategory, version: emojiFilters.version, max_version: emojiFilters.max_version, include_skin_tones: emojiFilters.include_skin_tones,
		},
		async (c, a, request) => {
			const url = new URL('https://api.parseapi.com/emoji/catalog');
			for (const [key,value] of Object.entries({ category: a.category, subcategory: a.subcategory, version: a.version, max_version: a.max_version, include_skin_tones: a.include_skin_tones, lang: (request as RequestOptions & {lang?:string}).lang })) if (value !== undefined) url.searchParams.set(key,String(value));
			return { download_url: url.href };
		}
	);
	tool(
		'emoji_categories',
		'List emoji categories and their subcategories for search and browsing filters.',
		{},
		(c, _a, request) => c.emoji.categories(request)
	);
	tool(
		'emoji_parse',
		'Extract complete Unicode emoji sequences from text. Results group repeated emoji in first-occurrence order, and positions use UTF-16 code units with an exclusive end. Text is sent in the POST body.',
		{ text: z.string().max(16000).describe('Text to inspect for native Unicode emoji, up to 16000 UTF-16 code units.'), deep: deep.describe('Compatibility flag; paid plans include reference detail inside each result automatically.') },
		(c, a, request) => c.emoji.parse(a.text, { ...request, deep: a.deep })
	);
	tool('emoji_convert', 'Convert Unicode emoji to a named shortcode preset or decode that preset. Unknown, unavailable and ambiguous inputs remain literal with reasons and original UTF-16 offsets. Text is sent in the POST body.',
		{text:z.string().max(16000),direction:z.enum(['to_shortcodes','to_emoji']),shortcode_source:z.enum(['cldr','github','slack','discord'])},
		(c,a,request)=>c.emoji.convert(a.text,{...request,direction:a.direction,shortcodeSource:a.shortcode_source}));

tool(
		'currency',
		'Currency name, symbols, decimal places and iso_numeric identifier. Paid plans include plural name and using countries automatically.',
		{ code: z.string().describe('ISO 4217 code, e.g. USD'), deep: deep.describe('Compatibility option; Currency already includes its complete reference on every plan.') },
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
	registerDiscovery(server, operations, mode, API_VERSION);
	registerPreflight(server, parse, transport);
	registerTasks(server, parse, transport);
	registerBulk(server, key, transport);
	return server;
}
