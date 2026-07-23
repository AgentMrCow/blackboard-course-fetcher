# Contributing

Contributions that improve Blackboard compatibility, archive completeness,
offline browsing, accessibility, tests, or documentation are welcome.

## Development Setup

Use Node.js 20.19 or newer:

```bash
npm ci
npx playwright install chromium
npm run dashboard
```

The dashboard is available at `http://127.0.0.1:4173`. Frontend development can
use `npm run dashboard:dev` in a second terminal.

## Verification

Run the same verification used by GitHub Actions:

```bash
npm run ci
```

This command runs JavaScript and Svelte checks, all unit tests, and the production
dashboard build. Tests must not contact a live Blackboard installation.

## Fixtures and Privacy

Never commit browser storage state, cookies, credentials, signed download URLs,
student identifiers, submissions, grades, or institution-specific course data.
Use `blackboard.example.edu`, synthetic identifiers, and minimal deterministic
payloads in tests.

When adding a regression fixture:

1. Keep only fields required to reproduce the behavior.
2. Replace institution, user, course, content, attempt, and file identifiers.
3. Replace names, email addresses, file contents, and URLs with synthetic values.
4. Confirm the fixture still fails before the fix and passes after it.

The repository intentionally ignores local archives, dashboard state, Playwright
artifacts, and common storage-state filenames.

## Architecture

Read [docs/architecture.md](docs/architecture.md) before changing module
boundaries. Application and domain modules must remain independent from
filesystem, browser, process, and HTTP implementations. The architecture tests
enforce this dependency direction.

## Dashboard Changes

Keep operational interfaces compact, accessible, and responsive. Use the
existing Svelte components and Lucide icon wrapper. After a visual change:

```bash
npm run check:client
npm run dashboard:build
```

To refresh the README walkthrough while the dashboard is running:

```bash
npm run docs:capture
```

The capture uses deterministic API fixtures and does not start a real fetch.
`ffmpeg` is optional and is needed only to regenerate the animated GIF.

## Pull Requests

Keep each pull request focused. Describe the Blackboard behavior affected,
include focused tests, and list the commands used for verification. Do not attach
private course screenshots or raw responses to an issue or pull request.
