"use server"

import { parse } from "node-html-parser"
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
  createStoredSite,
  deleteStoredSite,
  isSiteNameTaken,
  isValidSiteName,
  listStoredSites,
  readStoredSite,
  renameStoredSite,
} from "@/lib/site-storage"

/**
 * 生成随机字母数字名称，长度在6-9个字符之间
 */
function generateRandomName(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  const length = Math.floor(Math.random() * 4) + 6 // 6-9
  let result = ""
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

/**
 * 验证HTML内容
 */
function validateHtml(html: string): { valid: boolean; error?: string } {
  try {
    const root = parse(html)
    // 检查基本结构
    if (!html.includes("<html") || !html.includes("</html>")) {
      return { valid: false, error: "HTML必须包含<html>标签" }
    }
    if (!html.includes("<body") || !html.includes("</body>")) {
      return { valid: false, error: "HTML必须包含<body>标签" }
    }
    return { valid: true }
  } catch (error) {
    return { valid: false, error: "HTML结构无效。请检查代码语法错误。" }
  }
}

/**
 * 创建HTML站点 (包含安全增强)
 */
export async function createSite(
  html: string,
  siteName: string,
): Promise<{ url: string; generatedName?: string; error?: string }> {
  // 1. 验证HTML
  const validation = validateHtml(html)
  if (!validation.valid) {
    return { url: "", error: validation.error }
  }

  // ★★★ 安全增强：注入防钓鱼警示横幅 ★★★
  const root = parse(html)
  const body = root.querySelector('body')

  if (body) {
    const securityBanner = `
      <div style="
        position: fixed;
        top: 0; left: 0; width: 100%;
        background-color: #ef4444; color: white;
        text-align: center; padding: 12px;
        z-index: 9999999; font-family: sans-serif; font-weight: bold;
        box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      ">
        ⚠️ 警告：此页面由用户生成。请勿输入密码或下载文件！
      </div>
      <div style="height: 48px;"></div>
    `
    // 在 body 最前面插入
    // body.insertAdjacentHTML('afterbegin', securityBanner)
  }

  // 使用处理后的安全 HTML
  const safeHtml = root.toString()

  // 2. 名称处理逻辑
  let finalSiteName = siteName.trim()
  let isGenerated = false

  if (finalSiteName && !isValidSiteName(finalSiteName)) {
    return { url: "", error: "站点名称只能包含字母、数字、连字符和下划线。" }
  }

  try {
    if (!finalSiteName || (await isSiteNameTaken(finalSiteName))) {
      isGenerated = true
      finalSiteName = generateRandomName()
    }

    // 独占创建，避免并发请求生成相同名称时互相覆盖。
    while (!(await createStoredSite(finalSiteName, safeHtml))) {
      isGenerated = true
      finalSiteName = generateRandomName()
    }

    const baseUrl = (process.env.NEXT_PUBLIC_BASE_URL || "https://play.linecode.top").replace(/\/$/, "")
    const url = `${baseUrl}/${finalSiteName}`

    return {
      url,
      ...(isGenerated && { generatedName: finalSiteName }),
    }
  } catch (error) {
    console.error(error)
    return { url: "", error: "保存文件时发生错误。" }
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
    return {
      sites: (await listStoredSites()).map((site) => ({
        name: site.name,
        createdAt: site.createdAt,
        expiresAt: site.expiresAt,
        expired: site.expired,
      })),
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
    if (!(await deleteStoredSite(siteName))) {
      return { success: false, error: "站点不存在" }
    }
    return { success: true }
  } catch (error) {
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

    if (!(await readStoredSite(oldName))) return { success: false, error: "原站点不存在" }
    if (await isSiteNameTaken(newName)) return { success: false, error: "新名称已被占用" }
    if (!(await renameStoredSite(oldName, newName))) {
      return { success: false, error: "重命名失败" }
    }
    return { success: true }
  } catch (error) {
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
    const site = await readStoredSite(siteName)
    if (!site) return { error: "站点不存在" }
    return { html: site.html }
  } catch (error) {
    console.error(error)
    return { error: "读取站点失败" }
  }
}
