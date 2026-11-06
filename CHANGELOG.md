# Changelog

## 0.4.2 — 2026-11-06

### Added

- Album and EP ownership checks on Bandcamp Discover, including genre-filtered pages.
- Collection status, ownership filters, and individual ownership checks on Discover cards, with updates as results load or change.
- Regression tests for dynamic Discover results and capped discography prices.
- Oxlint checks with tailored anti-slop rules for development and CI.

### Fixed

- Digital discography offers now respect Bandcamp's maximum purchase price. This fixes the Seikomart bundle appearing as JPY 183,906 instead of JPY 140,000.

## 0.4.1 — 2026-10-14

### Changed

- Display the native “You own this” indicator prominently beneath album and track titles while preserving its purchase-state behavior and links.

## Earlier changes

- Optimized collection matching and music-grid rendering.
- Added Firefox Add-ons download and usage badges to the README.
- Introduced collection ownership indicators, filters, cross-label match reviews, individual ownership verification, and digital pricing comparisons.
- Added local collection caching, privacy controls, and support for older desktop Firefox permission flows.
