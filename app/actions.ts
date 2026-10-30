"use server"

import { headers } from "next/headers"

import {
  clearAdminSession,
  createAdminSession,
  getLoginRetryAfterSeconds,
  isAdminAuthenticated,
  recordLoginFailure,
  resetLoginFailures,
  validateAdminCredentials,
} from "@/lib/admin-auth"
import {
  deleteStoredSite,
  isSiteNameTaken,
  isValidSiteName,
  listStoredSites,
  readStoredSite,
  renameStoredSite,
} from "@/lib/site-storage"
import {
  createSiteFromInput,
  checkCreateRateLimit,
  getSite,
  listSites,
  purgeSite as purgeStoredSiteV2,
  readSiteFileForAdmin,
  renameSiteRecord,
  setSiteDisabled,
  setSiteExpiry,
  setSiteStatus,
  SiteInputError,
} from "@/lib/site-service"
import { publicSiteUrl } from "@/lib/site-url"

export async function createSite(
  html: string,
  siteName: string,
): Promise<{ url: string; generatedName?: string; error?: string }> {
  try {
    publicSiteUrl("configuration-check")
    const requestHeaders = await headers()
    const client = requestHeaders.get("x-real-ip") || requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() || "action-client"
    if (!(await checkCreateRateLimit(client))) {
      return { url: "", error: "创建过于频繁，请稍后重试。" }
    }
    const { site, generatedName } = await createSiteFromInput({ html, name: siteName })
    if (site.status !== "active") {
      return { url: "", error: "内容已提交审核，审核通过后才会公开。" }
    }
    return {
      url: publicSiteUrl(site.name),
      ...(generatedName && { generatedName: site.name }),
    }
  } catch (error) {
    if (error instanceof SiteInputError) return { url: "", error: error.message }
    console.error(error)
    return { url: "", error: "创建站点时发生错误。" }
  }
}

// --- 以下是丢失的 Admin 管理功能 ---

export async function adminLogin(
  username: string,
  password: string,
): Promise<{ success: boolean; error?: string }> {
  const retryAfter = await getLoginRetryAfterSeconds()
  if (retryAfter > 0) {
    return {
      success: false,
      error: `登录尝试过于频繁，请在 ${Math.ceil(retryAfter / 60)} 分钟后重试`,
    }
  }

  if (!validateAdminCredentials(username, password)) {
    const blockedFor = await recordLoginFailure()
    return {
      success: false,
      error:
        blockedFor > 0
          ? "登录失败次数过多，请在 15 分钟后重试"
          : "用户名或密码错误",
    }
  }

  await resetLoginFailures()
  if (!(await createAdminSession())) {
    return { success: false, error: "管理员认证未正确配置" }
  }

  return { success: true }
}

export async function adminLogout(): Promise<void> {
  await clearAdminSession()
}

export async function checkAdminSession(): Promise<boolean> {
  return isAdminAuthenticated()
}

export interface Site {
  name: string
  createdAt: Date
  expiresAt: Date
  expired: boolean
  version: 1 | 2
  status: "active" | "review" | "disabled" | "rejected"
  inputType?: "html" | "file" | "zip"
  findings?: string[]
}

/**
 * 获取所有站点的信息
 */
