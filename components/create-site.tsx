"use client"

import type React from "react"

import { useState } from "react"
import { createSite } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Card } from "@/components/ui/card"
import { Loader2, Check, Copy, Eye, AlertCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription } from "@/components/ui/alert"

export function CreateSite() {
  const [html, setHtml] = useState("")
  const [siteName, setSiteName] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [createdUrl, setCreatedUrl] = useState("")
  const [showPreview, setShowPreview] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!html) return

    setIsSubmitting(true)
    setError(null)

    try {
      // Pass the siteName (which might be empty) to the server action
      const result = await createSite(html, siteName)

      if (result.error) {
        setError(result.error)
      } else {
        setCreatedUrl(result.url)
        // If server returned a generated name (e.g., conflict or empty input), update the input field
        if (result.generatedName) {
          setSiteName(result.generatedName)
        }
      }
    } catch (error) {
      console.error("Failed to create site:", error)
      setError("An unexpected error occurred. Please try again.")
    } finally {
      setIsSubmitting(false)
    }
  }

  const copyToClipboard = () => {
    navigator.clipboard.writeText(createdUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Basic HTML validation
  const validateHtml = (html: string): boolean => {
    // Check for basic HTML structure
    const hasHtmlTags = /<html.*?>[\s\S]*?<\/html>/i.test(html)
    const hasBodyTags = /<body.*?>[\s\S]*?<\/body>/i.test(html)

    return hasHtmlTags && hasBodyTags
  }

  const isValidHtml = html ? validateHtml(html) : true

  return (
    <div className="max-w-4xl mx-auto">
      <Card className="p-6 bg-gray-900 border-gray-800 shadow-xl">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="siteName" className="block text-sm font-medium mb-2 text-gray-300">
              站点名称（可选）
            </label>
            <Input
              id="siteName"
              value={siteName}
              onChange={(e) => setSiteName(e.target.value)}
              placeholder="留空则随机生成的名称"
              className="bg-gray-800 border-gray-700 text-white"
            />
            <p className="mt-2 text-sm text-gray-400">
              您的网站将在以下地址可用: {" "}
              <span className="text-purple-400">play.linecode.top/{siteName || "[random-name]"}</span>
            </p>
            <p className="mt-1 text-sm text-amber-400">公开链接自创建起 7 天内有效。</p>
          </div>

          <div>
            <div className="flex justify-between items-center mb-2">
              <label htmlFor="html" className="block text-sm font-medium text-gray-300">
                HTML 源码
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowPreview(!showPreview)}
                className="text-gray-400 hover:text-white"
              >
                <Eye className="h-4 w-4 mr-1" />
                {showPreview ? "隐藏预览" : "显示预览"}
              </Button>
            </div>
            <Textarea
              id="html"
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              placeholder="<html><head><title>My Site</title></head><body><h1>Hello World!</h1></body></html>"
              className="min-h-[300px] bg-gray-800 border-gray-700 text-white font-mono"
              required
            />

            {html && !isValidHtml && (
              <p className="mt-2 text-sm text-amber-500 flex items-center">
                <AlertCircle className="h-4 w-4 mr-1" />
                警告：您的 HTML 可能缺少必需的标签（html, body）
              </p>
            )}
          </div>

          {showPreview && html && (
            <div className="border border-gray-700 rounded-md overflow-hidden">
              <div className="bg-gray-800 px-4 py-2 text-sm text-gray-400 border-b border-gray-700">预览</div>
              <div className="bg-white p-4 h-[300px] overflow-auto">
                <iframe srcDoc={html} title="Preview" className="w-full h-full border-0" sandbox="allow-scripts" />
              </div>
            </div>
          )}

          {error && (
            <Alert variant="destructive" className="bg-red-900/50 border-red-800 text-red-200">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button
            type="submit"
            disabled={isSubmitting || !html}
            className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                创建中...
              </>
            ) : (
              "创建站点"
            )}
          </Button>
        </form>

        {createdUrl && (
          <div className="mt-6 p-4 bg-gray-800 rounded-md border border-gray-700">
            <p className="text-sm text-gray-300 mb-2">您的站点已创建！</p>
            <div className="flex items-center">
              <Input value={createdUrl} readOnly className="bg-gray-700 border-gray-600 text-white" />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn("ml-2", copied ? "text-green-500" : "text-gray-400 hover:text-white")}
                onClick={copyToClipboard}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <div className="mt-4">
              <Button
                type="button"
                variant="outline"
                className="w-full border-gray-700 text-gray-300 hover:bg-gray-800"
                onClick={() => window.open(createdUrl, "_blank")}
              >
                访问站点
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}

