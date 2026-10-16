# Changelog

## 1.10.0 — 2026-10-15

- Add City spelling search, reviewed hierarchy and relationships, coordinate-nearby lists and city distance tools.
- Keep existing tool names and default City responses; add geographic filters and predictable continuation.
- Use @parseapi/sdk 1.11.0; retain private source data and exclude deferred coverage/change-feed tools.

## 1.9.5

- Align tool descriptions and discovery with the cleaned API responses while retaining useful facts and required notices. Existing calls and request options stay unchanged.

## 1.9.2 — 2026-10-12

- Correct the reported MCP server version and read it from the package manifest to prevent drift. Emoji tools and SDK dependency remain unchanged.

## 1.9.1 — 2026-10-12

- Add Emoji search/browse, categories, catalog, metadata, parsing and conversion; keep existing lookup calls and response decoding compatible.
- Support optional SVG/PNG artwork and translated names. Preserve API 2.0.0 selection, plans and existing non-Emoji behavior.
- Add the matching Emoji tools using JavaScript SDK 1.10.1; retain existing tools and hosted authentication.

## 1.8.0 — 2026-09-29

- Add Company stable-ID lookup, candidate search and coverage for the current public-company cohort.
- Preserve existing Company calls and all published compatibility methods.
- Add optional Tariff edition and date selectors.

## 1.7.1 — 2026-09-27

- Add readable tool titles in MCP clients. Tool names, arguments, results, authentication and billing behavior are unchanged.
- Add maintainer metadata for the source repository.

## 1.7.0 — 2026-09-25

- Add Bank diagnostics, POST requests, requirements and explicit US ACH helpers; Card Core and optional Deep; Provider; Industry; and Vehicle.
- Preserve published IBAN, BIN, NPI, NAICS and VIN methods and response types alongside the new names.
- Respect long Retry-After responses without retrying early and expose the raw header as optional error metadata.
- Retain released Time, Tariff, Postal and Elevation behavior. Expanded Company directory changes are deferred.

## 1.6.0 - 2026-09-24

Adds Time location inputs and explicit ambiguity candidates, filtered timezone discovery, multiple conversion targets, wall-time disambiguation, and standard/seasonal offset detail. Existing Timezone methods and API 2.0.0 selection remain unchanged.

## 1.5.0 - 2026-09-24

Adds Elevation point lists and evenly spaced paths with strict exclusive selectors across full and compact catalogs. Uses JavaScript SDK 1.5.0 or later; API contract remains 2.0.0.

## 1.4.0 - 2026-09-24

Adds Australian Postal suburb choices while preserving null, empty, and ambiguous results. Existing calls, compact nearby/distance responses, and API contract `2.0.0` remain unchanged.

Includes the G-NAF source notice for Australian Postal results and uses JavaScript SDK 1.4.0 or later.

## 1.3.0 - Unreleased

Adds the Stack site inventory tool with eight technology category arrays and explicit page coverage. Uses JavaScript SDK 1.3.0 or later. Existing tools and API contract `2.0.0` remain unchanged.

## 1.2.0 - 2026-09-20

Email deep results now include nullable suggested first name, no-reply flag, plus-address tag, mail provider, verification status and reason. Existing lookup calls, retry defaults and API contract `2.0.0` remain unchanged. Missing details remain unknown, and suggested names do not verify identity.

Agent discovery and task preflight from 1.1.0 remain available.
