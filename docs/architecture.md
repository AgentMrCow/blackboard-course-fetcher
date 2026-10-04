# Architecture

## Direction

Blackboard Course Fetcher is a local-first modular monolith. One Node.js process
hosts the dashboard and coordinates isolated worker processes for expensive or
browser-backed work. Course archives remain ordinary files so users can inspect,
copy, and recover them without the application.

The code follows a hexagonal dependency direction:

```text
CLI / local HTTP / workers
           |
     composition root
           |
     application policy
           |
       ports/contracts
           |
filesystem / Blackboard / process / HTTP adapters
```

Dependencies point toward application policy. Application modules must not import
filesystem, network, browser, process, or dashboard transport implementations.
`test/blackboard-architecture.test.js` enforces this rule.

## Modules

### `src/application`

Pure application policy and validation. `dashboard-settings.js` currently owns
dashboard setting defaults and normalization. `settings/settings-command-service.js`
owns guarded settings persistence and runtime-service rebinding, while
`fetch-jobs/fetch-command-service.js` applies launch defaults and storage policy.
`fetch-jobs/job-manager.js`
coordinates queue use cases through injected archive, repository, process-runner,
clock, and scheduler contracts. `archive/archive-service.js` builds inventory,
course, summary, file, and search views through an archive-repository contract;
`archive/build-file-index.js` owns the file-index schema and build workflow.
`authentication/authentication-coordinator.js` owns session-check and sign-in
state transitions through session-gateway and runner contracts.
`inventory/inventory-coordinator.js` owns inventory start, output, cancellation,
and completion policy through the same kind of injected ports.
`inventory/course-inventory-service.js` performs membership discovery, archive
status enrichment, selection, and index persistence through Blackboard gateway
and inventory-repository contracts.
`fetch-all/fetch-all-command-service.js` validates and executes the public
inventory-and-fetch workflow, while `fetch-jobs/course-fetch-batch-service.js`
owns bounded CLI batch concurrency and course status transitions through an
injected runner.
`course-fetch/course-fetch-configuration.js` owns single-course worker input
validation, and `course-fetch/course-fetch-progress.js` records phase timings
and emits the existing worker progress protocol through injected clock and
output ports. `course-fetch/course-file-transfer-service.js` owns direct binary
and text transfer, placeholder and unresolved records, conditional and local-hash
cache reuse, streamed integrity checks, duplicate-content reuse, and transfer
counters through injected HTTP, stream, filesystem, and reporting ports.
`course-fetch/attachment-url-recovery-service.js` coordinates ordered attachment
recovery strategies and the final owner-URL rule through injected gateways; it
does not launch a browser or issue requests itself.
`file-index/file-index-coordinator.js` owns cache installation, worker progress,
coalesced rebuild requests, archive-root changes, and shutdown policy through
cache-repository and runner contracts. This layer may use shared errors and
general value helpers, but not adapters.

### `src/domain`

Pure fetch-job state rules, archive metadata policy, course-inventory policy,
the single-course manifest schema and coverage declarations, and course-file
type and reported-size policy. Blackboard attachment policy owns exact `xid`
matching, same-origin WebDAV filtering, candidate ordering, authentication
redirect classification, and safe response filenames.
Archive-artifact policy owns provenance, logical grouping, primary
representations, searchability, dashboard scopes, and conservative inference for
archives created before explicit artifact records existed. Unknown files are
classified as local additions and stay visible.
Browser-workflow policy builds feedback and Classic submission URLs from generic
identifiers and classifies submission types supported by Blackboard Annotate.
Restart reconciliation, worker-exit transitions, terminal states, phase weights,
MIME/preview mapping, archive categories, term canonicalization, folder naming,
course selection, prior-download indexing, and manifest initialization are
independent from I/O and transport concerns.

### `src/adapters`

Infrastructure implementations grouped by capability:

