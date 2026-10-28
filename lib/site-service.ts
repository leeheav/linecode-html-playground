import "server-only"

import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { inflateRawSync } from "node:zlib"
import { parse } from "node-html-parser"

export type SiteStatus = "active" | "review" | "disabled" | "rejected"
export type SiteInputType = "html" | "file" | "zip"
export interface ScanFinding {
  code: string
  file: string
  message: string
}
export interface SiteRecord {
  schemaVersion: 2
  name: string
  status: SiteStatus
  inputType: SiteInputType
  createdAt: string
  expiresAt: string
  disabledAt?: string
  files: string[]
  totalBytes: number
  scan: { result: "passed" | "review"; findings: ScanFinding[] }
}

const ROOT = path.resolve(process.env.SITES_DIR || path.join(process.cwd(), "data", "sites"))
const MAX_UPLOAD = 10 * 1024 * 1024
const MAX_UNPACKED = 30 * 1024 * 1024
const MAX_FILE = 5 * 1024 * 1024
const MAX_FILES = 100
const retentionSetting = Number(process.env.SITE_RETENTION_DAYS || 30)
const RETENTION_DAYS = Number.isInteger(retentionSetting) && retentionSetting >= 1 && retentionSetting <= 365
  ? retentionSetting
  : 30
const ALLOWED_HOURS = new Set([1, 24, 72, 168, 720])
const ALLOWED_EXT = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".txt", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".otf"])
const RESERVED_NAMES = new Set(["api", "ldpadmin", "healthz", "_next", "favicon.ico", "robots.txt", "sitemap.xml"])
const RATE_WINDOW_MS = 60 * 60 * 1000
const MAX_CREATES_PER_WINDOW = 10
const createAttempts = new Map<string, number[]>()
const maintenanceState = globalThis as typeof globalThis & { __linecodeSiteMaintenance?: ReturnType<typeof setInterval> }
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
}

export class SiteInputError extends Error {}

function ensureMaintenance(): void {
  if (maintenanceState.__linecodeSiteMaintenance) return
  const timer = setInterval(() => {
    void purgeRetainedSites().catch((error) => console.error("Site cleanup failed", error))
  }, 60 * 60 * 1000)
  timer.unref()
  maintenanceState.__linecodeSiteMaintenance = timer
}

export async function purgeRetainedSites(now = Date.now()): Promise<number> {
  const sites = await listSites()
  let removed = 0
  for (const site of sites) {
    const expiresAt = Date.parse(site.expiresAt)
    const disabledAt = site.disabledAt ? Date.parse(site.disabledAt) : Number.POSITIVE_INFINITY
    const inactiveAt = Math.min(expiresAt, disabledAt)
    if (Number.isFinite(inactiveAt) && now >= inactiveAt + RETENTION_DAYS * 24 * 3600_000) {
      if (await purgeSite(site.name)) removed++
    }
  }
  return removed
}

export function checkCreateRateLimit(client: string): boolean {
  const now = Date.now()
  const recent = (createAttempts.get(client) || []).filter((time) => now - time < RATE_WINDOW_MS)
  if (recent.length >= MAX_CREATES_PER_WINDOW) return false
  recent.push(now)
  createAttempts.set(client, recent)
  if (createAttempts.size > 10000) for (const [key, times] of createAttempts) if (times.every((time) => now - time >= RATE_WINDOW_MS)) createAttempts.delete(key)
  return true
}

export function isValidSiteName(name: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(name)
}

