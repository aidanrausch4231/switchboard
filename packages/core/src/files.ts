/** Canonical path checks and non-following workspace change detection. */
import { access, lstat, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { inside } from './recipe.ts'

/** Resolve existing ancestors without allowing symlink escapes through missing leaves.
 * @param path - absolute candidate.
 * @returns canonical absolute path, including any missing suffix.
 */
export async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path) } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(await canonicalPath(parent), path.slice(parent.length).replace(/^[/\\]+/, ''))
  }
}

/** Verify scope path existence/readability or creatable writable ancestor.
 * @param cwd - existing root directory.
 * @param path - literal scope path.
 * @param writable - allow missing leaves for write grants.
 */
export async function checkPath(cwd: string, path: string, writable: boolean): Promise<void> {
  if (!inside(cwd, path)) throw new Error(`Path is outside cwd or contains parent traversal: ${path}`)
  const root = await realpath(cwd)
  const candidate = await canonicalPath(resolve(cwd, path))
  if (!inside(root, candidate)) throw new Error(`Path escapes cwd through a symlink: ${path}`)
  let existing = candidate
  if (writable) {
    while (true) {
      try { await stat(existing); break } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        existing = dirname(existing)
      }
    }
  }
  await access(existing, writable ? constants.W_OK : constants.R_OK)
}

/** Locate a Git worktree marker without invoking Git.
 * @param cwd - workspace root.
 * @returns containing worktree root, or undefined.
 */
export async function gitRoot(cwd: string): Promise<string | undefined> {
  let dir = resolve(cwd)
  while (true) {
    try { await lstat(join(dir, '.git')); return dir } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    if (dirname(dir) === dir) return undefined
    dir = dirname(dir)
  }
}

/** Inventory file metadata and directory modes without following symlinks or reading contents.
 * @param cwd - workspace root (includes ignored/untracked files and Git metadata).
 * @returns relative file/directory identities, including cwd and symlink targets; directory timestamps are excluded.
 */
export async function snapshotFiles(cwd: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  async function walk(dir: string): Promise<void> {
    files.set(dir || '.', `directory:${(await lstat(join(cwd, dir))).mode}`)
    for (const entry of await readdir(join(cwd, dir), { withFileTypes: true })) {
      const key = join(dir, entry.name)
      const path = join(cwd, key)
      const info = await lstat(path)
      if (info.isDirectory()) { await walk(key); continue }
      files.set(key, info.isSymbolicLink() ? `link:${await readlink(path)}` : `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.mode}`)
    }
  }
  await walk('')
  return files
}

/** Detect additions, modifications and deletions outside literal writable paths.
 * @param cwd - workspace root.
 * @param write - writable files or directories.
 * @param before - inventory before the block.
 * @param after - inventory after all copies stop.
 * @returns sorted out-of-scope paths; files are never reverted automatically.
 */
export function writeViolations(cwd: string, write: string[], before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter(path =>
    before.get(path) !== after.get(path)
    && !write.some(grant => inside(resolve(cwd, grant), resolve(cwd, path))),
  ).sort()
}