- `blackboard`: saved-session inspection and authenticated session validation
  behind `BlackboardSessionGateway`; a shared authenticated REST client owns
  cookie scoping, transient retry and `Retry-After` policy, response errors, and
  configurable strict or permissive pagination. It classifies 401 responses,
  SSO redirects, and successful HTML login pages as expired authentication,
  and reports malformed JSON separately. Course-membership discovery and the
  single-course engine both use that client. Attachment recovery has a
  server-rendered HTML gateway and a Playwright gateway; both return observations
  while domain policy remains the authority for trusted resource URLs. Focused
  Playwright gateways fetch quiz-review HTML, drive feedback menu downloads, and
  discover exact-attempt Classic submission files and Annotate frames. A shared
  Blackboard Extras gateway captures Achievements API responses and serial
  Annotate sync payloads, refreshing short-lived tickets and retrying failed
  captures once without owning archive schemas.
- `filesystem`: JSON persistence, archive signatures, validated file-index cache
  loading, settings persistence, private Playwright state loading, symlink-safe
  course-inventory persistence, and contained access to archive inventories,
  manifests, course records, and files. The course-file store contains direct
  transfer writes, cache reads, hashes, version selection, and temporary-file
  placement within one course output root, rejecting symlink escapes.
- `http`: a guarded dashboard router; focused workspace, archive, fetch-job, and
  static controllers; request parsing; JSON responses; archive file streaming;
  local request security; byte ranges; and an isolated server-sent-event client
  hub that owns connection lifecycle and event framing.
- `cli`: fetch-all and single-course argument parsing, environment and path
  resolution, console progress observation, help, and result presentation.
- `system`: authentication, inventory, file-index, dashboard fetch, and CLI course
  process runners; a shared single-course worker argument contract; output
  streaming; local process control; disk status; and shared Playwright module,
  Chromium discovery, and launch policy.

### `src/composition`

The only layer that assembles concrete implementations. `dashboard-runtime.js`
owns project paths, repositories, runners, HTTP server construction, local-only
binding validation, and CLI shutdown handling. `dashboard-router-factory.js`
orders the HTTP controllers and supplies them with the dashboard facade.
`course-inventory-runtime.js` assembles the inventory discovery use case for the
public fetch-all CLI. `fetch-all-runtime.js` adds validation, bounded course
execution, the CLI process runner, and transport presentation around that use case.
`course-fetch-runtime.js` assembles the single-course worker and retains the
proven Ultra and Classic traversal while its policies and infrastructure continue
to move behind focused contracts. `blackboard-extra-archive.js` coordinates the
additional archive areas using injected REST and browser gateways.

### `bin`

Narrow executable entry points for inventory-and-fetch and single-course fetch
commands. They contain no archive or Blackboard behavior and delegate directly
to the composition runtimes under `src/composition`.

### `dashboard`

The local workspace facade. `server.js` exposes the operations needed by the HTTP
controllers while delegating archive, fetch-job, authentication, and inventory
behavior to injected application services. File-index caching, worker IPC, and
rebuild scheduling are also delegated to the injected coordinator. Settings
mutation and fetch launch policy belong to injected application command services,
and HTTP event clients belong to the injected SSE hub. The server no longer
parses URLs, request bodies, route patterns, HTTP responses, file-index
cache files, or child-process messages. It has no default paths, repositories,
runners, or service constructors: missing composition dependencies fail at
startup. `auth-worker.js` and `file-index-worker.js` are narrow process entry
points; the latter handles only worker IPC and atomic output while index
construction belongs to the application layer.

`dashboard/client` is a Svelte and TypeScript single-page client built by Vite.
Svelte components own the application shell, hash routing, course and archive
views, dialogs, live fetch state, and form interactions. `src/lib/controller.ts`
is the client-side boundary around the existing JSON and server-sent-event API;
it does not contain fetch-engine policy. Vite writes deterministic production
assets to `dashboard/public`, which remains a passive static adapter served by
the Node HTTP process. The frontend framework therefore does not enter the
application, domain, Blackboard, filesystem, or worker layers.

### Course-fetch runtime

