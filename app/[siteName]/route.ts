import { NextResponse } from "next/server"
import { isValidSiteName, readStoredSite } from "@/lib/site-storage"

export const dynamic = "force-dynamic"

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
}

function expiredPage(siteName: string): string {
  const safeName = siteName.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] || character)

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>页面已过期并删除</title>
  <style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#050505;color:#fff;font-family:system-ui,sans-serif}.card{max-width:32rem;padding:2rem;text-align:center;border:1px solid #292929;border-radius:1rem;background:#111}h1{margin-top:0}p{color:#aaa;line-height:1.7}a{color:#c084fc}</style>
</head>
<body><main class="card"><h1>页面已过期并删除</h1><p>站点 <strong>${safeName}</strong> 的 7 天公开访问期已结束，公开页面已删除。</p><a href="/">返回首页</a></main></body>
</html>`
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ siteName: string }> },
) {
  const { siteName } = await params

  if (!isValidSiteName(siteName)) {
    return new NextResponse("Invalid site name", {
      status: 400,
      headers: NO_CACHE_HEADERS,
    })
  }

  try {
    const site = await readStoredSite(siteName)
    if (!site) {
      return new NextResponse("Site not found", {
        status: 404,
        headers: NO_CACHE_HEADERS,
      })
    }

    if (site.expired) {
      return new NextResponse(expiredPage(siteName), {
        status: 410,
        headers: {
          ...NO_CACHE_HEADERS,
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          "X-Frame-Options": "DENY",
        },
      })
    }

    return new NextResponse(site.html, {
      headers: {
        ...NO_CACHE_HEADERS,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: https:; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
      },
    })
  } catch (error) {
    console.error(error)
    return new NextResponse("Site storage error", {
      status: 500,
      headers: NO_CACHE_HEADERS,
    })
  }
}