export async function getAllSites(): Promise<{
  sites: Site[]
  unauthorized?: boolean
  error?: string
}> {
  if (!(await isAdminAuthenticated())) {
    return { sites: [], unauthorized: true, error: "未登录或会话已过期" }
  }

  try {
    const [legacy, current] = await Promise.all([listStoredSites(), listSites()])
    return {
      sites: [
        ...current.map((site) => ({
          name: site.name,
          createdAt: new Date(site.createdAt),
          expiresAt: new Date(site.expiresAt),
          expired: Date.now() >= Date.parse(site.expiresAt),
          version: 2 as const,
          status: site.status,
          inputType: site.inputType,
          findings: site.scan.findings.map((finding) => finding.message),
        })),
        ...legacy.map((site) => ({
          name: site.name,
          createdAt: site.createdAt,
          expiresAt: site.expiresAt,
          expired: site.expired,
          version: 1 as const,
          status: "active" as const,
        })),
      ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    }
  } catch (error) {
    console.error(error)
    return { sites: [], error: "加载站点失败" }
  }
}

/**
 * 删除站点
 */
export async function deleteSite(siteName: string): Promise<{ success: boolean; error?: string }> {
  if (!(await isAdminAuthenticated())) {
    return { success: false, error: "未登录或会话已过期" }
  }

  try {
    if (!isValidSiteName(siteName)) {
      return { success: false, error: "站点名称格式无效" }
    }
    if (await getSite(siteName)) {
      return (await setSiteDisabled(siteName, true))
        ? { success: true }
        : { success: false, error: "站点不存在或无法下线" }
    }
    if (!(await deleteStoredSite(siteName))) {
      return { success: false, error: "站点不存在" }
    }
    return { success: true }
  } catch {
    return { success: false, error: "删除失败" }
  }
}

/**
 * 重命名站点
 */
export async function renameSite(oldName: string, newName: string): Promise<{ success: boolean; error?: string }> {
  if (!(await isAdminAuthenticated())) {
    return { success: false, error: "未登录或会话已过期" }
  }

  try {
    if (!isValidSiteName(oldName) || !isValidSiteName(newName)) {
      return { success: false, error: "名称格式无效" }
    }
    if (oldName === newName) return { success: false, error: "名称相同" }
    if (await getSite(oldName)) {
      return (await renameSiteRecord(oldName, newName))
        ? { success: true }
        : { success: false, error: "新名称已被占用或站点不存在" }
    }

    if (!(await readStoredSite(oldName))) return { success: false, error: "原站点不存在" }
    if (await isSiteNameTaken(newName)) return { success: false, error: "新名称已被占用" }
    if (!(await renameStoredSite(oldName, newName))) {
      return { success: false, error: "重命名失败" }
    }
    return { success: true }
  } catch {
    return { success: false, error: "重命名失败" }
  }
}

/**
 * 后台预览站点。即使公开链接已过期，管理员仍可读取原始文件。
 */
export async function getSiteHtmlForAdmin(siteName: string): Promise<{
  html?: string
  error?: string
  unauthorized?: boolean
}> {
  if (!(await isAdminAuthenticated())) {
    return { unauthorized: true, error: "未登录或会话已过期" }
  }
  if (!isValidSiteName(siteName)) return { error: "站点名称格式无效" }

  try {
    if (await getSite(siteName)) {
      const file = await readSiteFileForAdmin(siteName)
      return file ? { html: file.body.toString("utf8") } : { error: "站点入口文件不存在" }
    }
    const site = await readStoredSite(siteName)
    if (!site) return { error: "站点不存在" }
    return { html: site.html }
  } catch (error) {
    console.error(error)
    return { error: "读取站点失败" }
  }
}

export async function approveSite(siteName: string): Promise<{ success: boolean; error?: string }> {
  if (!(await isAdminAuthenticated())) return { success: false, error: "未登录或会话已过期" }
  const site = await getSite(siteName)
  if (!site || site.status !== "review") return { success: false, error: "站点不在待审核状态" }
  if (Date.now() >= Date.parse(site.expiresAt)) return { success: false, error: "站点已过期，请先延长有效期" }
  return (await setSiteStatus(siteName, "active"))
    ? { success: true }
    : { success: false, error: "审核操作失败" }
}

export async function restoreSite(siteName: string): Promise<{ success: boolean; error?: string }> {
  if (!(await isAdminAuthenticated())) return { success: false, error: "未登录或会话已过期" }
  const site = await getSite(siteName)
  if (!site || site.status !== "disabled") return { success: false, error: "站点未下线" }
  if (Date.now() >= Date.parse(site.expiresAt)) return { success: false, error: "站点已过期，请先延长有效期" }
  return (await setSiteDisabled(siteName, false))
    ? { success: true }
    : { success: false, error: "恢复失败" }
}

export async function changeSiteExpiry(siteName: string, expiresInHours: number): Promise<{ success: boolean; error?: string }> {
  if (!(await isAdminAuthenticated())) return { success: false, error: "未登录或会话已过期" }
  if (![1, 24, 72, 168, 720].includes(expiresInHours)) return { success: false, error: "有效期选项无效" }
  try {
    return (await setSiteExpiry(siteName, new Date(Date.now() + expiresInHours * 3600_000).toISOString()))
      ? { success: true }
      : { success: false, error: "站点不存在" }
  } catch (error) {
    return { success: false, error: error instanceof SiteInputError ? error.message : "修改有效期失败" }
  }
}

export async function purgeSiteForAdmin(siteName: string): Promise<{ success: boolean; error?: string }> {
  if (!(await isAdminAuthenticated())) return { success: false, error: "未登录或会话已过期" }
  try {
    return (await purgeStoredSiteV2(siteName))
      ? { success: true }
      : { success: false, error: "站点不存在" }
  } catch {
    return { success: false, error: "彻底清除失败" }
  }
}
