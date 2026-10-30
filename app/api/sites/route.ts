import { NextRequest, NextResponse } from "next/server"
import { checkCreateRateLimit, createSiteFromInput, SiteInputError } from "@/lib/site-service"
import { publicSiteUrl, SiteUrlConfigurationError } from "@/lib/site-url"

export const runtime = "nodejs"

const MAX_REQUEST_BYTES = 11 * 1024 * 1024

async function boundedFormData(request: NextRequest): Promise<FormData> {
  const reader = request.body?.getReader()
  if (!reader) throw new SiteInputError("请求内容为空")
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel()
      throw new SiteInputError("请求超过 11 MB")
    }
    chunks.push(value)
  }
  const contentType = request.headers.get("content-type") || ""
  if (!contentType.startsWith("multipart/form-data;")) throw new SiteInputError("请使用 multipart/form-data")
  return new Response(Buffer.concat(chunks), { headers: { "content-type": contentType } }).formData()
}

export async function POST(request: NextRequest) {
  const length = Number(request.headers.get("content-length") || 0)
  if (length > MAX_REQUEST_BYTES) return NextResponse.json({ error: "请求超过 11 MB" }, { status: 413 })

  const client = request.headers.get("x-real-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"
  if (!(await checkCreateRateLimit(client))) return NextResponse.json({ error: "创建过于频繁，请稍后再试" }, { status: 429 })

  try {
    publicSiteUrl("configuration-check")
    const form = await boundedFormData(request)
    const kind = form.get("kind")
    const siteName = String(form.get("siteName") || "")
    const hoursRaw = String(form.get("expiresInHours") || "168")
    const expiresInHours = Number(hoursRaw)
    if (!Number.isInteger(expiresInHours)) throw new SiteInputError("失效时间选项无效")
    let input: Parameters<typeof createSiteFromInput>[0]

    if (kind === "html") {
      const html = form.get("html")
      if (typeof html !== "string") throw new SiteInputError("请提供 HTML 内容")
      if (Buffer.byteLength(html, "utf8") > 5 * 1024 * 1024) return NextResponse.json({ error: "HTML 超过 5 MB" }, { status: 413 })
      input = { name: siteName, html, expiresInHours }
    } else if (kind === "file") {
      const file = form.get("file")
      if (!(file instanceof File)) throw new SiteInputError("请上传 HTML 或 ZIP 文件")
      if (file.size > 10 * 1024 * 1024) return NextResponse.json({ error: "文件超过 10 MB" }, { status: 413 })
      input = { name: siteName, file: { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) }, expiresInHours }
    } else {
      throw new SiteInputError("请选择粘贴 HTML 或上传文件")
    }

    const { site, generatedName } = await createSiteFromInput(input)
    return NextResponse.json({ url: publicSiteUrl(site.name), name: site.name, status: site.status, ...(generatedName && { generatedName: site.name }) }, { status: 201 })
  } catch (error) {
    if (error instanceof SiteInputError) return NextResponse.json({ error: error.message }, { status: error.message.includes("11 MB") ? 413 : 400 })
    if (error instanceof SiteUrlConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 })
    console.error("Site upload failed", error)
    return NextResponse.json({ error: "站点创建失败" }, { status: 500 })
  }
}
