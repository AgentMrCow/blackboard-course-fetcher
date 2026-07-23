# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
