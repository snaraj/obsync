"""The onboarding path is a security surface. This pins the repaired shape.

WHY. A security review of the first release train found three things wrong with
the way README.md told a stranger to start: it ran the server by the MUTABLE
tag `ghcr.io/snaraj/obsync:v0.1.0` after telling the reader to verify a
signature, so the bytes verified and the bytes run were two different
decisions; it read the setup token with a networked helper container mounting
the journal volume read-write, which hands a third-party image the volume that
holds the server key; and it called the token "one-time", which is false --
the token creates the account once and then REMAINS a standing sign-in to the
dashboard, where it can revoke devices and escrow folder keys. Every one of
those was fixed in prose. Then the repair was reverted in a scratch copy as an
experiment, and all 146 contract tests stayed green: nothing in this repository
knew the difference. Prose that is a security control needs a control.

WHAT IS REFUSED, and why each one is the security property rather than a style
preference:

  1. digest-only runs -- every `docker run` in either document must run
     `ghcr.io/snaraj/obsync@sha256:…`. A tag is a mutable pointer: the
     signature the reader just checked says nothing about what the tag will
     resolve to a second later, so a tag run silently discards the entire
     verification step above it. The same rule refuses a HELPER image by
     construction, because a helper is a `docker run` of something else.

  2. the two cosign flags, verbatim -- `cosign verify` without
     `--certificate-identity` and `--certificate-oidc-issuer` accepts a
     signature from ANY identity in ANY OIDC issuer, which is not a weaker
     check, it is no check. The exact strings are pinned because a plausible
     near-miss (a different workflow path, a different ref) is exactly what an
     attacker who can publish would want the reader to paste.

  3. the tokenless token read -- the README's `docker cp <name>:… - | tar -xO`
     must survive. It reads the credential through the daemon, with no second
     image, no network, and no write access to the journal volume.

  4. no journal volume anywhere else -- `-v obsync-journal:` may appear only
     in the server's own digest-pinned run line. That volume holds the
     generated server key and the setup token; mounting it into anything else
     is the helper-container hole re-opened under a different name.

  5. no "one-time" near "setup token" -- in EITHER document, in the same
     sentence. The word tells the reader the credential is spent after first
     use, so they stop protecting it. It is the single most dangerous word
     that has appeared in this onboarding path.

  6. the standing-credential sentence -- README.md's quick start must still
     say the token "remains the dashboard's recovery sign-in", and
     architecture.md section 4.1 must still say where it is written, that it
     is never logged, that it creates the account, and that it remains the
     recovery sign-in. Refusing the wrong word (rule 5) without requiring the
     right sentence leaves "delete the paragraph" as a way to go green.

FAIL-CLOSED PARSING. The image of a `docker run` is found by walking its flags,
and a flag not in `VALUE_FLAGS` is treated as a boolean. A future flag that
takes a SEPARATE value would therefore make its value look like the image and
this suite would refuse the line. That direction is deliberate: the refusal
names the flag and the fix is one entry in `VALUE_FLAGS`, whereas guessing the
other way would let a helper run past. A fenced block that will not tokenize is
refused too, if it mentions `docker run` or `cosign verify` at all.

EVERY RULE HAS A NEGATIVE TEST. `MutatedDocumentsAreRefused` re-runs the same
functions over the real text with one property broken -- in memory, never on
disk -- so a rule that stopped being able to fail fails here instead.
"""

from __future__ import annotations

import re
import shlex
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
README = ROOT / "README.md"
ARCHITECTURE = ROOT / "docs" / "architecture.md"

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
TOKEN_READ = re.compile(r"docker cp \S+:/data/journal/v1/setup-token - \| tar -xO")
JOURNAL_MOUNT = re.compile(r"(?:^|\s)(?:-v|--volume)[ =]obsync-journal:")
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

# Segment separators inside one logical shell line. A pipeline or an `&&` chain
# is several commands and each is judged on its own.
SEGMENT = re.compile(r"\|\||&&|[|;]")


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


