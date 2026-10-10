"""Exercise real CI failure propagation, plus meaningful neutralizations."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest

import e2ee_contract as contract
import miniyaml

ROOT = Path(__file__).resolve().parents[2]


class E2eeContract(unittest.TestCase):
    def setUp(self):
        self.workflow = (ROOT / '.github/workflows/pr-gate.yml').read_text()
        self.makefile = (ROOT / 'Makefile').read_text()

    def test_current_contract(self):
        self.assertTrue(contract.validate(self.workflow, self.makefile))

    def execute(self, run, failure, makefile=None):
        with tempfile.TemporaryDirectory(prefix='e2ee-ci-control-') as tmp:
            for command in ('node', 'cargo'):
                stub = Path(tmp, command)
                stub.write_text('#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$TRACE"\n'
                                + ('exit 17\n' if command == failure else 'exit 0\n'))
                stub.chmod(0o700)
            trace = Path(tmp, 'trace')
            command = ['/bin/bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', run]
            if makefile is not None:
                recipe = Path(tmp, 'Makefile')
                recipe.write_text(makefile)
                command = [shutil.which('make'), '--no-print-directory', '-r', '-f', str(recipe), '-o', 'plugin', 'e2ee']
            result = subprocess.run(command, cwd=tmp,
                                    env={'PATH': tmp + os.pathsep + '/usr/bin:/bin', 'TRACE': str(trace)}, capture_output=True, timeout=5)
            return result.returncode, trace.read_text()

    def test_workflow_executes_and_propagates_failure(self):
        run = contract.validate(self.workflow, self.makefile)
        for failure in ('node', 'cargo', None):
            code, trace = self.execute(run, failure)
            self.assertEqual(code, 0 if failure is None else 17)
            self.assertIn('cargo build --locked -p obsyncd', trace)
            self.assertEqual('node scripts/ci/e2ee.mjs' in trace, failure != 'cargo')
        # This is the independently reproduced surviving mutant. Its exit is
        # green despite the failing invariant; the contract must reject it.
        mutant = run.replace('node scripts/ci/e2ee.mjs', 'node scripts/ci/e2ee.mjs || true')
        self.assertEqual(self.execute(mutant, 'node')[0], 0)
        with self.assertRaises(ValueError):
            contract.validate(self.workflow.replace(run, mutant), self.makefile)

    def test_shell_neutralizations_refuse(self):
        for command in contract.COMMANDS:
            for replacement in ('true # ' + command, command + ' || true', 'false && ' + command,
                                'if false; then ' + command + '; fi', command + ' | true',
                                '# ' + command, 'echo ' + command):
                with self.subTest(command=command, replacement=replacement), self.assertRaises(ValueError):
                    contract.validate(self.workflow.replace(command, replacement), self.makefile)

    def test_conditional_and_ignored_jobs_or_steps_refuse(self):
        for field in ('if: false', 'if: always()', 'continue-on-error: true'):
            for old, new in [('  application:\n', '  application:\n    ' + field + '\n'),
                             ('      - name: ' + contract.STEP, '      - ' + field + '\n        name: ' + contract.STEP)]:
                self.assertIn(old, self.workflow)
                with self.subTest(field=field, old=old), self.assertRaises(ValueError):
                    contract.validate(self.workflow.replace(old, new), self.makefile)

    def test_missing_or_duplicate_step_refuses(self):
        step = next(s for s in miniyaml.load_one(self.workflow)['jobs']['application']['steps'] if s.get('name') == contract.STEP)
        start = self.workflow.index('      - name: ' + contract.STEP)
        end = self.workflow.index('      - name:', start + 1)
        block = self.workflow[start:end]
        for text in (self.workflow.replace(contract.STEP, 'removed'),
                     self.workflow[:start] + block + self.workflow[start:]):
            with self.assertRaises(ValueError):
                contract.validate(text, self.makefile)
        self.assertIn('node scripts/ci/e2ee.mjs', step['run'])

    def test_wrong_execution_context_refuses(self):
        for field in ('shell: sh', 'working-directory: plugin'):
            with self.assertRaises(ValueError):
                contract.validate(self.workflow.replace('      - name: ' + contract.STEP,
                                  '      - ' + field + '\n        name: ' + contract.STEP), self.makefile)

    def test_make_cannot_ignore_errors(self):
        for prefix, suffix in [('-', ''), ('@-', ''), ('', ' || true'), ('', ' | true'), ('# ', '')]:
            command = 'node scripts/ci/e2ee.mjs'
            with self.assertRaises(ValueError):
                contract.validate(self.workflow, self.makefile.replace('\t' + command, '\t' + prefix + command + suffix))

    def test_make_target_propagates_failure(self):
        for failure in ('node', 'cargo', None):
            code, trace = self.execute('', failure, self.makefile)
            self.assertEqual(code, 0 if failure is None else 2)
            self.assertIn('cargo build --locked -p obsyncd', trace)
            self.assertEqual('node scripts/ci/e2ee.mjs' in trace, failure != 'cargo')
        for suppression in ('.IGNORE: e2ee', '.IGNORE:', 'MAKEFLAGS += --ignore-errors'):
            mutant = self.makefile + '\n' + suppression + '\n'
            with self.subTest(suppression=suppression):
                code, trace = self.execute('', 'node', mutant)
                self.assertEqual(code, 0)
                self.assertIn('node scripts/ci/e2ee.mjs', trace)
                with self.assertRaises(ValueError):
                    contract.validate(self.workflow, mutant)

    def test_unsupported_make_declarations_refuse(self):
        for declaration in ('export MAKEFLAGS = -i', 'override MAKEFLAGS := -i', 'GNUMAKEFLAGS += -i',
                            'MFLAGS = -i', 'e2ee: MAKEFLAGS += -i', 'SHELL := /bin/true', '.SHELLFLAGS := -c',
                            'include other.mk', '$(eval MAKEFLAGS += -i)', '.ONESHELL:', 'define bypass'):
            with self.subTest(declaration=declaration), self.assertRaises(ValueError):
                contract.validate(self.workflow, self.makefile + '\n' + declaration + '\n')

    def test_duplicate_make_target_refuses(self):
        mutant = self.makefile + '\ne2ee: plugin\n\ttrue\n'
        with self.assertRaises(ValueError):
            contract.validate(self.workflow, mutant)

    def test_inventory_also_refuses_swallowed_failure(self):
        with tempfile.TemporaryDirectory(prefix='e2ee-invariant-control-') as tmp:
            mutant = Path(tmp, 'pr-gate.yml')
            mutant.write_text(self.workflow.replace('node scripts/ci/e2ee.mjs', 'node scripts/ci/e2ee.mjs || true'))
            result = subprocess.run(['bash', 'scripts/ci/makefile-invariants.sh'], cwd=ROOT,
                                    env={**os.environ, 'WORKFLOW_PATH': str(mutant)}, capture_output=True, text=True, timeout=15)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('e2ee-contract: REFUSE', result.stderr)


if __name__ == '__main__':
    unittest.main()
