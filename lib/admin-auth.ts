import { getSiteDatabase } from "./site-service"
import "server-only"

import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto"
import { cookies, headers } from "next/headers"

const SESSION_COOKIE = "linecode_admin_session"
const SESSION_TTL_SECONDS = 60 * 60
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_BLOCK_MS = 15 * 60 * 1000
const MAX_LOGIN_FAILURES = 5

interface SessionPayload {
  version: 1
  issuedAt: number
  expiresAt: number
  nonce: string
}

interface LoginAttempt {
  failures: number
  firstFailureAt: number
  blockedUntil: number
}

const globalAuthState = globalThis as typeof globalThis & {
  __linecodeAdminLoginAttempts?: Map<string, LoginAttempt>
}

const loginAttempts =
  globalAuthState.__linecodeAdminLoginAttempts ?? new Map<string, LoginAttempt>()

globalAuthState.__linecodeAdminLoginAttempts = loginAttempts

function secureCompare(value: string, expected: string): boolean {
  const valueHash = createHash("sha256").update(value).digest()
  const expectedHash = createHash("sha256").update(expected).digest()
  return timingSafeEqual(valueHash, expectedHash)
}

function getAdminPassword(): string | null {
  const password = process.env.ADMIN_PASSWORD
  return password && password.length >= 12 ? password : null
}

function getAdminUsername(): string {
  return process.env.ADMIN_USERNAME?.trim() || "admin"
}

function getSessionSecret(): string | null {
  const configuredSecret = process.env.ADMIN_SESSION_SECRET?.trim()
  if (configuredSecret && configuredSecret.length >= 32) return configuredSecret

  if (process.env.NODE_ENV === "production") return null

  const password = getAdminPassword()
  if (!password) return null

  // Backwards-compatible fallback. Production should configure a separate secret.
  return createHash("sha256")
    .update(`linecode-admin-session:${password}`)
    .digest("hex")
}

function signPayload(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url")
}

