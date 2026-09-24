"""Write plugin/test/mutants/MATRIX.md from one matrix run's output.

The record is the output of `sh plugin/test/mutants/matrix.sh`, so it is
generated from that output rather than edited by hand: a table whose numbers
were typed is a table nobody can check.
"""
import pathlib
import re
import sys

log = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
root = pathlib.Path(sys.argv[2])
total = int(sys.argv[3])

# Mutants that survive by CONSTRUCTION: the mutation changes no outcome, so no
# test can distinguish it and none is expected to. A mutant named here that the
# run kills ends this program rather than being written down either way, because
# one of the two is then wrong and only a person can say which.
EQUIVALENT = {"M28"}

# Prose kept beside a generated row. Counts are measured; only reasoning is
# written by hand.
NOTES = {
    "M28": (
        "- EQUIVALENT, and kept as the proof of that. The branch it removes sends\n"
        "  only an answer about the DESTINATION into the rule; the mutant sends the\n"
        "  source's answer there too, behind a cast that asserts a type the value\n"
        "  does not have. No outcome moves. For a file id this device already\n"
        "  tracks, `sameNameTiebreak` hands the version straight to\n"
        "  `updateSettled`, whose first act is to ask `competing` about that same\n"
        "  path -- the very answer that put the call there -- so it returns\n"
        "  `keepBoth`, which is what the `else` calls directly. The rename branch\n"
        "  below is not reachable either: it requires `held === null`, and `held`\n"
        "  is what got us here. What the mutant does change is the number of\n"
        "  `stat` calls on the way to the same answer, and until this range two\n"
        "  tests could tell the difference -- not because the outcome differed,\n"
        "  but because each waited on a proxy for what it went on to assert, so an\n"
        "  apply that took more turns was asserted on half-finished. Both now wait\n"
        "  on their own condition, and the mutant is indistinguishable across five\n"
        "  consecutive runs. It is kept rather than deleted because its shape is\n"
        "  the argument: the cast is the cost of merging the two paths."
    ),
    "M26": (
        "- WHY IT SURVIVES NOW AND DID NOT BEFORE, which is the reason this file\n"
        "  is generated rather than typed. Every earlier run recorded one kill for\n"
        "  it, always from the same test: `a remote rename that also edits the\n"
        "  note downloads it rather than renaming`. That test waited for the\n"
        "  note's TEXT and then asserted on its RECORD, so under any mutation that\n"
        "  added a step it read a record not yet written and died of\n"
        "  `undefined.fileId` -- which is not a fact about this mutant. The wait\n"
        "  is correct now, the phantom is gone with it, and the true state of the\n"
        "  guard is visible: nothing here tells `pushOne` queueing the follow-up\n"
        "  it remembered from `pushOne` forgetting it. Reaching that needs a\n"
        "  second request for a path WHILE it is being pushed, which the drain\n"
        "  does not produce -- it is awaiting the batch that holds the push, so\n"
        "  the second request waits in the queue and is served as an ordinary\n"
        "  push afterwards. The route that does produce it is the pull path\n"
        "  asking out of turn. The guard is kept: it is review round 2, finding 3,\n"
        "  where the consequence was an engine reporting idle with an edit that\n"
        "  had gone nowhere."
    ),
}

sections: dict[str, dict] = {}
current = None
for line in log.splitlines():
    start = re.match(r"^=== (M\d+)\.diff ===$", line)
    if start:
        current = start.group(1)
        sections[current] = {"tests": [], "applied": True, "built": True}
        continue
    if current is None:
        continue
    if "PATCH DOES NOT APPLY" in line:
        sections[current]["applied"] = False
    elif "COMPILE ERROR" in line:
        sections[current]["built"] = False
    hit = re.match(r"^not ok \d+ - (.+)$", line)
    if hit:
        sections[current]["tests"].append(hit.group(1).strip())

