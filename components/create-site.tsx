"use client"

import type React from "react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Card } from "@/components/ui/card"
import { Loader2, Check, Copy, Eye, AlertCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription } from "@/components/ui/alert"

type SiteStatus = "pending" | "review" | "active" | "rejected"
type SiteResult = { url?: string; name?: string; status?: string; statusUrl?: string; error?: string }
const statusText: Record<SiteStatus, string> = {
  pending: "正在扫描上传内容，请稍候…",
  review: "扫描完成，站点正在等待管理员审核。",
  active: "站点已创建，可以访问。",
  rejected: "内容未通过安全检查，站点未发布。",
}
function isStatus(value: unknown): value is SiteStatus {
  return value === "pending" || value === "review" || value === "active" || value === "rejected"
}

export function CreateSite() {
  const [source, setSource] = useState<"paste" | "upload">("paste")
  const [html, setHtml] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [siteName, setSiteName] = useState("")
  const [expiresInHours, setExpiresInHours] = useState("168")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [createdUrl, setCreatedUrl] = useState("")
  const [status, setStatus] = useState<SiteStatus | null>(null)
  const [statusUrl, setStatusUrl] = useState("")
  const [showPreview, setShowPreview] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (status !== "pending" || !statusUrl) return
    let cancelled = false
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(statusUrl, { cache: "no-store" })
        if (!response.ok) return
        const result = (await response.json()) as SiteResult
        if (cancelled) return
        if (result.error) setError(result.error)
        if (isStatus(result.status)) setStatus(result.status)
        if (result.status === "active" && result.url) setCreatedUrl(result.url)
      } catch {
        // Keep the current scan state if polling briefly fails.
      }
    }, 3000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [status, statusUrl])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (source === "paste" ? !html.trim() : !file) return
    setIsSubmitting(true)
    setError(null)
    setStatus(null)
    setStatusUrl("")
    setCreatedUrl("")
    try {
      const form = new FormData()
      form.set("kind", source === "paste" ? "html" : "file")
      form.set("siteName", siteName.trim())
      form.set("expiresInHours", expiresInHours)
      if (source === "paste") form.set("html", html)
      else if (file) form.set("file", file)
      const response = await fetch("/api/sites", { method: "POST", body: form })
      const result = (await response.json()) as SiteResult
      if (!response.ok || result.error) {
        setError(result.error || "创建失败，请检查内容后重试。")
        return
      }
      if (result.name) setSiteName(result.name)
      setStatus(isStatus(result.status) ? result.status : "active")
      if (result.status === "active" || !result.status) setCreatedUrl(result.url || "")
      if (result.statusUrl) setStatusUrl(result.statusUrl)
      else if (result.name && result.status === "pending") setStatusUrl(`/api/sites/${encodeURIComponent(result.name)}/status`)
    } catch {
      setError("网络请求失败，请稍后重试。")
    } finally {
      setIsSubmitting(false)
    }
  }

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(createdUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch { setError("复制失败，请手动复制链接。") }
  }
  const isValidHtml = !html || (/<html.*?>[\s\S]*?<\/html>/i.test(html) && /<body.*?>[\s\S]*?<\/body>/i.test(html))

  return (
    <div className="max-w-4xl mx-auto">
      <Card className="p-6 bg-gray-900 border-gray-800 shadow-xl">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="siteName" className="block text-sm font-medium mb-2 text-gray-300">站点名称（可选）</label>
            <Input id="siteName" value={siteName} onChange={(event) => setSiteName(event.target.value)}
              placeholder="留空则随机生成名称" className="bg-gray-800 border-gray-700 text-white" />
            <p className="mt-2 text-sm text-gray-400">留空时系统会生成站点名称。</p>
          </div>

          <div>
            <label htmlFor="expiresInHours" className="block text-sm font-medium mb-2 text-gray-300">链接有效期</label>
            <select id="expiresInHours" value={expiresInHours} onChange={(event) => setExpiresInHours(event.target.value)}
              className="w-full h-10 rounded-md border border-gray-700 bg-gray-800 px-3 text-sm text-white">
              <option value="24">1 天</option><option value="72">3 天</option>
              <option value="168">7 天</option><option value="720">30 天</option>
            </select>
          </div>

          <div>
            <div className="flex gap-2 mb-3" role="group" aria-label="内容来源">
              <Button type="button" variant={source === "paste" ? "default" : "outline"} onClick={() => setSource("paste")}>粘贴 HTML</Button>
              <Button type="button" variant={source === "upload" ? "default" : "outline"} onClick={() => setSource("upload")}>上传文件</Button>
            </div>
            {source === "paste" ? (
              <>
                <div className="flex justify-between items-center mb-2">
                  <label htmlFor="html" className="block text-sm font-medium text-gray-300">HTML 源码</label>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setShowPreview(!showPreview)} className="text-gray-400 hover:text-white">
                    <Eye className="h-4 w-4 mr-1" />{showPreview ? "隐藏预览" : "显示预览"}
                  </Button>
                </div>
                <Textarea id="html" value={html} onChange={(event) => setHtml(event.target.value)}
                  placeholder="<html><head><title>My Site</title></head><body><h1>Hello World!</h1></body></html>"
                  className="min-h-[300px] bg-gray-800 border-gray-700 text-white font-mono" required />
                {html && !isValidHtml && <p className="mt-2 text-sm text-amber-500 flex items-center">
                  <AlertCircle className="h-4 w-4 mr-1" />HTML 可能缺少 html 或 body 标签。</p>}
                {showPreview && html && <div className="mt-3 border border-gray-700 rounded-md overflow-hidden">
                  <div className="bg-gray-800 px-4 py-2 text-sm text-gray-400 border-b border-gray-700">本地预览</div>
                  <div className="bg-white p-4 h-[300px] overflow-auto">
                    <iframe srcDoc={html} title="HTML 本地预览" className="w-full h-full border-0" sandbox="allow-scripts" />
                  </div>
                </div>}
              </>
            ) : (
              <div>
                <label htmlFor="siteFile" className="block text-sm font-medium mb-2 text-gray-300">HTML 文件或 ZIP 压缩包</label>
                <Input id="siteFile" type="file" accept=".html,.htm,.zip,text/html,application/zip"
                  onChange={(event) => { setFile(event.target.files?.[0] || null); setError(null) }}
                  className="bg-gray-800 border-gray-700 text-white file:text-gray-200" required />
                <p className="mt-2 text-sm text-gray-400">ZIP 根目录需包含 index.html，资源请使用相对路径。上传后会进行基础安全规则检查。</p>
                {file && <p className="mt-2 text-sm text-purple-300">已选择：{file.name}</p>}
              </div>
            )}
          </div>

          {error && <Alert variant="destructive" className="bg-red-900/50 border-red-800 text-red-200">
            <AlertCircle className="h-4 w-4" /><AlertDescription>{error}</AlertDescription>
          </Alert>}
          <Button type="submit" disabled={isSubmitting || (source === "paste" ? !html.trim() : !file)}
            className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700">
            {isSubmitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />正在上传并检查…</> : "创建站点"}
          </Button>
        </form>

        {status && <div className="mt-6 p-4 bg-gray-800 rounded-md border border-gray-700" role="status" aria-live="polite">
          <p className="text-sm text-gray-300">{statusText[status]}</p>
          {createdUrl && <>
            <div className="flex items-center mt-3">
              <Input value={createdUrl} readOnly aria-label="站点链接" className="bg-gray-700 border-gray-600 text-white" />
              <Button type="button" variant="ghost" size="icon" aria-label="复制站点链接"
                className={cn("ml-2", copied ? "text-green-500" : "text-gray-400 hover:text-white")} onClick={copyToClipboard}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <Button type="button" variant="outline" className="w-full mt-4 border-gray-700 text-gray-300 hover:bg-gray-800"
              onClick={() => window.open(createdUrl, "_blank", "noopener,noreferrer")}>访问站点</Button>
          </>}
        </div>}
      </Card>
    </div>
  )
}

