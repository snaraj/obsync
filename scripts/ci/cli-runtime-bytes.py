"""Match CI's runtime to Node 26.10.0's independently verified distribution.

These executable hashes were read from official archives after verifying
SHASUMS256.txt.asc with Node's pinned release keyring (see cli/README.md).
This proves executable bytes; the CI image supplies trusted OS libraries.
"""
import hashlib
import json
import platform
import shutil
import sys
from pathlib import Path

EXPECTED = {
    ('win32', 'AMD64'): 'cea6ac365f9bb9586dafd2084d996e092e7d3e7d07ab52d1f76bf53d1fca9bc4',
    ('linux', 'x86_64'): 'ab9c8eecf9f82d6693cdc3accced17034065c8d96213b0aa76a7e803d20ae1da',
    ('linux', 'aarch64'): '71b004f18a82f3ea8f26109798564a12e5e4c7989a4c35b93851830b5815dd03',
    ('darwin', 'arm64'): '56d28b39a8048f0cd1af7ad7e09f6cbe1c04439b6dfeb6c8d9090c082af60861',
}
target = (sys.platform, platform.machine())
selected = shutil.which('node')
if target not in EXPECTED or selected is None:
    raise SystemExit('The native target or selected runtime is unsupported.')
with Path(selected).open('rb') as source:
    digest = hashlib.file_digest(source, 'sha256').hexdigest()
if digest != EXPECTED[target]:
    raise SystemExit('The runtime differs from the independently verified Node archive.')
print(json.dumps(dict(event='cli_runtime_bytes', platform=target[0], architecture=target[1],
                     executable_sha256=digest, result='pass')))
