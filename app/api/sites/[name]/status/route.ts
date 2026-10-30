import { NextRequest, NextResponse } from "next/server"
import { getSite } from "@/lib/site-service"
import { publicSiteUrl } from "@/lib/site-url"

export const runtime = "nodejs"

export async function GET(_request: NextRequest, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params
  const site = await getSite(name)
  if (!site) return NextResponse.json({ error: "站点不存在" }, { status: 404 })
  const status = site.status === "active" && Date.now() >= Date.parse(site.expiresAt) ? "expired" : site.status
  let url: string | undefined
  if (status === "active") {
    try {
      url = publicSiteUrl(site.name)
    } catch {
      // Ignore URL calculation failure if environment is unconfigured
    }
  }
  return NextResponse.json({
    name,
    status,
    expiresAt: site.expiresAt,
    ...(url ? { url } : {}),
  })
}
