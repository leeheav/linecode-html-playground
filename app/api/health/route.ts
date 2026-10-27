import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import path from "node:path"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const headers = { "Cache-Control": "no-store" }

export async function GET() {
  try {
    const directory = process.env.SITES_DIR || ""
    if (
      !process.env.ADMIN_USERNAME?.trim() ||
      (process.env.ADMIN_PASSWORD || "").length < 12 ||
      (process.env.ADMIN_SESSION_SECRET?.trim() || "").length < 32 ||
      !path.isAbsolute(directory)
    ) {
      return Response.json({ status: "unavailable" }, { status: 503, headers })
    }
    if (!(await stat(directory)).isDirectory()) {
      return Response.json({ status: "unavailable" }, { status: 503, headers })
    }
    await access(directory, constants.R_OK | constants.W_OK)
    return Response.json({ status: "ok" }, { headers })
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers })
  }
}
