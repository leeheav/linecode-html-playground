import "server-only"

import fs from "fs/promises"
import path from "path"

export const SITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

export interface SiteMetadata {
  schemaVersion: 1
  createdAt: string
  expiresAt: string
}

export interface StoredSite {
  name: string
  html: string
  createdAt: Date
  expiresAt: Date
  expired: boolean
}

export type StoredSiteSummary = Omit<StoredSite, "html">

const SITES_DIR = process.env.SITES_DIR
  ? path.resolve(process.env.SITES_DIR)
  : path.join(process.cwd(), "data", "sites")

function htmlPath(name: string): string {
  return path.join(SITES_DIR, `${name}.html`)
}

function metadataPath(name: string): string {
  return path.join(SITES_DIR, `${name}.meta.json`)
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  )
}

function isExistingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  )
}

function parseMetadata(raw: string): SiteMetadata {
  const value = JSON.parse(raw) as Partial<SiteMetadata>
  const createdAt = Date.parse(value.createdAt || "")
  const expiresAt = Date.parse(value.expiresAt || "")

  if (
    value.schemaVersion !== 1 ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= createdAt
  ) {
    throw new Error("Invalid site metadata")
  }

  return value as SiteMetadata
}

async function readSiteSummary(name: string): Promise<StoredSiteSummary> {
  const metadata = parseMetadata(await fs.readFile(metadataPath(name), "utf8"))
  const createdAt = new Date(metadata.createdAt)
  const expiresAt = new Date(metadata.expiresAt)
  return {
    name,
    createdAt,
    expiresAt,
    expired: isSiteExpired(expiresAt),
  }
}

export function isValidSiteName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name)
}

export function isSiteExpired(expiresAt: Date, now = Date.now()): boolean {
  return now >= expiresAt.getTime()
}

export async function ensureSitesDirectory(): Promise<void> {
  await fs.mkdir(SITES_DIR, { recursive: true })
}

export async function isSiteNameTaken(name: string): Promise<boolean> {
  if (!isValidSiteName(name)) return false

  await ensureSitesDirectory()
  try {
    await fs.access(htmlPath(name))
    return true
  } catch (error) {
    if (isMissingFileError(error)) return false
    throw error
  }
}

export async function createStoredSite(
  name: string,
  html: string,
  createdAt = new Date(),
): Promise<boolean> {
  if (!isValidSiteName(name)) throw new Error("Invalid site name")

  await ensureSitesDirectory()
  const expiresAt = new Date(createdAt.getTime() + SITE_LIFETIME_MS)
  const metadata: SiteMetadata = {
    schemaVersion: 1,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  }

  try {
    await fs.writeFile(htmlPath(name), html, { encoding: "utf8", flag: "wx" })
  } catch (error) {
    if (isExistingFileError(error)) return false
    throw error
  }

  try {
    await fs.writeFile(metadataPath(name), JSON.stringify(metadata, null, 2), {
      encoding: "utf8",
      flag: "wx",
    })
  } catch (error) {
    await fs.unlink(htmlPath(name)).catch(() => undefined)
    if (isExistingFileError(error)) return false
    throw error
  }

  return true
}

export async function readStoredSite(name: string): Promise<StoredSite | null> {
  if (!isValidSiteName(name)) return null

  await ensureSitesDirectory()
  try {
    const [html, summary] = await Promise.all([
      fs.readFile(htmlPath(name), "utf8"),
      readSiteSummary(name),
    ])

    return {
      ...summary,
      html,
    }
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
}

export async function listStoredSites(): Promise<StoredSiteSummary[]> {
  await ensureSitesDirectory()
  const files = await fs.readdir(SITES_DIR)
  const names = files
    .filter((file) => file.endsWith(".html"))
    .map((file) => file.replace(/\.html$/, ""))
    .filter(isValidSiteName)

  const sites = await Promise.all(names.map(async (name) => {
    try {
      return await readSiteSummary(name)
    } catch (error) {
      console.error(`Failed to read stored site metadata: ${name}`, error)
      return null
    }
  }))
  return sites
    .filter((site): site is StoredSiteSummary => site !== null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

export async function deleteStoredSite(name: string): Promise<boolean> {
  if (!isValidSiteName(name)) return false

  await ensureSitesDirectory()
  try {
    await fs.unlink(htmlPath(name))
  } catch (error) {
    if (isMissingFileError(error)) return false
    throw error
  }

  await fs.unlink(metadataPath(name)).catch((error: unknown) => {
    if (!isMissingFileError(error)) throw error
  })
  return true
}

export async function renameStoredSite(oldName: string, newName: string): Promise<boolean> {
  if (!isValidSiteName(oldName) || !isValidSiteName(newName)) return false
  if (oldName === newName) return false

  await ensureSitesDirectory()
  if (await isSiteNameTaken(newName)) return false

  await fs.rename(htmlPath(oldName), htmlPath(newName))
  try {
    await fs.rename(metadataPath(oldName), metadataPath(newName))
  } catch (error) {
    await fs.rename(htmlPath(newName), htmlPath(oldName)).catch(() => undefined)
    throw error
  }
  return true
}
