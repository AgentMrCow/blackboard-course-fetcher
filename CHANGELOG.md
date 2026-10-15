# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Per-refresh replacement history for previous manifests, metadata exports, and
  external snapshots, with original paths and SHA-256 hashes for recovery.
- Explicit per-file transfer dispositions and current-attempt download counters.
- Released grade-level instructor feedback exports and dashboard display.

### Fixed

- Stop on explicit membership denial before modifying course exports or migrating
  legacy archive directories; retain locally archived courses during inventory refresh.
- Preserve old bytes before replacing generated files and write replacements atomically.
- Count identical-body downloads as network transfers, include fallback snapshots
  in progress totals, and reset transfer counters when a retry starts a new worker.
- Recognize text-only submissions and distinguish unrecovered metadata from
  unsubmitted, ungraded, or undated work.
- Reduce repeated path resolution when loading announcements while checking each
  file for symlink escapes; omit replacement history from file listings and search.

## [0.2.0] - 2026-07-23

### Added

- Local Svelte dashboard for setup, inventory, fetch control, and archive browsing
- Ultra and Classic course inventory and archive workflows
- Full and placeholder transfer modes with resumable validated cache reuse
- Archived assessments, grades, announcements, discussions, messages, groups,
  achievements, Blackboard Annotate data, quiz reviews, and supported H5P content
- File provenance, coverage audits, local previews, and background search indexing
- Deterministic architecture, adapter, policy, dashboard, and regression tests
- Playwright-generated README walkthrough with PNG and animated GIF assets

### Security

- Localhost-only dashboard binding and same-origin mutation checks
- Contained archive paths, symlink checks, streamed hashing, and response validation
- Saved authentication state and local course archives excluded from version control

[Unreleased]: https://github.com/AgentMrCow/blackboard-course-fetcher/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/AgentMrCow/blackboard-course-fetcher/releases/tag/v0.2.0
