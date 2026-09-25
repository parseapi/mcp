# Changelog

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
