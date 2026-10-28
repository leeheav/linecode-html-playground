import "server-only"

export class SiteUrlConfigurationError extends Error {}

export function publicSiteUrl(name: string): string {
  const configured = process.env.SITE_PUBLIC_BASE_URL?.trim()
  if (process.env.NODE_ENV === "production" && !configured) {
    throw new SiteUrlConfigurationError("站点发布域名未配置，请管理员设置 SITE_PUBLIC_BASE_URL")
  }
  let base: URL
  try {
    base = new URL(configured || process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3001")
  } catch {
    throw new SiteUrlConfigurationError("站点发布域名格式无效，请管理员检查 SITE_PUBLIC_BASE_URL")
  }
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new SiteUrlConfigurationError("站点发布域名只能填写域名根地址，不能包含路径或账号")
  }
  if (process.env.NODE_ENV === "production" && base.protocol !== "https:") {
    throw new SiteUrlConfigurationError("站点发布域名必须使用 HTTPS")
  }
  return `${base.origin}/${encodeURIComponent(name)}`
}
