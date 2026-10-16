# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Course backup-history browser with saved-run selection, path filtering,
  previews, downloads, and explicit missing or changed file states.
- Read-only backup comparison and recovery previews, bounded UTF-8 text
  differences, and storage totals derived from the displayed journals.
- Mobile course-section selector and compact calendar with complete selected-day
  details, Upcoming/Overdue/All agenda filters, and pagination beyond twelve items.
- Responsive overview with archive readiness, deadlines, and recent material;
  course membership scopes, attention filtering, and visible-course selection.
- Offline Playwright checks for dashboard workflows and responsive layouts,
  shared with the documentation's synthetic fixtures.
- Per-refresh replacement history for previous manifests, metadata exports, and
  external snapshots, with original paths and SHA-256 hashes for recovery.
- Explicit per-file transfer dispositions and current-attempt download counters.
- Released grade-level instructor feedback exports and dashboard display.

### Fixed

- Read backup journals asynchronously and filter/page files on the server, checking
  at most 100 file paths per page instead of every preserved file when listing runs.
- Handle missing, unreadable, and interrupted file streams without an uncaught
  stream error terminating the dashboard.
- Invalidate saved-session validation when connection settings change and expose
  the complete sign-in/verification workflow from Settings.
- Preserve newer selections and dialogs when an earlier fetch request completes;
  show indexing failures with an explicit rebuild action.
- Keep closed mobile navigation out of the tab order, trap focus while open,
  restore focus on close, and handle viewport changes and course deep links.
- Show only future dates under Upcoming consistently across overview and calendar views.
- Bound API request duration, reject unexpected response formats, and prevent
  stale searches or detail requests from replacing newer user choices.
- Catch up dashboard state after event-stream reconnection, distinguish local
  connection problems from sign-in status, and stop failed file-list retry loops.
- Preserve routes when using the keyboard skip link and clean up connections
  when initialization completes after the dashboard has been unmounted.
- Keep quickly reopened dialogs visible when older close events arrive.
- Stop on explicit membership denial before modifying course exports or migrating
  legacy archive directories; retain locally archived courses during inventory refresh.
- Preserve old bytes before replacing generated files and write replacements atomically.
- Count identical-body downloads as network transfers, include fallback snapshots
  in progress totals, and reset transfer counters when a retry starts a new worker.
- Recognize text-only submissions and distinguish unrecovered metadata from
  unsubmitted, ungraded, or undated work.
- Reduce repeated path resolution when loading announcements while checking each
  file for symlink escapes; omit replacement history from file listings and search.

### Security

- Apply sandbox response policies to every archived document, including SVG opened
  directly, and recheck archive containment after opening the file descriptor.

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