def _segments(line: str) -> list[str]:
    return [part.strip() for part in SEGMENT.split(line) if part.strip()]


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
    for name, text in documents.items():
        found.extend(_command_refusals(name, text))
        found.extend(_prose_refusals(name, text))
    readme = documents.get("README.md", "")
    quick_start = section(readme, "## Get syncing")
    if not quick_start:
        found.append("README.md has no `## Get syncing` section")
    else:
        if not TOKEN_READ.search(quick_start):
            found.append(
                "README.md: the quick start no longer reads the setup token with "
                "`docker cp <name>:/data/journal/v1/setup-token - | tar -xO`"
            )
        if RECOVERY_SENTENCE not in quick_start:
            found.append(
                "README.md: the quick start no longer says the token "
                f"{RECOVERY_SENTENCE!r}"
            )
    architecture = documents.get("docs/architecture.md", "")
    if architecture:
        found.extend(_architecture_refusals(architecture))
    return found


def _command_refusals(name: str, text: str) -> list[str]:
    found: list[str] = []
    for line in logical_lines(text):
        for segment in _segments(line):
            try:
                tokens = shlex.split(segment)
            except ValueError:
                if "docker run" in segment or "cosign verify" in segment:
                    found.append(f"{name}: unparseable command: {segment}")
                continue
            if tokens[:2] == ["docker", "run"]:
                image = _image_of(tokens[2:])
                if image is None or not image.startswith(SERVER_IMAGE_PREFIX):
                    found.append(
                        f"{name}: `docker run` runs {image!r}, not "
                        f"{SERVER_IMAGE_PREFIX}… (a tag or a helper image)"
                    )
                # A journal mount inside THIS segment is the server's own run
                # line and is the one place it is allowed. A mount anywhere
                # else in the pipeline is a different segment and is judged as
                # one below; there is no third case, so there is no branch for
                # one.
                continue
            if JOURNAL_MOUNT.search(segment):
                found.append(
                    f"{name}: `obsync-journal:` is mounted by a command that is not "
                    f"the server's own digest-pinned run: {segment}"
                )
            if tokens[:2] == ["cosign", "verify"]:
                for pair in (CERTIFICATE_IDENTITY, CERTIFICATE_ISSUER):
                    if not _has_flag(tokens, pair):
                        found.append(
                            f"{name}: `cosign verify` is missing "
                            f"`{flag_text(pair)}`"
                        )
    return found


def _has_flag(tokens: list[str], pair: tuple[str, str]) -> bool:
    """`--flag value` or `--flag=value`, both as WHOLE tokens."""
    flag, value = pair
    for index, token in enumerate(tokens):
        if token == f"{flag}={value}":
            return True
        if token == flag and tokens[index + 1 : index + 2] == [value]:
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
        "README.md": README.read_text(encoding="utf-8"),
        "docs/architecture.md": ARCHITECTURE.read_text(encoding="utf-8"),
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
        self.assertRegex(quick_start, TOKEN_READ)

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

    def test_a_semicolon_does_not_end_a_sentence(self):
        # The rule is "the same sentence", and a semicolon joins clauses into
        # one. Splitting on it would be a quiet weakening of rule 5.
        self.assertEqual(len(sentences("A one-time link; the setup token stays.")), 1)




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
            "docker cp obsync:/data/journal/v1/setup-token - | tar -xO",
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
            "docker cp obsync:/data/journal/v1/setup-token - | tar -xO",
            "docker cp obsync:/data/journal/v1/setup-token - | tar -xO\n"
            "cat x | docker run --rm -v obsync-journal:/j:ro busybox cat /j/x",
        )
        self.kills(found, "a tag or a helper image")

    def test_a_journal_mount_on_a_non_run_command_is_refused(self):
        # The rule stands on its own, not only as a consequence of rule 1: a
        # command that is not `docker run` at all still may not touch that
        # volume.
        found = self.mutate(
            "README.md",
            "docker cp obsync:/data/journal/v1/setup-token - | tar -xO",
            "docker cp obsync:/data/journal/v1/setup-token - | tar -xO\n"
            "docker create -v obsync-journal:/j scratch",
        )
        self.kills(found, "is mounted by a command that is not")

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
            "docker cp obsync:/data/journal/v1/setup-token - | tar -xO",
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


if __name__ == "__main__":
    unittest.main()
