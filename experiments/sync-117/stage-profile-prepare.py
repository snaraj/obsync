#!/usr/bin/env python3
"""Apply measurement-only hooks to an explicitly disposable baseline checkout."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
if subprocess.check_output(['git', '-C', str(root), 'status', '--porcelain']):
    raise SystemExit('profiling requires a clean disposable checkout')
files = {}
def patch(name, replacements):
    path = root / name
    original = text = path.read_text()
    for before, after, count in replacements:
        if text.count(before) != count:
            raise ValueError('profiling anchor changed: ' + name)
        text = text.replace(before, after)
    path.write_text(text)
    files[name] = {'before': hashlib.sha256(original.encode()).hexdigest(),
                   'after': hashlib.sha256(text.encode()).hexdigest()}

patch('plugin/src/chunker.ts', [
    ('export async function* chunkStream(source: ByteSource): AsyncGenerator<Bytes> {', '''function labStages(): { __obsyncStages?: { cutMs: number; cuts: number } } | undefined {
  return typeof window === "undefined" ? undefined : window as unknown as { __obsyncStages?: { cutMs: number; cuts: number } };
}

export async function* chunkStream(source: ByteSource): AsyncGenerator<Bytes> {''', 1),
    ('    const cut = cutPoint(window, gear);', '''    const labAt = performance.now();
    const cut = cutPoint(window, gear);
    const lab = labStages();
    if (lab?.__obsyncStages) { lab.__obsyncStages.cutMs += performance.now() - labAt; lab.__obsyncStages.cuts++; }''', 1),
])
patch('crates/obsyncd/src/storage/blobs.rs', [
    ('    let mut total: u64 = 0;\n    loop {', '    let mut total: u64 = 0;\n    let (mut read_ns, mut hash_ns, mut write_ns) = (0u128, 0u128, 0u128);\n    loop {\n        let lab_at = std::time::Instant::now();', 1),
    ('        hasher.update(&buf[..read]);', '        read_ns += lab_at.elapsed().as_nanos();\n        let lab_at = std::time::Instant::now();\n        hasher.update(&buf[..read]);\n        hash_ns += lab_at.elapsed().as_nanos();', 1),
    ('            file.write_all(&buf[..read])?;', '            let lab_at = std::time::Instant::now();\n            file.write_all(&buf[..read])?;\n            write_ns += lab_at.elapsed().as_nanos();', 1),
    ('    Ok((hasher.finalize(), total))', '''    let lab_at = std::time::Instant::now();
    let digest = hasher.finalize();
    hash_ns += lab_at.elapsed().as_nanos();
    eprintln!(
        "LAB_STAGE blob bytes={total} read_ns={read_ns} hash_ns={hash_ns} write_ns={write_ns}"
    );
    Ok((digest, total))''', 1),
    ('        file.sync_all()?;\n        drop(file);', '''        let lab_at = std::time::Instant::now();
        file.sync_all()?;
        eprintln!("LAB_STAGE file_fsync ns={}", lab_at.elapsed().as_nanos());
        drop(file);''', 1),
    ('            let flushed = handle.sync_all();', '''            let lab_at = std::time::Instant::now();
            let flushed = handle.sync_all();
            eprintln!("LAB_STAGE dir_fsync ns={}", lab_at.elapsed().as_nanos());''', 1),
])
patch('crates/obsyncd/src/api/nonce_log.rs', [
    ('        let wrote = self.file.write_all(text.as_bytes());', '''        let wrote = {
            let lab_at = std::time::Instant::now();
            let outcome = self.file.write_all(text.as_bytes());
            eprintln!("LAB_STAGE nonce_write ns={}", lab_at.elapsed().as_nanos());
            outcome
        };''', 1),
    ('        self.file.sync_all()?;\n        self.syncs += 1;', '''        let lab_at = std::time::Instant::now();
        self.file.sync_all()?;
        eprintln!("LAB_STAGE nonce_fsync ns={}", lab_at.elapsed().as_nanos());
        self.syncs += 1;''', 1),
])
patch('crates/obsyncd/src/storage/journal.rs', [
    ('        file.write_all(bytes)\n', '''        let lab_at = std::time::Instant::now();
        let outcome = file.write_all(bytes);
        eprintln!("LAB_STAGE journal_write ns={}", lab_at.elapsed().as_nanos());
        outcome
''', 1),
    ('        self.segment.as_ref().expect("a segment is open").sync_all()', '''        let lab_at = std::time::Instant::now();
        let outcome = self.segment.as_ref().expect("a segment is open").sync_all();
        eprintln!("LAB_STAGE journal_fsync ns={}", lab_at.elapsed().as_nanos());
        outcome''', 2),
])
print(json.dumps({'source': subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip(),
                  'purpose': 'measurement only; never distribute or merge', 'files': files}, indent=2))