The single-course archive engine remains stable while its boundaries are
extracted. CLI input resolution, validation, storage-state loading, manifest
construction, coverage policy, previous-download indexing, progress framing, and
phase timing delegate to focused modules. Authenticated JSON requests, cookie
selection, retry delays, and strict duplicate/count/loop pagination checks use
the shared Blackboard adapter. Direct file transfer, placeholder generation,
ETag and Last-Modified validation, local SHA-256 reuse, streamed integrity,
duplicate-content handling, and unresolved records use application and contained
filesystem modules. Attachment URL recovery uses an application strategy chain
backed by authenticated HTML and Playwright gateways, with exact same-origin
resource matching in the domain layer. The proven Ultra, Classic, attachment
discovery, and assessment traversal remains in `src/composition/course-fetch-runtime.js`;
quiz, feedback, and Classic submission browser automation returns plain results
through focused gateways. The additional-area coordinator receives Achievements
and Annotate captures through one shared browser-session gateway while retaining
raw payloads, archive writing, classification, manifest, and coverage policy.
Neither composition module directly uses Playwright page or context APIs. Flags,
archive schema, output, and the single-course worker protocol remain compatible.

The filesystem layout allocator registers content IDs and their parent IDs before
exports are written. It reserves previous allocations, compares names with
case-insensitive Unicode normalization, and separates title collisions with ID
suffixes. Coverage policy also detects legacy colliding paths and mislabeled
attachment markers without rewriting old manifests when the dashboard opens.
Transfer cache eligibility excludes placeholder, unresolved, and link-only
records independently of size/hash validation. LTI assessment coverage requires
a real grading column; ungraded tools still participate in LTI resource coverage.
The LTI gateway follows bounded same-origin launch redirects and carries response
cookies between them without forwarding Blackboard cookies to external providers.

## Runtime Data

The archive is the durable source of downloaded course material:

```text
Blackboard_Archive/
  courses.json
  <term>/<course>/manifest.json  # schema 9 includes artifact provenance
  <term>/<course>/<archived files>
```

Dashboard runtime state is separate and disposable:

```text
.dashboard-data/
  settings.json
  jobs.json
  file-index.json
  login-profile/
```

The disposable `file-index.json` uses schema 3. It combines physical file
metadata with manifest provenance, stores only eligible small text documents for
search, and precomputes material/export/record counts. Search derivatives point
to a primary formatted representation and share a logical group key, preventing
duplicate HTML/text results. Older indexes are rebuilt automatically; older
course manifests are classified through backward-compatible inference and are
not modified merely by opening the dashboard.

The saved Playwright storage state is a credential and remains outside the
archive. It must never be committed or exposed through dashboard APIs.

## Worker Model

The local HTTP process stays responsive while child processes perform course
inventory, authentication, file indexing, and course fetches. Application
coordinators know only runner, repository, and gateway contracts; the adapters own
IPC, environment variables, CLI arguments, process groups, cache-file validation,
and output streams. A fetch job has explicit queued, running,
paused/interrupted, completed, failed, and cancelled states. The dashboard
composition root injects `JsonJobRepository`, `FileIndexCacheRepository`, and its
four Node runners; the fetch-all composition root injects the CLI course runner.
SQLite can therefore replace JSON behind the job repository contract without
changing routes, CLI arguments, worker protocol, or archive output.
Batch exclusivity includes live children even after cancellation is requested.
Delayed kill escalation is tied to the original process identity, and interrupted
tasks prevent a batch from reporting clean completion. Frontend file-list loads
verify their filter/page generation, while preview loads verify their dialog
identity before applying asynchronous results or errors.

## Refactoring Sequence

Completed foundations:

1. Shared policy and infrastructure adapters were extracted without changing
   public behavior.
2. Dashboard startup moved into a composition root with injected dependencies.
3. Fetch-job state, application use cases, JSON persistence, and the Node process
   runner were separated and independently tested.
4. Archive metadata, filesystem containment, query orchestration, and file-index
   construction were separated behind an archive-repository contract.
5. Authentication and inventory lifecycle policy were moved behind session-gateway
   and process-runner ports and wired through the composition root.
6. Dashboard URL dispatch was split into guarded workspace, archive, fetch-job,
   and static HTTP controllers assembled by the composition root.
7. File-index cache validation, worker IPC, and rebuild scheduling were separated
   behind repository and runner ports with an application coordinator.
8. Legacy dashboard service facades and concrete construction fallbacks were
   removed, leaving the composition root as the only runtime assembly path.