export function isValidSiteFilePath(value: string): boolean {
  if (!value || value.length > 240 || value.includes("\\") || value.includes("\0") || value.startsWith("/") || value.startsWith(".") || /(^|\/)\.{1,2}(\/|$)/.test(value)) return false
  if (value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || /[<>:"|?*]/.test(part))) return false
  return ALLOWED_EXT.has(path.posix.extname(value).toLowerCase())
}

function dir(name: string): string { return path.join(ROOT, name) }
function metaPath(name: string): string { return path.join(dir(name), "site.json") }
function filePath(name: string, file: string): string { return path.join(dir(name), "files", ...file.split("/")) }
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT" }

async function isUnavailable(name: string): Promise<boolean> {
  if (RESERVED_NAMES.has(name.toLowerCase())) return true
  try { await fs.access(path.join(ROOT, `${name}.html`)); return true }
  catch (error) { if (!missing(error)) throw error }
  return false
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function safeDate(value: string): string {
  const time = Date.parse(value)
  if (!Number.isFinite(time) || time <= Date.now() || time > Date.now() + 720 * 3600_000 + 60_000) throw new SiteInputError("失效时间无效")
  return new Date(time).toISOString()
}

function expiration(expiresInHours?: number, expiresAt?: string): string {
  if (expiresAt) return safeDate(expiresAt)
  const hours = expiresInHours ?? 168
  if (!ALLOWED_HOURS.has(hours)) throw new SiteInputError("失效时间选项无效")
  return new Date(Date.now() + hours * 3600_000).toISOString()
}

function normalizeHtml(input: Buffer): void {
  const html = input.toString("utf8")
  if (!/<html[\s>]/i.test(html) || !/<body[\s>]/i.test(html)) throw new SiteInputError("HTML 必须包含 html 和 body 标签")
}

function scan(files: Map<string, Buffer>): ScanFinding[] {
  const findings: ScanFinding[] = []
  for (const [file, body] of files) {
    if (!/\.html?$/i.test(file)) continue
    const html = body.toString("utf8")
    const root = parse(html)
    for (const form of root.querySelectorAll("form")) {
      const action = form.getAttribute("action") || ""
      if (/^https?:\/\//i.test(action)) findings.push({ code: "external-form", file, message: "表单将数据提交到外部地址" })
    }
    if (root.querySelector('input[type="password"]')) findings.push({ code: "password-field", file, message: "页面包含密码输入框" })
    for (const meta of root.querySelectorAll("meta")) {
      if ((meta.getAttribute("http-equiv") || "").toLowerCase() === "refresh") findings.push({ code: "redirect", file, message: "页面包含自动跳转" })
    }
    if (/\b(?:eval|Function)\s*\(/.test(html)) findings.push({ code: "dynamic-code", file, message: "页面包含动态执行脚本" })
  }
  return findings
}

function readZip(data: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  if (data.length < 22) throw new SiteInputError("ZIP 格式无效")
  let end = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) { end = i; break }
  }
  if (end < 0) throw new SiteInputError("ZIP 目录无效")
  const count = data.readUInt16LE(end + 10)
  if (data.readUInt16LE(end + 4) !== 0 || data.readUInt16LE(end + 6) !== 0 || data.readUInt16LE(end + 8) !== count || count === 0xffff) throw new SiteInputError("不支持多卷或 ZIP64 压缩包")
  const centralSize = data.readUInt32LE(end + 12)
  let cursor = data.readUInt32LE(end + 16)
  if (count > MAX_FILES || centralSize === 0xffffffff || cursor === 0xffffffff || centralSize > data.length || cursor + centralSize > end) throw new SiteInputError("ZIP 文件数量或目录超限")
  const centralEnd = cursor + centralSize
  let total = 0
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > data.length || data.readUInt32LE(cursor) !== 0x02014b50) throw new SiteInputError("ZIP 目录损坏")
    const flags = data.readUInt16LE(cursor + 8)
    const method = data.readUInt16LE(cursor + 10)
    const expectedCrc = data.readUInt32LE(cursor + 16)
    const packed = data.readUInt32LE(cursor + 20)
    const unpacked = data.readUInt32LE(cursor + 24)
    const nameLength = data.readUInt16LE(cursor + 28)
    const extraLength = data.readUInt16LE(cursor + 30)
    const commentLength = data.readUInt16LE(cursor + 32)
    const externalAttrs = data.readUInt32LE(cursor + 38)
    const offset = data.readUInt32LE(cursor + 42)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > centralEnd || flags & ~0x800 || (method !== 0 && method !== 8) || unpacked === 0xffffffff || packed === 0xffffffff || unpacked > MAX_FILE || packed > MAX_UPLOAD) throw new SiteInputError("ZIP 包含不支持或过大的文件")
    const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8")
    cursor = next
    if (name.endsWith("/")) continue
    if (!isValidSiteFilePath(name) || files.has(name) || ((externalAttrs >>> 16) & 0xf000) === 0xa000) throw new SiteInputError("ZIP 包含不安全的文件路径或类型")
    total += unpacked
    if (total > MAX_UNPACKED) throw new SiteInputError("ZIP 解压后体积超限")
    if (offset === 0xffffffff || offset + 30 > data.length || data.readUInt32LE(offset) !== 0x04034b50) throw new SiteInputError("ZIP 文件头损坏")
    if (data.readUInt16LE(offset + 6) !== flags || data.readUInt16LE(offset + 8) !== method || data.readUInt32LE(offset + 14) !== expectedCrc || data.readUInt32LE(offset + 18) !== packed || data.readUInt32LE(offset + 22) !== unpacked) throw new SiteInputError("ZIP 文件头不一致")
    const localName = data.readUInt16LE(offset + 26)
    const localExtra = data.readUInt16LE(offset + 28)
    if (data.subarray(offset + 30, offset + 30 + localName).toString("utf8") !== name) throw new SiteInputError("ZIP 文件名不一致")
    const begin = offset + 30 + localName + localExtra
    if (begin + packed > data.length) throw new SiteInputError("ZIP 文件数据损坏")
    const compressed = data.subarray(begin, begin + packed)
    let body: Buffer
    try { body = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_FILE + 1 }) }
    catch { throw new SiteInputError("ZIP 解压失败") }
    if (body.length !== unpacked || crc32(body) !== expectedCrc) throw new SiteInputError("ZIP 文件校验失败")
    files.set(name, body)
  }
  if (cursor !== centralEnd) throw new SiteInputError("ZIP 目录长度不匹配")
  if (!files.has("index.html")) throw new SiteInputError("ZIP 根目录必须包含 index.html")
  return files
}

