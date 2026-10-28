import { GET as checkHealth } from "../api/health/route"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  return checkHealth()
}