9. Settings mutation and fetch-launch policy moved into independently tested
   application command services with filesystem and system ports supplied by the
   composition root.
10. Server-sent-event framing, connection lifecycle, broadcasting, and shutdown
    moved from the workspace facade into a dedicated HTTP adapter.
11. Fetch-all inventory discovery was separated into pure course and term policy,
    a Blackboard membership gateway, a contained filesystem repository, an
    application service, and a composition runtime while preserving the public
    CLI and archive index schema.
12. Fetch-all validation and bounded batch execution moved into application
   services; CLI parsing and output moved into a transport adapter; child-process
   execution moved behind a system runner shared with the dashboard worker
   protocol; and the root entry point was reduced to composition startup.
13. Single-course CLI input and validation, manifest and coverage policy,
   storage-state loading, prior-download indexing, and progress and phase timing
   moved behind tested contracts while the Blackboard content engine remained
   behaviorally unchanged.
14. Blackboard cookie scoping, transient HTTP retry, `Retry-After` handling, JSON
   errors, and pagination moved into one tested REST adapter shared by course
   discovery and the single-course engine. Strict course-fetch count, duplicate,
   and loop checks remain separate from permissive inventory termination policy.
15. Direct course-file transfer moved into an application service backed by pure
   file policy and a course-root filesystem store. Placeholder and unresolved
   records, conditional and local-hash cache reuse, streamed SHA-256 integrity,
   duplicate-content reuse, and counters are independently tested.
16. Attachment URL recovery moved into an application strategy service backed by
   authenticated HTML and Playwright gateways. Exact `xid`, same-origin WebDAV,
   candidate ordering, authentication redirect, and filename rules are pure
   domain policy; HTTP is attempted before browser startup and the narrow
   announcement-owner rule remains the final candidate.
17. Quiz-review HTML retrieval, feedback menu downloads, and Classic submission
   DOM inventory moved into three Playwright gateways sharing the system Chromium
   runtime. Generic URL construction and Annotate-compatible file classification
   are pure policy; archive paths, hashes, records, and fallback order remain in
   the engine. Reserved feedback paths prevent same-name batch overwrites.
18. Achievements response capture, Classic Annotate-frame discovery, fresh viewer
   navigation, sync interception, serial retry, and browser lifecycle moved into
   one Blackboard Extras gateway. The archive module owns JSON schemas and
   counters. Optional unread-achievement observation now
   waits at most five seconds instead of the full required-response timeout.
19. Deterministic fixtures now replay Ultra content pagination, assessment
   attempts, Classic submission observations, malformed payloads, and expired
   sessions through public adapter contracts. The REST adapter distinguishes
   authentication HTML from malformed JSON.
20. Course download URLs, errors, quiz API objects, Achievements responses, and
   Annotate payloads are retained verbatim in the local archive. Classic quiz
   review pages preserve the complete source HTML alongside derived readable HTML,
   text, and JSON views.
21. The imperative dashboard client was replaced by a Svelte, Vite, and TypeScript
   client while preserving the local HTTP API, SSE protocol, routes, archive
   layout, and Node server. Production output remains static files under
   `dashboard/public`.
22. Fetch command shims moved to `bin/`; the single-course and additional-area
   coordinators moved to `src/composition`; Classic quiz parsing moved to the
   Blackboard adapters; archive layout and download streaming moved to filesystem
   adapters. The project root no longer contains fetch implementation modules.
23. Manifest schema 9 records explicit archive-artifact provenance. File-index
   schema 3 applies the same policy to legacy archives, exposes separate material,
   export, record, and physical-file scopes, and deduplicates derived search text
   against its primary formatted representation.

Next reliability priorities:

1. Strengthen interrupted-run resume, idempotency, retry budgets, and diagnostics.
2. Extend recorded fixtures when new Ultra or Classic response variants are
   observed instead of speculating about unsupported shapes.
3. Validate packaging and cross-platform installation before public release.
4. Split assessment/content traversal or adopt SQLite only when change pressure,
   concurrency, history size, or crash-recovery evidence justifies the cost.

Further work keeps `npm test`, `npm run check`, the local dashboard API, and the
existing archive layout compatible.