export async function createSiteFromInput(input: {
  name?: string
  html?: string
  file?: { name: string; bytes: Buffer }
  expiresInHours?: number
  expiresAt?: string
}): Promise<{ site: SiteRecord; generatedName: boolean }> {
  ensureMaintenance()
  if (!!input.html === !!input.file) throw new SiteInputError("请提供 HTML 内容或一个上传文件")
  const expiresAt = expiration(input.expiresInHours, input.expiresAt)
  const files = new Map<string, Buffer>()
  let inputType: SiteInputType = "html"
  if (input.html !== undefined) {
    const bytes = Buffer.from(input.html, "utf8")
    if (!bytes.length || bytes.length > MAX_FILE) throw new SiteInputError("HTML 内容为空或超过 5 MB")
    files.set("index.html", bytes)
  } else if (input.file) {
    const { name, bytes } = input.file
    if (!bytes.length || bytes.length > MAX_UPLOAD) throw new SiteInputError("上传文件为空或超过 10 MB")
    const ext = path.extname(name).toLowerCase()
    if (ext === ".zip") { inputType = "zip"; for (const entry of readZip(bytes)) files.set(...entry) }
    else if (ext === ".html" || ext === ".htm") { inputType = "file"; files.set("index.html", bytes) }
    else throw new SiteInputError("只支持 HTML 或 ZIP 文件")
  }
  normalizeHtml(files.get("index.html")!)
  const totalBytes = [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0)
  const findings = scan(files)
  const status: SiteStatus = findings.length ? "review" : "active"
  const requested = (input.name || "").trim()
  if (requested && !isValidSiteName(requested)) throw new SiteInputError("站点名称只能包含字母、数字、连字符和下划线")
  await fs.mkdir(ROOT, { recursive: true })
  await purgeRetainedSites()
  const existing = await listSites()
  if (existing.length >= 1000 || existing.reduce((sum, site) => sum + (site.totalBytes || 0), 0) + totalBytes > 1024 * 1024 * 1024) {
    throw new SiteInputError("站点存储空间已满，请稍后再试")
  }
  let generatedName = !requested
  let name = requested
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!name) name = randomBytes(6).toString("base64url")
    if (await isUnavailable(name)) { name = ""; generatedName = true; continue }
    try { await fs.mkdir(dir(name)) }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") { name = ""; generatedName = true; continue }
      throw error
    }
    const now = new Date().toISOString()
    const site: SiteRecord = { schemaVersion: 2, name, status, inputType, createdAt: now, expiresAt, files: [...files.keys()], totalBytes, scan: { result: findings.length ? "review" : "passed", findings } }
    try {
      for (const [file, body] of files) {
        const target = filePath(name, file)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, body, { flag: "wx" })
      }
      await fs.writeFile(metaPath(name), JSON.stringify(site, null, 2), { flag: "wx" })
      return { site, generatedName }
    } catch (error) { await fs.rm(dir(name), { recursive: true, force: true }); throw error }
  }
  throw new Error("无法分配站点名称")
}

