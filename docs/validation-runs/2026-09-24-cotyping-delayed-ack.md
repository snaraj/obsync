# Co-typing with delayed receipts, 2026-09-24

The final 1.1.3 mutation preparation exposed a failure in an **unmutated**
co-typing test. This is author diagnostic evidence, not a native phone result
or an independent review. A retry that passed was not accepted as a repair.

## Reproduction and repair

Two simulated desktops typed on different lines of one open note. Under the
parallel full-suite schedule, parts of the typed lines moved into conflict
copies. Both devices eventually agreed, but their main notes did not contain
all the typing, violating the different-line acceptance test.

Delaying upload acknowledgements by 5–50 milliseconds reproduced the failure
without the full-suite load. The traces identified three connected problems:

- A merge could already include an uploaded edit's bytes while its parent
  list omitted that upload, whose receipt had not yet reached the author.
  A concurrent merge now waits for that receipt, then reads the current record
  and graph again. It also checks for an upload that began during the merge.
- An old upload or merge receipt could replace the newer record produced by
  an incoming version. Each receipt now preserves a record that advanced
  while the request was outstanding; the comparison follows the final digest
  calculation, so another asynchronous digest does not reopen the gap.
- Two merged heads could have identical content and different parent pairs.
  Edits saved on that shared content were compared with an older graph
  ancestor, inventing a same-line overlap. The authenticated shared content
  is now the merge base in that case. Existing ancestor scope and size checks
  still run; an excluded ancestor is never assembled.

Five deterministic regressions cover the two upload timing boundaries, the
upload and merge receipt races, and the identical-content graph. Earlier
source fails the relevant witnesses. The six delayed-acknowledgement schedules
pass after the repair. These are simulated hosts with real plugin code and
WebCrypto, not measurements of a physical network or mobile timing.

Run the regressions with the pinned toolchain:

```sh
npm --prefix plugin run build
node --test plugin/test/cotyping.test.mjs plugin/test/scope.test.mjs
```

Mutation controls M712–M715 restore each failure mechanism; each applies,
compiles and fails the targeted suite. The complete mutation matrix is a
separate gate and remains incomplete until its measured record is regenerated.

## Baseline completion checks

Two other parallel-baseline failures read results too early. The restored-server
startup test now distinguishes the replacement engine's requests from the
previous engine's requests. The folder-rename test waits for the expected note
on the peer. The co-typing fixture also waits for the initial publisher's
record before starting the editors. Assertions about content, probe counts,
conflict copies and convergence were retained. A further pristine run reached
the periodic scan during the confirmation-only deletion test; that test now
holds its scan timer explicitly so scanning cannot rescue the confirmation.
The separate periodic-scan test remains active and unchanged.

The first full-gate attempt after this repair was denied local socket binding
by the execution sandbox. It is retained as a capability failure. The authorized
`make check` then passed: 1,107 plugin tests, 144 core and 375 server tests,
two CLI tests, 70 dashboard tests, 767 contracts, 94.73% Rust line coverage and
both secret scans. One intentionally ignored core benchmark remains ignored.
The later confirmation-only fixture adjustment receives its own verification;
final native candidate and full-matrix evidence remain separate gates.
