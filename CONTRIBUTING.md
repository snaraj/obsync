# Contributing

[`AGENTS.md`](AGENTS.md) is the contract, for people and for agents alike:
requirements, testing doctrine, package layout, the gate, the review protocol,
and the release path. It is written to be operated cold from that one file, so
this page adds nothing to it and only says where to start.

## Before you write anything

1. Read [`AGENTS.md`](AGENTS.md) end to end, then
   [`docs/architecture.md`](docs/architecture.md) and
   [`docs/protocol.md`](docs/protocol.md).
2. Open an issue first. Substantive work is tracked as a labeled issue, and a
   pull request carries an exact `Closes #N` line.
3. Expect these to be refused rather than negotiated: a new runtime
   dependency, a paid or external service, a setting that can turn a security
   property off, a weakened check or test, and a secret or private fact in the
   repository. Requirements 1, 4, 5 and 11 say why.

## Before you open a pull request

- `make check` is the whole local gate, and CI runs the same battery:
  `make help` lists the targets it chains. Both secret scans are part of it.
- A change that touches any artifact surface advances every lockstep lock
  exactly one release step. [`docs/release.md`](docs/release.md) is the
  operational version of that rule;
  [`docs/ci-map.md`](docs/ci-map.md) says which job proves what.
- Mutate every guard you add before you hand the change over: invert or delete
  it, prove the suite goes red, restore it, and say so in the body.
- Every pull request opens as a draft, carries its `+/−` accounting, and is
  merged by the repository owner alone.

## Reporting a vulnerability

Not here. [`SECURITY.md`](SECURITY.md) is the only channel.
