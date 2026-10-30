"use client"

import type React from "react"
import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Card } from "@/components/ui/card"
import {
  Loader2,
  Check,
  Copy,
  Eye,
  AlertCircle,
  CheckCircle2,
  Clock,
  ExternalLink,
  RotateCcw,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription } from "@/components/ui/alert"

interface PublishResult {
  name: string
  status: "active" | "review"
  url: string
  generatedName?: string
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function CreateSite() {
  const [source, setSource] = useState<"paste" | "upload">("paste")
  const [html, setHtml] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [siteName, setSiteName] = useState("")
  const [expiresInHours, setExpiresInHours] = useState("168")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleReset = () => {
    setHtml("")
    setFile(null)
    setSiteName("")
    setPublishResult(null)
    setError(null)
    setCopied(false)
    setShowPreview(false)
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (source === "paste" ? !html.trim() : !file) return

    setIsSubmitting(true)
    setError(null)
    setPublishResult(null)
    setCopied(false)

    try {
      const form = new FormData()
      form.set("kind", source === "paste" ? "html" : "file")
      form.set("siteName", siteName.trim())
      form.set("expiresInHours", expiresInHours)
      if (source === "paste") {
        form.set("html", html)
      } else if (file) {
        form.set("file", file)
      }

      const response = await fetch("/api/sites", { method: "POST", body: form })
      let result: {
        url?: string
        name?: string
        status?: string
        generatedName?: string
        error?: string
      } = {}

      try {
        result = (await response.json()) as typeof result
      } catch {
        // Fallback for non-JSON responses
      }

      if (!response.ok || result.error) {
        if (response.status === 413) {
          setError(result.error || "提交内容过大（粘贴 HTML 上限 5 MB，上传文件上限 10 MB）。")
        } else if (response.status === 429) {
          setError(result.error || "创建过于频繁，请稍后再试。")
        } else {
          setError(result.error || "站点创建失败，请检查内容后重试。")
        }
        return
      }

      if (result.name && (result.status === "active" || result.status === "review")) {
        setPublishResult({
          name: result.name,
          status: result.status,
          url: result.url || "",
          generatedName: result.generatedName,
        })
        if (result.generatedName) {
          setSiteName(result.generatedName)
        }
      } else {
        setError("服务端返回结果异常，请稍后刷新重试。")
      }
    } catch {
      setError("网络请求失败，请检查网络连接后重试。")
    } finally {
      setIsSubmitting(false)
    }
  }

  const copyToClipboard = async () => {
    if (!publishResult?.url) return
    try {
      await navigator.clipboard.writeText(publishResult.url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setError("复制失败，请手动选中文本并复制。")
    }
  }

  const isValidHtml =
    !html ||
    (/<html.*?>[\s\S]*?<\/html>/i.test(html) && /<body.*?>[\s\S]*?<\/body>/i.test(html))

  return (
    <div className="max-w-4xl mx-auto">
      <Card className="p-6 bg-card border-border shadow-xl">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="siteName" className="block text-sm font-medium mb-2 text-foreground/90">
              站点名称（可选）
            </label>
            <Input
              id="siteName"
              value={siteName}
              onChange={(event) => setSiteName(event.target.value)}
              placeholder="留空则随机生成名称"
              className="bg-muted/40 border-input text-foreground"
            />
            <p className="mt-2 text-xs text-muted-foreground">
              支持 1~64 位英文字母、数字、连字符和下划线；留空将由系统自动分配。
            </p>
          </div>

          <div>
            <label htmlFor="expiresInHours" className="block text-sm font-medium mb-2 text-foreground/90">
              链接有效期
            </label>
            <select
              id="expiresInHours"
              value={expiresInHours}
              onChange={(event) => setExpiresInHours(event.target.value)}
              className="w-full h-10 rounded-md border border-input bg-muted/40 px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="24">1 天</option>
              <option value="72">3 天</option>
              <option value="168">7 天（默认）</option>
              <option value="720">30 天</option>
            </select>
          </div>

          <div>
            <div className="flex gap-2 mb-3" role="group" aria-label="内容来源">
              <Button
                type="button"
                variant={source === "paste" ? "default" : "outline"}
                onClick={() => setSource("paste")}
              >
                粘贴 HTML
              </Button>
              <Button
                type="button"
                variant={source === "upload" ? "default" : "outline"}
                onClick={() => setSource("upload")}
              >
                上传文件
              </Button>
            </div>

            {source === "paste" ? (
              <>
                <div className="flex justify-between items-center mb-2">
                  <label htmlFor="html" className="block text-sm font-medium text-foreground/90">
                    HTML 源码 <span className="text-xs text-muted-foreground">（最大 5 MB）</span>
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowPreview(!showPreview)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Eye className="h-4 w-4 mr-1" />
                    {showPreview ? "隐藏本地预览" : "显示本地预览"}
                  </Button>
                </div>
                <Textarea
                  id="html"
                  value={html}
                  onChange={(event) => setHtml(event.target.value)}
                  placeholder="<!doctype html><html><head><title>My Site</title></head><body><h1>Hello World!</h1></body></html>"
                  className="min-h-[260px] bg-muted/40 border-input text-foreground font-mono text-sm"
                  required
                />
                {html && !isValidHtml && (
                  <p className="mt-2 text-sm text-amber-400 flex items-center">
                    <AlertCircle className="h-4 w-4 mr-1 shrink-0" />
                    HTML 结构可能缺少 html 或 body 标签，建议补齐以保证正常展示。
                  </p>
                )}
                {showPreview && html && (
                  <div className="mt-3 border border-border rounded-md overflow-hidden">
                    <div className="bg-muted/60 px-4 py-2 text-xs text-muted-foreground border-b border-border">
                      本地沙箱预览（仅运行脚本，不进行外部网络交互）
                    </div>
                    <div className="bg-white p-4 h-[300px] overflow-auto">
                      <iframe
                        srcDoc={html}
                        title="HTML 本地预览"
                        className="w-full h-full border-0"
                        sandbox="allow-scripts"
                      />
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div>
                <label htmlFor="siteFile" className="block text-sm font-medium mb-2 text-foreground/90">
                  HTML 文件或 ZIP 压缩包 <span className="text-xs text-muted-foreground">（单文件最大 10 MB）</span>
                </label>
                <Input
                  id="siteFile"
                  type="file"
                  ref={fileInputRef}
                  accept=".html,.htm,.zip,text/html,application/zip"
                  onChange={(event) => {
                    setFile(event.target.files?.[0] || null)
                    setError(null)
                  }}
                  className="bg-muted/40 border-input text-foreground file:text-foreground"
                  required
                />
                <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
                  支持单个 .html 网页或 .zip 压缩包。ZIP 根目录须包含 index.html，静态资源请使用相对路径；解压后总大小不超过 30 MB，文件数不超过 100 个。
                </p>
                {file && (
                  <p className="mt-2 text-sm text-purple-400">
                    已选择：{file.name}（{formatFileSize(file.size)}）
                  </p>
                )}
              </div>
            )}
          </div>

          {error && (
            <Alert variant="destructive" className="bg-destructive/20 border-destructive/50 text-destructive-foreground">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button
            type="submit"
            disabled={isSubmitting || (source === "paste" ? !html.trim() : !file)}
            className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white font-medium h-11"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                正在提交并检查内容…
              </>
            ) : (
              "创建分享站点"
            )}
          </Button>
        </form>

        {publishResult && (
          <div className="mt-6" role="status" aria-live="polite">
            {publishResult.status === "active" ? (
              <div className="p-5 bg-emerald-950/20 rounded-lg border border-emerald-800/60">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="h-5 w-5 text-emerald-400 mt-0.5 shrink-0" />
                  <div className="space-y-1 flex-1 min-w-0">
                    <h3 className="font-semibold text-emerald-200">站点已成功发布</h3>
                    <p className="text-sm text-emerald-300/90">
                      {publishResult.generatedName
                        ? `系统已为您分配站点名称：${publishResult.name}。`
                        : `站点名称：${publishResult.name}。`}
                      链接已即时生效，可在有效期内公开访问。
                    </p>
                  </div>
                </div>

                <div className="mt-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <Input
                    value={publishResult.url}
                    readOnly
                    aria-label="站点公开分享链接"
                    className="bg-muted/50 border-input text-foreground font-mono text-sm selection:bg-purple-600 flex-1"
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className={cn(
                      "shrink-0 border-border text-foreground hover:bg-muted",
                      copied && "text-emerald-400 border-emerald-700 bg-emerald-950/40"
                    )}
                    onClick={copyToClipboard}
                    aria-label={copied ? "已复制链接" : "复制链接"}
                  >
                    {copied ? (
                      <>
                        <Check className="h-4 w-4 mr-1.5 text-emerald-400" />
                        已复制
                      </>
                    ) : (
                      <>
                        <Copy className="h-4 w-4 mr-1.5" />
                        复制链接
                      </>
                    )}
                  </Button>
                </div>

                <div className="mt-4 flex flex-wrap gap-3">
                  <Button
                    type="button"
                    className="flex-1 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white min-w-[160px]"
                    onClick={() => window.open(publishResult.url, "_blank", "noopener,noreferrer")}
                  >
                    <ExternalLink className="h-4 w-4 mr-1.5" />
                    在新标签打开站点
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground hover:bg-muted"
                    onClick={handleReset}
                  >
                    <RotateCcw className="h-4 w-4 mr-1.5" />
                    创建新站点
                  </Button>
                </div>
              </div>
            ) : (
              <div className="p-5 bg-amber-950/20 rounded-lg border border-amber-800/60">
                <div className="flex items-start gap-3">
                  <Clock className="h-5 w-5 text-amber-400 mt-0.5 shrink-0" />
                  <div className="space-y-1.5 flex-1 min-w-0">
                    <h3 className="font-semibold text-amber-200">站点已保存，正在等待管理员审核</h3>
                    <p className="text-sm text-amber-300/90">
                      您提交的内容已完成入库（站点名称：<span className="font-mono text-amber-100 font-semibold">{publishResult.name}</span>）。
                    </p>
                    <p className="text-sm text-amber-300/80 leading-relaxed">
                      由于页面内容触发了安全规则检查（例如包含外链提交表单、密码输入框、自动跳转或动态执行脚本），公开访问已被暂时锁定。待管理员在后台审核放行后即可正常访问，请勿重复提交。
                    </p>
                  </div>
                </div>

                <div className="mt-4 flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-foreground hover:bg-muted"
                    onClick={handleReset}
                  >
                    <RotateCcw className="h-4 w-4 mr-1.5" />
                    继续创建其他站点
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  )
}