export async function getSite(name: string): Promise<SiteRecord | null> {
  ensureMaintenance()
  if (!isValidSiteName(name)) return null
  try {
    const site = JSON.parse(await fs.readFile(metaPath(name), "utf8")) as SiteRecord
    if (site.schemaVersion !== 2 || site.name !== name || !Array.isArray(site.files)) throw new Error("站点元数据损坏")
    return site
  } catch (error) { if (missing(error)) return null; throw error }
}

export async function listSites(): Promise<SiteRecord[]> {
  await fs.mkdir(ROOT, { recursive: true })
  const entries = await fs.readdir(ROOT, { withFileTypes: true })
  const sites = await Promise.all(entries.filter((entry) => entry.isDirectory() && isValidSiteName(entry.name)).map((entry) => getSite(entry.name)))
  return sites.filter((site): site is SiteRecord => site !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function readSiteFile(name: string, requestedPath: string): Promise<{ site: SiteRecord; body: Buffer; contentType: string } | null> {
  const site = await getSite(name)
  const file = requestedPath || "index.html"
  if (!site || site.status !== "active" || Date.now() >= Date.parse(site.expiresAt) || !isValidSiteFilePath(file) || !site.files.includes(file)) return null
  try { return { site, body: await fs.readFile(filePath(name, file)), contentType: MIME[path.posix.extname(file).toLowerCase()] || "application/octet-stream" } }
  catch (error) { if (missing(error)) return null; throw error }
}

export async function readSiteFileForAdmin(name: string, requestedPath = "index.html"): Promise<{ site: SiteRecord; body: Buffer; contentType: string } | null> {
  const site = await getSite(name)
  if (!site || !isValidSiteFilePath(requestedPath) || !site.files.includes(requestedPath)) return null
  try { return { site, body: await fs.readFile(filePath(name, requestedPath)), contentType: MIME[path.posix.extname(requestedPath).toLowerCase()] || "application/octet-stream" } }
  catch (error) { if (missing(error)) return null; throw error }
}

export async function renameSiteRecord(oldName: string, newName: string): Promise<boolean> {
  if (!isValidSiteName(oldName) || !isValidSiteName(newName) || oldName === newName || await isUnavailable(newName)) return false
  const site = await getSite(oldName)
  if (!site) return false
  try { await fs.access(dir(newName)); return false }
  catch (error) { if (!missing(error)) throw error }
  await fs.rename(dir(oldName), dir(newName))
  site.name = newName
  try { await writeSite(site) }
  catch (error) {
    await fs.rename(dir(newName), dir(oldName)).catch(() => undefined)
    throw error
  }
  return true
}

async function writeSite(site: SiteRecord): Promise<void> {
  const temporary = metaPath(site.name) + "." + randomBytes(6).toString("hex") + ".tmp"
  await fs.writeFile(temporary, JSON.stringify(site, null, 2), { flag: "wx" })
  await fs.rename(temporary, metaPath(site.name))
}

export async function setSiteDisabled(name: string, disabled: boolean): Promise<boolean> {
  const site = await getSite(name)
  if (!site || site.status === "rejected") return false
  site.status = disabled ? "disabled" : (site.scan.result === "review" ? "review" : "active")
  site.disabledAt = disabled ? new Date().toISOString() : undefined
  await writeSite(site)
  return true
}

export async function setSiteStatus(name: string, status: "active" | "review" | "disabled"): Promise<boolean> {
  const site = await getSite(name)
  if (!site) return false
  site.status = status
  site.disabledAt = status === "disabled" ? new Date().toISOString() : undefined
  await writeSite(site)
  return true
}

export async function setSiteExpiry(name: string, expiresAt: string): Promise<boolean> {
  const site = await getSite(name)
  if (!site) return false
  const time = Date.parse(expiresAt)
  if (!Number.isFinite(time) || time <= Date.now()) throw new SiteInputError("失效时间必须晚于当前时间")
  site.expiresAt = new Date(time).toISOString()
  await writeSite(site)
  return true
}

export async function purgeSite(name: string): Promise<boolean> {
  if (!await getSite(name)) return false
  await fs.rm(dir(name), { recursive: true, force: true })
  return true
}
