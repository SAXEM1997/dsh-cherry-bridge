import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

/**
 * Crash-durable atomic replacement of one small UTF-8 file.
 *
 * This is a deliberate REPLICA of `deviceStore.ts`'s `persistArchive` sequence
 * (`.tmp` + fsync + chmod 0600 + rename), not a shared helper extracted from it:
 * the device archive is an existing subsystem the scope work must not touch
 * (spec §3's 永不 non-goal), so the two writers stay independent even though the
 * sequence is the same. A future fix to one must be applied to the other.
 *
 * Why each step is here, in order:
 *
 *  - `mkdirSync(dirname(file))` — the file's directory is the plugin's own data
 *    directory and may not exist on first run; the sequence must not fail there.
 *  - `openSync(temp, 'w', mode)` + `writeSync` + `fsyncSync` — the bytes reach
 *    the disk before the name switches, so a crash cannot leave a rename that
 *    points at unwritten data.
 *  - `closeSync` in `finally` — the descriptor is released even if the write or
 *    the fsync throws.
 *  - `chmodSync(temp, mode)` — `mode` on `open` only applies when the file is
 *    CREATED and is masked by the process umask, while `rename` carries the temp
 *    file's mode onto the target: chmod'ing the temp explicitly makes both
 *    halves of the swap exactly `mode` and re-tightens a pre-existing looser
 *    file instead of leaving it as it was.
 *  - `renameSync(temp, file)` — the switch itself: a reader sees either the
 *    complete old file or the complete new one, never a truncated one. On
 *    failure the temp file is dropped (best effort) so a half-written file is
 *    not left for the next reader to trip over, and the original error is what
 *    propagates — the target was never touched.
 *
 * Synchronous by design: the scope document's write path must complete inside
 * one uninterruptible critical section (no `await` between validating the
 * expected revision and committing the write, spec §6.3).
 */
export function writeFileAtomicSync(file: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true })

  const temp = `${file}.tmp`
  const fd = openSync(temp, 'w', mode)
  try {
    writeSync(fd, text, undefined, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(temp, mode)

  try {
    renameSync(temp, file)
  } catch (error) {
    // Never leave a half-written temp file behind: the target is untouched, so
    // dropping the temp is safe.
    try {
      unlinkSync(temp)
    } catch {
      // Best effort only — the rename failure below is the real error.
    }
    throw error
  }
}
