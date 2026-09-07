# obsync: one static server binary, its dashboard, and its own plugin bundle.
#
# Every stage that is not the final image runs on the BUILD platform. The
# plugin is bytes that do not vary by target, and Rust cross-compiles a static
# binary for any target from any host, so nothing here is emulated: the checks
# run once, natively, and only the final stage is per-target (AGENTS.md,
# "Build, test, and release flows").
#
# Every base image is pinned by digest, not by tag. A tag moves; a digest does
# not, and requirement 5 makes every build input a decision rather than
# whatever the registry served today.

# ---------------------------------------------------------------------------
# plugin -- the Obsidian plugin bundle, built by its own homegrown bundler.
# The digest is the one the sibling repository pins for this exact tag; the
# node:24.19.0-trixie-slim TAG has since moved to other bytes, which is
# precisely why the reference below is a digest.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM docker.io/library/node:24.19.0-trixie-slim@sha256:0711b541c1c33a8a530ac4f0d391baa9a15b3d804695b1b24a47daa5fb60e74d AS plugin
WORKDIR /src/plugin
COPY plugin/package.json plugin/package-lock.json ./
# The tag and digest select Node; these checks also prove the npm bundled by
# that image is the separately reviewed package-manager pin. `--ignore-scripts`
# is not optional: it is the difference between installing a compiler and
# executing arbitrary install hooks (requirement 5).
RUN test "$(node --version)" = "v24.19.0" && \
    test "$(npm --version)" = "11.17.0" && \
    npm ci --ignore-scripts --no-audit --no-fund
COPY plugin/ ./
RUN npm run build && npm test

# ---------------------------------------------------------------------------
# bundle -- exactly the three files a user installs into .obsidian/plugins.
# It exists so the Release asset and the directory the server serves are the
# SAME bytes: the publisher exports this stage with
# `docker buildx build --target bundle --output type=local`, and the final
# image copies the same stage. Two artifacts, one source of truth.
# ---------------------------------------------------------------------------
FROM scratch AS bundle
# All three come from `dist/`, which is what `plugin/build.mjs` actually wrote
# and printed a SHA-256 for. Copying manifest.json and styles.css from the
# repository root instead would be byte-identical today and one bundler change
# away from not being, and the release evidence manifest records a digest over
# these exact three files.
COPY --from=plugin /src/plugin/dist/main.js /main.js
COPY --from=plugin /src/plugin/dist/manifest.json /manifest.json
COPY --from=plugin /src/plugin/dist/styles.css /styles.css

# ---------------------------------------------------------------------------
# server -- test once natively, then cross-compile one fully static binary.
#
# The digest was resolved with:
#   docker buildx imagetools inspect docker.io/library/rust:1.98.0-slim-trixie
# and independently against the registry manifest for that tag on 2026-09-07.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM docker.io/library/rust:1.98.0-slim-trixie@sha256:17d1ba895198f9934c6314ec5346a0d5115372f3243390c3d731e242f35c2f27 AS server
ARG TARGETARCH
ENV CARGO_TERM_COLOR=never
WORKDIR /src
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY crates/ ./crates/
# rust-toolchain.toml is the single pin (1.98.0 with rustfmt, clippy,
# llvm-tools); `rustup toolchain install` with no argument installs exactly
# what it names, so the image's own default toolchain never decides the build.
RUN set -eux; \
    rustup toolchain install; \
    test "$(rustc --version | awk '{print $2}')" = "1.98.0"; \
    rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl
# The workspace test suite runs ONCE, on the build platform, against the host
# target -- the same battery `make check` and the PR gate run. Emulating a
# second architecture to re-run identical stdlib-only tests buys nothing and
# costs minutes per release.
RUN cargo test --workspace --locked
# One fully static binary per target architecture. musl plus
# `+crt-static` and self-contained linking means the result has no dynamic
# loader and no libc to find at runtime, which is what lets the final image be
# distroless/static: no shell, no package manager, nothing to exec. The linker
# is the toolchain's own bundled `rust-lld`, reached by putting the target
# sysroot's bin directory on PATH, so cross-linking needs no C cross-toolchain
# and the build acquires no dependency (requirement 5).
RUN set -eux; \
    export PATH="$(rustc --print sysroot)/lib/rustlib/$(rustc -vV | awk '/^host: /{print $2}')/bin:${PATH}"; \
    case "${TARGETARCH}" in \
      amd64) target=x86_64-unknown-linux-musl ;; \
      arm64) target=aarch64-unknown-linux-musl ;; \
      *) echo "unsupported TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    RUSTFLAGS="-C target-feature=+crt-static -C link-self-contained=yes -C linker=rust-lld" \
      cargo build --release --locked --target "${target}" -p obsyncd; \
    install -D -m 0755 "target/${target}/release/obsyncd" /out/obsyncd; \
    /out/obsyncd --version || true

# ---------------------------------------------------------------------------
# The shipped image: one static binary, the dashboard it serves, and the plugin
# bundle it hands to devices. No package manager, no source tree, no compiler,
# no shell -- so requirement 5's "the container runs as non-root with a
# read-only root filesystem, no capabilities, and no shell" is a property of
# these bytes rather than of the manifest that runs them.
# ---------------------------------------------------------------------------
FROM gcr.io/distroless/static-debian13:nonroot@sha256:f7f8f729987ad0fdf6b05eeeae94b26e6a0f613bdf46feea7fc40f7bd72953e6
COPY --from=server --chown=65532:65532 /out/obsyncd /usr/local/bin/obsyncd
COPY --from=bundle --chown=65532:65532 / /opt/obsync/plugin/
COPY --chown=65532:65532 dashboard/ /opt/obsync/dashboard/
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/obsyncd"]
CMD ["serve"]
