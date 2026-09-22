# Mutation kill matrix - the server's dedupe key

Three declared invariants of the position key that the suite stated in prose
and no test could tell apart from its opposite (review round 5, finding 7).
Each mutant is an exact unified diff beside this file with its subject on its
first line, and this record is the output of one command:

    sh crates/obsyncd/mutants/run.sh

run over the sources this commit leaves in the tree, 367 library tests,
against the pinned Rust 1.98.0. One mutant can be re-measured on its own:

    sh crates/obsyncd/mutants/run.sh crates/obsyncd/mutants/S01.diff

The runner applies with `-F0`: a patch whose context has moved fails loudly
rather than mutating something it was never written for.

| Mutant | Subject | Killed by |
| --- | --- | --- |
| S01 | the sid vectors are sorted before they are compared | 1/367 |
| S02 | a parent named twice is two parents | 1/367 |
| S03 | the newest retained twin answers instead of the oldest | 1/367 |

## Which tests killed each mutant

**S01** - the sid vectors are sorted before they are compared

- storage::tests::reviewer_mutation_probe_sid_order_changes_content

**S02** - a parent named twice is two parents

- storage::tests::reviewer_mutation_probe_repeated_parent_is_one_position

**S03** - the newest retained twin answers instead of the oldest

- storage::tests::reviewer_mutation_probe_oldest_legacy_twin_wins
