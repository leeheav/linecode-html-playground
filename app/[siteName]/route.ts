import { servePublicSite } from "@/lib/public-site-response"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ siteName: string }> },
) {
  const { siteName } = await params
  return servePublicSite(siteName)
}
