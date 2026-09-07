# Changelog

All notable changes to obsync are recorded here. The format follows
Keep a Changelog; versions follow SemVer. Every artifact-classified merge
advances exactly one patch (AGENTS.md, requirement 10).

## 0.1.0 - Unreleased

### Added

- Repository contract, architecture, wire protocol, storage, threat model,
  benchmark, validation, and platform-onboarding documents.
- Start-time volume posture: `serve`, `check`, and `export` measure the type,
  owner, and mode of both volume roots and both credential files before
  anything is read or written through them. A weak mode is corrected and
  re-read; a link, a substituted type, or a foreign owner refuses the start.