subjects = {}
for patch in sorted(root.glob("M*.diff")):
    head = patch.read_text(encoding="utf-8").splitlines()[0]
    got = re.match(r"^# (M\d+): (.+)$", head)
    if not got:
        raise SystemExit(f"{patch.name}: first line is not '# Mnn: subject'")
    subjects[got.group(1)] = got.group(2)

missing = sorted(set(subjects) - set(sections))
if missing:
    raise SystemExit(f"the run did not cover: {', '.join(missing)}")

notes = dict(NOTES)
unknown = sorted(set(notes) - set(subjects))
if unknown:
    raise SystemExit(f"a note names a mutant that is gone: {', '.join(unknown)}")

contradicted = sorted(ident for ident in EQUIVALENT
                      if ident in sections and sections[ident]["tests"])
if contradicted:
    raise SystemExit(
        "declared equivalent and yet killed, which one of the two has wrong: "
        + ", ".join(f"{ident} by {'; '.join(sections[ident]['tests'])}" for ident in contradicted)
    )

out = [
    "# Mutation kill matrix - the 1.1.2 train",
    "",
    "Every guard this range adds or carries, mutated against the whole plugin",
    "suite. Each mutant is an exact unified diff beside this file with its subject",
    "on its first line. Nothing below is typed by hand: the run produces the",
    "numbers and `record.py` writes this file from them, so a table whose counts",
    "have drifted from the suite is a table anyone can catch.",
    "",
    "    sh plugin/test/mutants/matrix.sh > matrix.log",
    f"    python3 plugin/test/mutants/record.py matrix.log plugin/test/mutants {total}",
    "",
    f"The last argument is the size of the clean suite -- {total} tests here, which",
    "`node --test` prints as `# tests` -- so every count below is out of the whole",
    "suite. One mutant can be re-measured on its own:",
    "",
    "    sh plugin/test/mutants/run.sh plugin/test/mutants/M12.diff",
    "",
    "A surviving mutant is a finding, so each line below either has a non-zero",
    "count and names the tests that produced it, or says why no test can produce",
    "one. The runner applies with `-F0`: a patch whose context has moved fails",
    "loudly rather than mutating something it was never written for, and a patch",
    "that fails to apply is neither a kill nor a survival -- it is an unmeasured",
    "guard, which is why every mutant whose context a repair moves is re-cut in",
    "the same range as the repair.",
    "",
    "| Mutant | Subject | Killed by |",
    "| --- | --- | --- |",
]
for ident in sorted(subjects, key=lambda name: int(name[1:])):
    entry = sections[ident]
    if not entry["applied"]:
        count = "**DID NOT APPLY**"
    elif not entry["built"]:
        count = "**DID NOT COMPILE**"
    elif ident in EQUIVALENT:
        count = "equivalent, see below"
    elif not entry["tests"]:
        count = f"**SURVIVES** 0/{total}"
    else:
        count = f"{len(entry['tests'])}/{total}"
    out.append(f"| {ident} | {subjects[ident]} | {count} |")

out += ["", "## Which tests killed each mutant", ""]
for ident in sorted(subjects, key=lambda name: int(name[1:])):
    entry = sections[ident]
    out.append(f"**{ident}** - {subjects[ident]}")
    out.append("")
    emitted = False
    if entry["tests"]:
        for name in entry["tests"]:
            out.append(f"- {name}")
        emitted = True
    elif ident not in EQUIVALENT:
        out.append("- SURVIVES. No test in the suite distinguishes this mutation from the")
        out.append("  code it replaces; the finding is recorded in the pull request.")
        emitted = True
    if ident in notes:
        if emitted:
            out.append("")
        out.append(notes[ident])
    out.append("")

(root / "MATRIX.md").write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
print(f"MATRIX.md: {len(subjects)} mutants, "
      f"{sum(1 for e in sections.values() if e['applied'] and e['built'] and not e['tests'])} survivor(s)")
