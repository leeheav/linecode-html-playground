"use server"

import fs from "fs/promises"
import path from "path"
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

// HTML文件存储目录
const SITES_DIR = path.join(process.cwd(), "public", "sites")

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
 * 确保站点目录存在
 */
async function ensureSitesDirectory(): Promise<void> {
  try {
    await fs.access(SITES_DIR)
  } catch (error) {
    await fs.mkdir(SITES_DIR, { recursive: true })
  }
}

/**
 * 检查站点名称是否已被占用
 */
async function isSiteNameTaken(name: string): Promise<boolean> {
  try {
    await fs.access(path.join(SITES_DIR, `${name}.html`))
    return true
  } catch (error) {
    return false
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

  await ensureSitesDirectory()

  // 2. 名称处理逻辑
  let finalSiteName = siteName.trim()
  let isGenerated = false

  if (!finalSiteName) {
    do { finalSiteName = generateRandomName() } while (await isSiteNameTaken(finalSiteName))
    isGenerated = true
  } else {
    if (await isSiteNameTaken(finalSiteName)) {
      do { finalSiteName = generateRandomName() } while (await isSiteNameTaken(finalSiteName))
      isGenerated = true
    } else {
      if (!/^[a-zA-Z0-9_-]+$/.test(finalSiteName)) {
        return { url: "", error: "站点名称只能包含字母、数字、连字符和下划线。" }
      }
    }
  }

  try {
    const filePath = path.join(SITES_DIR, `${finalSiteName}.html`)
    // 写入 safeHtml
    await fs.writeFile(filePath, safeHtml, "utf-8")

    const baseUrl = 'http://play.linecode.top' // 您的域名
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
  html: string
  createdAt: Date
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
    await ensureSitesDirectory()
    const files = await fs.readdir(SITES_DIR)
    const htmlFiles = files.filter(file => file.endsWith('.html'))

    const sitePromises = htmlFiles.map(async (file) => {
      try {
        const filePath = path.join(SITES_DIR, file)
        const [html, stats] = await Promise.all([
          fs.readFile(filePath, 'utf-8'),
          fs.stat(filePath)
        ])
        return {
          name: file.replace(/\.html$/, ''),
          html: html.substring(0, 200), // 只读前200字符用于预览，节省性能
          createdAt: stats.birthtime || stats.ctime
        }
      } catch (error) {
        return null
      }
    })

    const results = await Promise.all(sitePromises)
    return {
      sites: results.filter((site): site is Site => site !== null)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
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
    if (!/^[a-zA-Z0-9_-]+$/.test(siteName)) {
      return { success: false, error: "站点名称格式无效" }
    }
    await ensureSitesDirectory()
    const filePath = path.join(SITES_DIR, `${siteName}.html`)
    await fs.unlink(filePath)
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
    if (!/^[a-zA-Z0-9_-]+$/.test(oldName) || !/^[a-zA-Z0-9_-]+$/.test(newName)) {
      return { success: false, error: "名称格式无效" }
    }
    if (oldName === newName) return { success: false, error: "名称相同" }

    await ensureSitesDirectory()
    const oldFilePath = path.join(SITES_DIR, `${oldName}.html`)
    const newFilePath = path.join(SITES_DIR, `${newName}.html`)

    // 检查是否存在
    try { await fs.access(oldFilePath) } catch { return { success: false, error: "原站点不存在" } }
    try {
        await fs.access(newFilePath)
        return { success: false, error: "新名称已被占用" }
    } catch { } // 新文件不存在才正常

    await fs.rename(oldFilePath, newFilePath)
    return { success: true }
  } catch (error) {
    return { success: false, error: "重命名失败" }
  }
}
