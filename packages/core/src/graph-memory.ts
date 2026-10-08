/** Markdown-only lead memory with bounded reads and append-only, non-symlink writes. */
import { constants } from 'node:fs'
import { mkdir, open, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const noteName = z.string().regex(/^[a-zA-Z0-9_-]+\.md$/)
/** Open a memory folder and expose only flat Markdown notes.
 * @param directory - explicit graph memory directory.
 * @param bytes - maximum complete memory result and appended note bytes.
 * @returns bounded operations anchored to the original directory inode; requires Linux procfs.
 */
export async function graphMemory(
  directory: string, bytes: number,
): Promise<{ read: () => Promise<string>; append: (name: string, text: string) => Promise<string> }> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const root = await realpath(directory)
  if (process.platform !== 'linux') throw new Error('Graph memory requires Linux directory-fd access')
  await using initial = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const identity = await initial.stat()
  const anchor = async () => {
    const dir = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const current = await dir.stat()
      if (await realpath(directory) !== root || await realpath(root) !== root
        || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('Memory directory changed')
      return dir
    } catch (error) { await dir.close(); throw error }
  }
  return {
    async read() {
      await using dir = await anchor()
      const anchored = `/proc/self/fd/${dir.fd}`
      let result = ''
      for (const entry of (await readdir(anchored, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || !noteName.safeParse(entry.name).success) continue
        const file = await open(join(anchored, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const stat = await file.stat()
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > bytes) throw new Error(`Memory note ${entry.name} exceeds the read limit or is linked`)
          const content = await file.readFile('utf8')
          result += `\n## ${entry.name}\n${content}`
          if (Buffer.byteLength(result) > bytes) throw new Error('Memory exceeds the output budget; shorten the notes')
        } finally { await file.close() }
      }
      return result || 'No memory notes yet.'
    },
    async append(name, text) {
      noteName.parse(name)
      if (Buffer.byteLength(text) > bytes) throw new Error('Memory note exceeds the output budget')
      await using dir = await anchor()
      const file = await open(join(`/proc/self/fd/${dir.fd}`, name), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size + Buffer.byteLength(text) + 1 > bytes) throw new Error('Memory note is linked or exceeds the output budget')
        await file.writeFile(`${text}\n`, 'utf8')
        await file.sync()
      } finally { await file.close() }
      return `Appended ${name}`
    },
  }
}
