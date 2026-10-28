import "server-only"

import { getSite, readSiteFile } from "@/lib/site-service"
import { isValidSiteName as isValidLegacyName, readStoredSite } from "@/lib/site-storage"

const BASE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}

const HTML_CSP = "sandbox allow-scripts; default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] || character)
}

function expiredResponse(name: string): Response {
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>页面已失效</title></head><body><main><h1>页面已失效</h1><p>站点 ${escapeHtml(name)} 的公开访问期已结束。</p></main></body></html>`
  return new Response(body, {
    status: 410,
    headers: { ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" },
  })
}

function missingResponse(): Response {
  return new Response("Site not found", { status: 404, headers: BASE_HEADERS })
}

function withRootBase(html: string, name: string): string {
  const base = `<base href="/${encodeURIComponent(name)}/">`
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (head) => head + base)
  }
  return html.replace(/<html\b[^>]*>/i, (opening) => opening + `<head>${base}</head>`)
}

export async function servePublicSite(name: string, requestedPath = ""): Promise<Response> {
  if (!isValidLegacyName(name)) {
    return new Response("Invalid site name", { status: 400, headers: BASE_HEADERS })
  }

  try {
    const site = await getSite(name)
    if (site) {
      if (Date.now() >= Date.parse(site.expiresAt)) return expiredResponse(name)
      if (site.status !== "active") return missingResponse()
      const file = await readSiteFile(name, requestedPath || "index.html")
      if (!file) return missingResponse()
      const html = file.contentType.startsWith("text/html") || file.contentType.startsWith("image/svg+xml")
      const body = html && !requestedPath
        ? withRootBase(file.body.toString("utf8"), name)
        : new Uint8Array(file.body)
      return new Response(body, {
        headers: {
          ...BASE_HEADERS,
          "Content-Type": file.contentType,
          ...(!html ? { "Access-Control-Allow-Origin": "*" } : {}),
          ...(html ? { "Content-Security-Policy": HTML_CSP, "X-Frame-Options": "DENY" } : {}),
        },
      })
    }

    // Version 1 sites remain readable while their owner migrates the data volume.
    if (requestedPath) return missingResponse()
    const legacy = await readStoredSite(name)
    if (!legacy) return missingResponse()
    if (legacy.expired) return expiredResponse(name)
    return new Response(legacy.html, {
      headers: { ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": HTML_CSP, "X-Frame-Options": "DENY" },
    })
  } catch (error) {
    console.error("Failed to serve site", error)
    return new Response("Site storage error", { status: 500, headers: BASE_HEADERS })
  }
}
