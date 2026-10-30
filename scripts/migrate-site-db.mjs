import { DatabaseSync } from "node:sqlite"
import { mkdir, readFile, readdir } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(process.env.SITES_DIR || path.join(process.cwd(), "data", "sites"))
const dbPath = path.resolve(process.env.SITE_DB_PATH || path.join(root, "sites.db"))
await mkdir(root, { recursive: true })
await mkdir(path.dirname(dbPath), { recursive: true })

const db = new DatabaseSync(dbPath)
try {
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sites (
      name TEXT PRIMARY KEY,
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      total_bytes INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS create_rate_limits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_create_rate_limits_client_time ON create_rate_limits(client, created_at);
    CREATE TABLE IF NOT EXISTS admin_login_attempts (
      client TEXT PRIMARY KEY,
      failures INTEGER NOT NULL,
      first_failure_at INTEGER NOT NULL,
      blocked_until INTEGER NOT NULL
    );
  `)
  const insert = db.prepare("INSERT OR IGNORE INTO sites (name, record_json, created_at, total_bytes) VALUES (?, ?, ?, ?)")
  let imported = 0
  let existing = 0
  let invalid = 0
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.name)) continue
    let raw
    try { raw = await readFile(path.join(root, entry.name, "site.json"), "utf8") }
    catch (error) {
      if (error?.code === "ENOENT") continue
      throw error
    }
    let site
    try { site = JSON.parse(raw) }
    catch { invalid++; console.error(`无效 JSON：${entry.name}`); continue }
    if (site.schemaVersion !== 2 || site.name !== entry.name || !Array.isArray(site.files) || typeof site.createdAt !== "string" || !Number.isSafeInteger(site.totalBytes) || site.totalBytes < 0) {
      invalid++
      console.error(`无效元数据：${entry.name}`)
      continue
    }
    const result = insert.run(site.name, JSON.stringify(site), site.createdAt, site.totalBytes)
    if (result.changes) imported++
    else existing++
  }
  console.log(`SQLite 迁移完成：新增 ${imported}，已有 ${existing}，无效 ${invalid}。数据库：${dbPath}`)
  if (invalid) process.exitCode = 1
} finally {
  db.close()
}
