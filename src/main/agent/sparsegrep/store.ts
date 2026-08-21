import { existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { sparsegrepDbPath, sparsegrepRoot } from '../indexStoragePaths'

export { sparsegrepRoot, sparsegrepDbPath } from '../indexStoragePaths'

export type SparseGrepStatus = {
  ready: boolean
  fileCount: number
  postingCount: number
  lastIndexedAt: string | null
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      file_hash TEXT NOT NULL,
      mtime_ms INTEGER,
      size_bytes INTEGER
    );
    CREATE TABLE IF NOT EXISTS postings (
      trigram TEXT NOT NULL,
      file_id INTEGER NOT NULL,
      PRIMARY KEY (trigram, file_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_postings_trigram ON postings(trigram);
    CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
  `)
  ensureColumn(db, 'files', 'mtime_ms', 'mtime_ms INTEGER')
  ensureColumn(db, 'files', 'size_bytes', 'size_bytes INTEGER')
}

function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (rows.some((r) => r.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
}

export class SparseGrepStore {
  readonly db: DatabaseSync
  readonly dbPath: string

  private constructor(db: DatabaseSync, dbPath: string) {
    this.db = db
    this.dbPath = dbPath
  }

  static open(workspacePath: string): SparseGrepStore {
    const root = sparsegrepRoot(workspacePath)
    if (!existsSync(root)) mkdirSync(root, { recursive: true })
    return SparseGrepStore.openDbPath(sparsegrepDbPath(workspacePath))
  }

  static openDbPath(dbPath: string): SparseGrepStore {
    const dir = dirname(dbPath)
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA synchronous = NORMAL;')
    // Main + utilityProcess may briefly contend on Windows; wait instead of failing.
    db.exec('PRAGMA busy_timeout = 5000;')
    migrate(db)
    return new SparseGrepStore(db, dbPath)
  }

  static openMemory(): SparseGrepStore {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    return new SparseGrepStore(db, ':memory:')
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value)
  }

  getStatus(): SparseGrepStatus {
    const fileCount = (
      this.db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number }
    ).c
    const postingCount = (
      this.db.prepare('SELECT COUNT(*) AS c FROM postings').get() as { c: number }
    ).c
    return {
      ready: fileCount > 0,
      fileCount,
      postingCount,
      lastIndexedAt: this.getMeta('lastIndexedAt')
    }
  }

  getFileHash(path: string): string | null {
    const row = this.db.prepare('SELECT file_hash AS h FROM files WHERE path = ?').get(path) as
      | { h: string }
      | undefined
    return row?.h ?? null
  }

  getFileStamp(path: string): { hash: string; mtimeMs: number; size: number } | null {
    const row = this.db
      .prepare(
        'SELECT file_hash AS hash, mtime_ms AS mtimeMs, size_bytes AS size FROM files WHERE path = ?'
      )
      .get(path) as { hash: string; mtimeMs: number | null; size: number | null } | undefined
    if (
      !row ||
      row.mtimeMs == null ||
      row.size == null ||
      !Number.isFinite(row.mtimeMs) ||
      !Number.isFinite(row.size)
    ) {
      return null
    }
    return { hash: row.hash, mtimeMs: row.mtimeMs, size: row.size }
  }

  updateFileStamp(path: string, fileHash: string, mtimeMs: number, sizeBytes: number): void {
    this.db
      .prepare('UPDATE files SET file_hash = ?, mtime_ms = ?, size_bytes = ? WHERE path = ?')
      .run(fileHash, mtimeMs, sizeBytes, path)
  }

  getFileId(path: string): number | null {
    const row = this.db.prepare('SELECT id FROM files WHERE path = ?').get(path) as
      | { id: number }
      | undefined
    return row?.id ?? null
  }

  listFilePaths(): string[] {
    const rows = this.db.prepare('SELECT path FROM files').all() as { path: string }[]
    return rows.map((r) => r.path)
  }

  /** Replace all trigram postings for a file. */
  replaceFileTrigrams(
    path: string,
    fileHash: string,
    trigrams: Iterable<string>,
    mtimeMs = 0,
    sizeBytes = 0
  ): void {
    // IMMEDIATE matches CodeIndexStore — deferred BEGIN + read→write upgrade
    // returns SQLITE_BUSY immediately and busy_timeout does not apply.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.getFileId(path)
      if (existing != null) {
        this.db.prepare('DELETE FROM postings WHERE file_id = ?').run(existing)
        this.db
          .prepare('UPDATE files SET file_hash = ?, mtime_ms = ?, size_bytes = ? WHERE id = ?')
          .run(fileHash, mtimeMs, sizeBytes, existing)
      } else {
        this.db
          .prepare('INSERT INTO files(path, file_hash, mtime_ms, size_bytes) VALUES(?, ?, ?, ?)')
          .run(path, fileHash, mtimeMs, sizeBytes)
      }
      const fileId = this.getFileId(path)
      if (fileId == null) throw new Error('sparsegrep: missing file id after upsert')
      const ins = this.db.prepare(
        'INSERT OR IGNORE INTO postings(trigram, file_id) VALUES(?, ?)'
      )
      for (const t of trigrams) {
        ins.run(t, fileId)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw err
    }
  }

  deleteFile(path: string): void {
    const id = this.getFileId(path)
    if (id == null) return
    this.db.prepare('DELETE FROM postings WHERE file_id = ?').run(id)
    this.db.prepare('DELETE FROM files WHERE id = ?').run(id)
  }

  /** Delete every file path not in `seen` in one IMMEDIATE transaction. */
  deleteFilesNotIn(seen: ReadonlySet<string>): number {
    const stale = this.listFilePaths().filter((path) => !seen.has(path))
    if (stale.length === 0) return 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const path of stale) this.deleteFile(path)
      this.db.exec('COMMIT')
      return stale.length
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw err
    }
  }

  /**
   * Intersect posting lists for required trigrams (AND).
   * Returns relative paths. Empty set if any trigram missing.
   */
  filesContainingAllTrigrams(trigrams: Iterable<string>): string[] {
    const list = [...trigrams]
    if (list.length === 0) return []

    // Start from rarest: order by posting count ascending
    const counts = list.map((t) => {
      const c = (
        this.db.prepare('SELECT COUNT(*) AS c FROM postings WHERE trigram = ?').get(t) as {
          c: number
        }
      ).c
      return { t, c }
    })
    counts.sort((a, b) => a.c - b.c)
    if (counts[0]!.c === 0) return []

    let ids: Set<number> | null = null
    for (const { t } of counts) {
      const rows = this.db
        .prepare('SELECT file_id AS id FROM postings WHERE trigram = ?')
        .all(t) as { id: number }[]
      const next = new Set(rows.map((r) => r.id))
      if (ids == null) {
        ids = next
      } else {
        for (const id of [...ids]) {
          if (!next.has(id)) ids.delete(id)
        }
      }
      if (ids.size === 0) return []
    }
    if (!ids || ids.size === 0) return []

    // SQLite default max variable count is often 999 — chunk large IN lists.
    const SQLITE_IN_CHUNK = 500
    const idList = [...ids]
    const paths: string[] = []
    for (let i = 0; i < idList.length; i += SQLITE_IN_CHUNK) {
      const slice = idList.slice(i, i + SQLITE_IN_CHUNK)
      const placeholders = slice.map(() => '?').join(',')
      const pathRows = this.db
        .prepare(`SELECT path FROM files WHERE id IN (${placeholders})`)
        .all(...slice) as { path: string }[]
      for (const row of pathRows) paths.push(row.path)
    }
    return paths
  }
}
