# Security Policy

## Supported Versions

Security fixes are applied to the latest code on the default branch. Older
releases may be asked to upgrade before a fix is provided.

## Reporting a Vulnerability

Use GitHub's private **Report a vulnerability** form for this repository. If
private vulnerability reporting is unavailable, open a minimal issue asking the
maintainer for a private contact channel.

Do not include any of the following in a public issue, discussion, or pull
request:

- `.blackboard-state.json` or another Playwright storage-state file
- Cookies, authorization headers, OAuth fields, bearer tokens, or signed URLs
- Institutional credentials or multi-factor authentication details
- Student names, identifiers, submissions, grades, feedback, or course files
- Raw Blackboard responses that have not been reduced and anonymized

Include the affected version, operating system, impact, reproduction outline,
and a synthetic proof of concept where possible. You should receive an initial
acknowledgement within seven days.

## Security Boundaries

The dashboard is designed for localhost use and rejects non-loopback bindings,
cross-origin mutations, path traversal, and archive symlinks that leave a course
directory. The fetcher only archives content visible to the authenticated user;
it is not intended to bypass Blackboard authorization or institution policy.