function createSessionToken(): string | null {
  const secret = getSessionSecret()
  if (!secret) return null

  const now = Math.floor(Date.now() / 1000)
  const payload: SessionPayload = {
    version: 1,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_SECONDS,
    nonce: randomBytes(16).toString("base64url"),
  }
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${encodedPayload}.${signPayload(encodedPayload, secret)}`
}

function verifySessionToken(token: string): boolean {
  const secret = getSessionSecret()
  if (!secret) return false

  const [encodedPayload, suppliedSignature, ...extraParts] = token.split(".")
  if (!encodedPayload || !suppliedSignature || extraParts.length > 0) return false

  const expectedSignature = signPayload(encodedPayload, secret)
  if (!secureCompare(suppliedSignature, expectedSignature)) return false

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<SessionPayload>
    const now = Math.floor(Date.now() / 1000)

    return (
      payload.version === 1 &&
      typeof payload.issuedAt === "number" &&
      payload.issuedAt <= now + 60 &&
      typeof payload.expiresAt === "number" &&
      payload.expiresAt > now &&
      typeof payload.nonce === "string" &&
      payload.nonce.length >= 16
    )
  } catch {
    return false
  }
}

export function validateAdminCredentials(username: string, password: string): boolean {
  const expectedPassword = getAdminPassword()
  if (!expectedPassword) return false

  const usernameMatches = secureCompare(username.trim(), getAdminUsername())
  const passwordMatches = secureCompare(password, expectedPassword)
  return usernameMatches && passwordMatches
}

export async function createAdminSession(): Promise<boolean> {
  const token = createSessionToken()
  if (!token) return false

  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/ldpadmin",
    maxAge: SESSION_TTL_SECONDS,
  })
  return true
}

export async function clearAdminSession(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/ldpadmin",
    maxAge: 0,
  })
}

export async function isAdminAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  return token ? verifySessionToken(token) : false
}

async function getLoginClientKey(): Promise<string> {
  try {
    const requestHeaders = await headers()
    const forwardedFor = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim()
    const clientIp = requestHeaders.get("x-real-ip") || forwardedFor || "unknown"
    return clientIp.slice(0, 128)
  } catch {
    return "unknown"
  }
}

function pruneLoginAttempts(now: number): void {
  if (loginAttempts.size < 1000) return

  for (const [key, attempt] of loginAttempts) {
    const expired =
      attempt.blockedUntil <= now && now - attempt.firstFailureAt > LOGIN_WINDOW_MS
    if (expired) loginAttempts.delete(key)
  }
}

export async function getLoginRetryAfterSeconds(): Promise<number> {
  const now = Date.now()
  const key = await getLoginClientKey()

  try {
    const db = await getSiteDatabase()
    db.prepare("DELETE FROM admin_login_attempts WHERE blocked_until <= ? AND (? - first_failure_at) > ?")
      .run(now, now, LOGIN_WINDOW_MS)

    const row = db.prepare(
      "SELECT failures, first_failure_at, blocked_until FROM admin_login_attempts WHERE client = ?"
    ).get(key) as { failures: number; first_failure_at: number; blocked_until: number } | undefined

    if (!row) return 0

    if (row.blocked_until > now) {
      return Math.ceil((row.blocked_until - now) / 1000)
    }

    if (now - row.first_failure_at > LOGIN_WINDOW_MS) {
      db.prepare("DELETE FROM admin_login_attempts WHERE client = ?").run(key)
    }
    return 0
  } catch (error) {
    console.error("SQLite getLoginRetryAfterSeconds error, falling back to memory:", error)
    pruneLoginAttempts(now)
    const attempt = loginAttempts.get(key)
    if (!attempt) return 0
    if (attempt.blockedUntil > now) {
      return Math.ceil((attempt.blockedUntil - now) / 1000)
    }
    if (now - attempt.firstFailureAt > LOGIN_WINDOW_MS) {
      loginAttempts.delete(key)
    }
    return 0
  }
}

export async function recordLoginFailure(): Promise<number> {
  const now = Date.now()
  const key = await getLoginClientKey()

  try {
    const db = await getSiteDatabase()
    db.prepare("DELETE FROM admin_login_attempts WHERE blocked_until <= ? AND (? - first_failure_at) > ?")
      .run(now, now, LOGIN_WINDOW_MS)

    const row = db.prepare(
      "SELECT failures, first_failure_at, blocked_until FROM admin_login_attempts WHERE client = ?"
    ).get(key) as { failures: number; first_failure_at: number; blocked_until: number } | undefined

    let failures = 1
    let firstFailureAt = now
    let blockedUntil = 0

    if (row && now - row.first_failure_at <= LOGIN_WINDOW_MS) {
      failures = row.failures + 1
      firstFailureAt = row.first_failure_at
      blockedUntil = row.blocked_until
    }

    if (failures >= MAX_LOGIN_FAILURES) {
      blockedUntil = now + LOGIN_BLOCK_MS
    }

    db.prepare(`
      INSERT INTO admin_login_attempts (client, failures, first_failure_at, blocked_until)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(client) DO UPDATE SET
        failures = excluded.failures,
        first_failure_at = excluded.first_failure_at,
        blocked_until = excluded.blocked_until
    `).run(key, failures, firstFailureAt, blockedUntil)

    return blockedUntil > now ? Math.ceil((blockedUntil - now) / 1000) : 0
  } catch (error) {
    console.error("SQLite recordLoginFailure error, falling back to memory:", error)
    pruneLoginAttempts(now)
    if (!loginAttempts.has(key) && loginAttempts.size >= 1000) {
      const oldestKey = loginAttempts.keys().next().value
      if (typeof oldestKey === "string") loginAttempts.delete(oldestKey)
    }
    const current = loginAttempts.get(key)
    const attempt =
      !current || now - current.firstFailureAt > LOGIN_WINDOW_MS
        ? { failures: 0, firstFailureAt: now, blockedUntil: 0 }
        : current
    attempt.failures += 1
    if (attempt.failures >= MAX_LOGIN_FAILURES) {
      attempt.blockedUntil = now + LOGIN_BLOCK_MS
    }
    loginAttempts.set(key, attempt)
    return attempt.blockedUntil > now ? Math.ceil((attempt.blockedUntil - now) / 1000) : 0
  }
}

export async function resetLoginFailures(): Promise<void> {
  const key = await getLoginClientKey()
  try {
    const db = await getSiteDatabase()
    db.prepare("DELETE FROM admin_login_attempts WHERE client = ?").run(key)
  } catch (error) {
    console.error("SQLite resetLoginFailures error:", error)
  }
  loginAttempts.delete(key)
}
