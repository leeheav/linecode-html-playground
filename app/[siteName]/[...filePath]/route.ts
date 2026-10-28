import { servePublicSite } from "@/lib/public-site-response"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ siteName: string; filePath: string[] }> },
) {
  const { siteName, filePath } = await params
  return servePublicSite(siteName, filePath.join("/"))
}
