"use client"

import type React from "react"
import { useState, useEffect, useCallback, useMemo } from "react"
import { useRouter } from "next/navigation"
import {
  adminLogin,
  adminLogout,
  approveSite,
  changeSiteExpiry,
  checkAdminSession,
  deleteSite,
  getAllSites,
  getSiteHtmlForAdmin,
  purgeSiteForAdmin,
  renameSite,
  restoreSite,
} from "@/app/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import {
  Eye,
  Trash2,
  Edit2,
  LogOut,
  Search,
  X,
  RefreshCw,
  AlertTriangle,
  FolderArchive,
  FileCode,
  ShieldCheck,
  ShieldAlert,
  Loader2,
} from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { cn } from "@/lib/utils"

interface Site {
  name: string
  createdAt: Date
  expiresAt: Date
  expired: boolean
  version: 1 | 2
  status: "active" | "review" | "disabled" | "rejected"
  inputType?: "html" | "file" | "zip"
  findings?: string[]
}

type StatusFilter = "all" | "review" | "active" | "disabled" | "expired"

export default function AdminPage() {
  const router = useRouter()
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isCheckingSession, setIsCheckingSession] = useState(true)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [loginError, setLoginError] = useState("")
  const [sites, setSites] = useState<Site[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [newName, setNewName] = useState("")
  const [error, setError] = useState("")
  const [previewName, setPreviewName] = useState<string | null>(null)
  const [previewHtml, setPreviewHtml] = useState("")
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const itemsPerPage = 10

  // 搜索与状态筛选
  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")

  const loadSites = useCallback(async () => {
    setIsLoading(true)
    try {
      const result = await getAllSites()
      if (result.unauthorized) {
        setIsAuthenticated(false)
        setSites([])
        setLoginError(result.error || "会话已过期，请重新登录")
      } else {
        setSites(result.sites)
        setError(result.error || "")
      }
    } catch {
      setError("加载站点失败")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    checkAdminSession()
      .then((authenticated) => {
        if (!cancelled) setIsAuthenticated(authenticated)
      })
      .finally(() => {
        if (!cancelled) setIsCheckingSession(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (isAuthenticated) {
      void loadSites()
    }
  }, [isAuthenticated, loadSites])

  // 真实统计计算（不使用假数字）
  const counts = useMemo(() => {
    const now = Date.now()
    return {
      all: sites.length,
      review: sites.filter((s) => s.status === "review").length,
      active: sites.filter((s) => s.status === "active" && !s.expired && new Date(s.expiresAt).getTime() > now).length,
      disabled: sites.filter((s) => s.status === "disabled").length,
      expired: sites.filter((s) => s.expired || (s.status === "active" && new Date(s.expiresAt).getTime() <= now)).length,
    }
  }, [sites])

  // 综合筛选列表
  const filteredSites = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    const now = Date.now()
    return sites.filter((site) => {
      if (query && !site.name.toLowerCase().includes(query)) {
        return false
      }
      const isExpired = site.expired || (site.status === "active" && new Date(site.expiresAt).getTime() <= now)
      if (statusFilter === "review") return site.status === "review"
      if (statusFilter === "disabled") return site.status === "disabled"
      if (statusFilter === "expired") return isExpired
      if (statusFilter === "active") return site.status === "active" && !isExpired
      return true
    })
  }, [sites, searchQuery, statusFilter])

  // 筛选或搜索变化时重置页码
  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, statusFilter])

  const totalPages = Math.max(1, Math.ceil(filteredSites.length / itemsPerPage))
  const startIndex = (currentPage - 1) * itemsPerPage
  const currentSites = filteredSites.slice(startIndex, startIndex + itemsPerPage)

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoginError("")
    const result = await adminLogin(username, password)
    if (result.success) {
      setIsAuthenticated(true)
    } else {
      setLoginError(result.error || "登录失败")
    }
  }

  const handleSiteAction = async (
    siteName: string,
    action: () => Promise<{ success: boolean; error?: string }>
  ) => {
    setError("")
    setActionLoading(siteName)
    try {
      const result = await action()
      if (result.success) {
        await loadSites()
      } else {
        if (result.error === "未登录或会话已过期") {
          setIsAuthenticated(false)
          setSites([])
          setLoginError(result.error)
          return
        }
        setError(result.error || "操作失败")
      }
    } catch {
      setError("网络操作失败，请重试")
    } finally {
      setActionLoading(null)
    }
  }

  const handleDelete = async (site: Site) => {
    const prompt =
      site.version === 2
        ? `确定下线站点 "${site.name}" 吗？\n\n公开访问链接将立即失效，服务器上仍保留原始文件，后续随时可点击“恢复”。`
        : `旧版站点 "${site.name}" 暂不支持下线归档，确定永久删除吗？`
    if (!confirm(prompt)) return
    await handleSiteAction(site.name, () => deleteSite(site.name))
  }

  const handlePurge = async (site: Site) => {
    const prompt = `确定彻底清除站点 "${site.name}" 及其所有存储文件吗？\n\n警告：此操作将从 SQLite 数据库和磁盘物理移除，完全不可恢复！`
    if (!confirm(prompt)) return
    await handleSiteAction(site.name, () => purgeSiteForAdmin(site.name))
  }

  const handleRename = async () => {
    if (!editingName || !newName.trim()) return
    setError("")
    setActionLoading(editingName)
    try {
      const result = await renameSite(editingName, newName.trim())
      if (result.success) {
        setEditingName(null)
        setNewName("")
        await loadSites()
      } else {
        if (result.error === "未登录或会话已过期") {
          setIsAuthenticated(false)
          setSites([])
          setEditingName(null)
          setLoginError(result.error)
          return
        }
        setError(result.error || "重命名失败")
      }
    } finally {
      setActionLoading(null)
    }
  }

  const handleView = async (siteName: string) => {
    setError("")
    setPreviewName(siteName)
    setPreviewHtml("")
    setIsPreviewLoading(true)
    const result = await getSiteHtmlForAdmin(siteName)
    setIsPreviewLoading(false)

    if (result.unauthorized) {
      setPreviewName(null)
      setIsAuthenticated(false)
      setSites([])
      setLoginError(result.error || "会话已过期，请重新登录")
      return
    }
    if (!result.html) {
      setPreviewName(null)
      setError(result.error || "读取站点文件失败")
      return
    }
    setPreviewHtml(result.html)
  }

  const handleLogout = async () => {
    await adminLogout()
    setIsAuthenticated(false)
    setSites([])
    setUsername("")
    setPassword("")
    router.push("/")
  }

  const formatDate = (date: Date) => {
    return new Date(date).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
  }

  if (isCheckingSession) {
    return (
      <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>正在验证管理员会话...</span>
        </div>
      </main>
    )
  }

  if (!isAuthenticated) {
    return (
      <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
        <Card className="w-full max-w-md p-6 sm:p-8 bg-card border-border shadow-xl">
          <div className="mb-6 text-center space-y-1">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">管理员登录</h1>
            <p className="text-xs text-muted-foreground">请输入管理员凭据以管理公开站点</p>
          </div>
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label htmlFor="username" className="block text-sm font-medium mb-1.5 text-foreground/90">
                用户名
              </label>
              <Input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="bg-muted/40 border-input text-foreground"
                autoComplete="username"
                required
              />
            </div>
            <div>
              <label htmlFor="password" className="block text-sm font-medium mb-1.5 text-foreground/90">
                密码
              </label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="bg-muted/40 border-input text-foreground"
                autoComplete="current-password"
                required
              />
            </div>
            {loginError && (
              <Alert variant="destructive" className="bg-destructive/20 border-destructive/50 text-destructive-foreground">
                <AlertDescription>{loginError}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" className="w-full bg-purple-600 hover:bg-purple-700 text-white font-medium">
              登录管理后台
            </Button>
          </form>
        </Card>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="container mx-auto px-4 py-8 max-w-7xl">
        {/* 页头 */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">站点管理</h1>
            <p className="text-xs sm:text-sm text-muted-foreground mt-1">
              审查待发布内容、调整有效期、执行下线归档或彻底物理清除
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={() => void loadSites()}
              variant="outline"
              size="sm"
              disabled={isLoading}
              className="border-border text-foreground hover:bg-muted"
            >
              <RefreshCw className={cn("h-4 w-4 mr-1.5", isLoading && "animate-spin")} />
              刷新
            </Button>
            <Button
              onClick={handleLogout}
              variant="outline"
              size="sm"
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <LogOut className="h-4 w-4 mr-1.5" />
              退出
            </Button>
          </div>
        </div>

        {error && (
          <Alert variant="destructive" className="mb-6 bg-destructive/20 border-destructive/50 text-destructive-foreground">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* 统计指标与筛选标签 */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 sm:gap-3 mb-6">
          <button
            type="button"
            onClick={() => setStatusFilter("all")}
            className={cn(
              "p-3 rounded-lg border text-left transition-all",
              statusFilter === "all"
                ? "bg-purple-950/40 border-purple-500/80 text-foreground ring-1 ring-purple-500/50"
                : "bg-card border-border hover:bg-muted/40 text-muted-foreground"
            )}
          >
            <div className="text-xs font-medium">全部站点</div>
            <div className="text-xl font-bold text-foreground mt-0.5">{counts.all}</div>
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter("review")}
            className={cn(
              "p-3 rounded-lg border text-left transition-all",
              statusFilter === "review"
                ? "bg-amber-950/40 border-amber-500/80 text-amber-200 ring-1 ring-amber-500/50"
                : "bg-card border-border hover:bg-muted/40 text-muted-foreground"
            )}
          >
            <div className="text-xs font-medium flex items-center justify-between">
              <span>待审核</span>
              {counts.review > 0 && <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />}
            </div>
            <div className={cn("text-xl font-bold mt-0.5", counts.review > 0 ? "text-amber-400" : "text-foreground")}>
              {counts.review}
            </div>
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter("active")}
            className={cn(
              "p-3 rounded-lg border text-left transition-all",
              statusFilter === "active"
                ? "bg-emerald-950/40 border-emerald-500/80 text-emerald-200 ring-1 ring-emerald-500/50"
                : "bg-card border-border hover:bg-muted/40 text-muted-foreground"
            )}
          >
            <div className="text-xs font-medium">正常有效</div>
            <div className="text-xl font-bold text-emerald-400 mt-0.5">{counts.active}</div>
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter("disabled")}
            className={cn(
              "p-3 rounded-lg border text-left transition-all",
              statusFilter === "disabled"
                ? "bg-muted border-border text-foreground ring-1 ring-muted-foreground/50"
                : "bg-card border-border hover:bg-muted/40 text-muted-foreground"
            )}
          >
            <div className="text-xs font-medium">已下线</div>
            <div className="text-xl font-bold text-muted-foreground mt-0.5">{counts.disabled}</div>
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter("expired")}
            className={cn(
              "p-3 rounded-lg border text-left transition-all col-span-2 sm:col-span-1",
              statusFilter === "expired"
                ? "bg-red-950/40 border-red-500/80 text-red-200 ring-1 ring-red-500/50"
                : "bg-card border-border hover:bg-muted/40 text-muted-foreground"
            )}
          >
            <div className="text-xs font-medium">已过期</div>
            <div className="text-xl font-bold text-red-400 mt-0.5">{counts.expired}</div>
          </button>
        </div>

        {/* 搜索与工具栏 */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="按站点名称搜索..."
              className="pl-9 pr-8 bg-card border-border text-foreground"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="清空搜索"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="text-xs text-muted-foreground sm:text-right shrink-0">
            找到 <span className="font-semibold text-foreground">{filteredSites.length}</span> 条记录
            {searchQuery && <span>（从 {sites.length} 条中筛选）</span>}
          </div>
        </div>

        {/* 主列表卡片 */}
        <Card className="bg-card border-border shadow-lg overflow-hidden">
          {isLoading ? (
            <div className="p-12 text-center text-muted-foreground flex flex-col items-center justify-center gap-2">
              <Loader2 className="h-6 w-6 animate-spin text-purple-400" />
              <span>正在加载站点数据...</span>
            </div>
          ) : filteredSites.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground space-y-3">
              <p className="text-base text-foreground/80">未找到匹配的站点记录</p>
              {(searchQuery || statusFilter !== "all") && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSearchQuery("")
                    setStatusFilter("all")
                  }}
                  className="border-border text-muted-foreground hover:text-foreground"
                >
                  清空筛选与搜索
                </Button>
              )}
            </div>
          ) : (
            <>
              {/* 桌面端表格视图 (>= 768px) */}
              <div className="hidden md:block overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border hover:bg-transparent">
                      <TableHead className="text-muted-foreground w-[220px]">站点名称</TableHead>
                      <TableHead className="text-muted-foreground w-[90px]">类型</TableHead>
                      <TableHead className="text-muted-foreground w-[160px]">创建时间</TableHead>
                      <TableHead className="text-muted-foreground">公开状态 / 有效期</TableHead>
                      <TableHead className="text-muted-foreground text-right w-[340px]">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {currentSites.map((site) => {
                      const isExpired = site.expired || (site.status === "active" && new Date(site.expiresAt).getTime() <= Date.now())
                      const isRowLoading = actionLoading === site.name

                      return (
                        <TableRow key={site.name} className="border-border hover:bg-muted/40 transition-colors">
                          <TableCell className="font-medium text-foreground">
                            <div className="flex items-center gap-1.5 max-w-[200px]" title={site.name}>
                              <span className="truncate font-mono">{site.name}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            {site.version === 1 ? (
                              <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">v1 单页</span>
                            ) : site.inputType === "zip" ? (
                              <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/40 flex items-center gap-1 w-fit">
                                <FolderArchive className="h-3 w-3" /> ZIP
                              </span>
                            ) : (
                              <span className="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/40 flex items-center gap-1 w-fit">
                                <FileCode className="h-3 w-3" /> HTML
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                            {formatDate(site.createdAt)}
                          </TableCell>
                          <TableCell>
                            {site.status === "review" ? (
                              <div className="space-y-0.5">
                                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40">
                                  <ShieldAlert className="h-3 w-3 shrink-0" />
                                  待审核
                                </span>
                                {site.findings && site.findings.length > 0 && (
                                  <div className="text-xs text-amber-400/90 truncate max-w-[260px]" title={site.findings.join("；")}>
                                    {site.findings.join("；")}
                                  </div>
                                )}
                              </div>
                            ) : site.status === "disabled" ? (
                              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border">
                                已下线（文件保留中）
                              </span>
                            ) : isExpired ? (
                              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-300 border border-red-500/40">
                                已到期（文件保留中）
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                                <ShieldCheck className="h-3 w-3 shrink-0" />
                                有效至 {formatDate(site.expiresAt)}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1.5 flex-wrap">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleView(site.name)}
                                aria-label={`沙箱预览 ${site.name}`}
                                disabled={isRowLoading}
                                className="h-8 px-2 text-blue-400 hover:text-blue-300 hover:bg-blue-950/40"
                              >
                                <Eye className="h-4 w-4 mr-1" />
                                预览
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setEditingName(site.name)
                                  setNewName(site.name)
                                  setError("")
                                }}
                                aria-label={`重命名 ${site.name}`}
                                disabled={isRowLoading}
                                className="h-8 px-2 text-yellow-400 hover:text-yellow-300 hover:bg-yellow-950/40"
                              >
                                <Edit2 className="h-4 w-4 mr-1" />
                                改名
                              </Button>

                              {site.version === 2 && site.status === "review" && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={isRowLoading}
                                  className="h-8 px-2 text-amber-300 hover:text-amber-200 hover:bg-amber-950/40 font-medium"
                                  onClick={() => handleSiteAction(site.name, () => approveSite(site.name))}
                                >
                                  通过
                                </Button>
                              )}

                              {site.version === 2 && site.status === "disabled" && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={isRowLoading}
                                  className="h-8 px-2 text-emerald-300 hover:text-emerald-200 hover:bg-emerald-950/40 font-medium"
                                  onClick={() => handleSiteAction(site.name, () => restoreSite(site.name))}
                                >
                                  恢复
                                </Button>
                              )}

                              {site.version === 2 && (
                                <select
                                  aria-label={`调整 ${site.name} 的有效期`}
                                  defaultValue=""
                                  disabled={isRowLoading}
                                  className="h-8 rounded bg-muted/60 border border-input px-2 text-xs text-foreground focus:outline-none"
                                  onChange={(event) => {
                                    const hours = Number(event.currentTarget.value)
                                    event.currentTarget.value = ""
                                    if (hours) void handleSiteAction(site.name, () => changeSiteExpiry(site.name, hours))
                                  }}
                                >
                                  <option value="">调整期限</option>
                                  <option value="24">延长至 1 天后</option>
                                  <option value="72">延长至 3 天后</option>
                                  <option value="168">延长至 7 天后</option>
                                  <option value="720">延长至 30 天后</option>
                                </select>
                              )}

                              {site.status !== "disabled" && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => handleDelete(site)}
                                  disabled={isRowLoading}
                                  className="h-8 px-2 text-destructive hover:text-destructive/80 hover:bg-destructive/20"
                                  aria-label={site.version === 2 ? `下线 ${site.name}` : `删除 ${site.name}`}
                                >
                                  <Trash2 className="h-4 w-4 mr-1" />
                                  下线
                                </Button>
                              )}

                              {site.version === 2 && (site.status === "disabled" || isExpired) && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={isRowLoading}
                                  className="h-8 px-2 text-red-500 hover:text-red-400 hover:bg-red-950/50 text-xs font-semibold"
                                  onClick={() => handlePurge(site)}
                                >
                                  彻底清除
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* 移动端卡片视图 (< 768px，专为 375px 小屏优化) */}
              <div className="block md:hidden divide-y divide-border">
                {currentSites.map((site) => {
                  const isExpired = site.expired || (site.status === "active" && new Date(site.expiresAt).getTime() <= Date.now())
                  const isRowLoading = actionLoading === site.name

                  return (
                    <div key={site.name} className="p-4 space-y-3">
                      {/* 卡片头部 */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="space-y-1 min-w-0 flex-1">
                          <div className="font-semibold text-foreground font-mono text-base break-all">
                            {site.name}
                          </div>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {site.version === 1 ? (
                              <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">v1 单页</span>
                            ) : site.inputType === "zip" ? (
                              <span className="text-[11px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/40 flex items-center gap-1">
                                <FolderArchive className="h-2.5 w-2.5" /> ZIP
                              </span>
                            ) : (
                              <span className="text-[11px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/40 flex items-center gap-1">
                                <FileCode className="h-2.5 w-2.5" /> HTML
                              </span>
                            )}

                            {site.status === "review" ? (
                              <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40">
                                待审核
                              </span>
                            ) : site.status === "disabled" ? (
                              <span className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border">
                                已下线
                              </span>
                            ) : isExpired ? (
                              <span className="text-[11px] px-2 py-0.5 rounded-full bg-red-500/20 text-red-300 border border-red-500/40">
                                已到期
                              </span>
                            ) : (
                              <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                                正常公开
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* 规则检出警示 */}
                      {site.status === "review" && site.findings && site.findings.length > 0 && (
                        <div className="p-2 rounded bg-amber-950/30 border border-amber-800/50 text-xs text-amber-300/90 space-y-0.5">
                          <div className="font-medium text-amber-200 flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3 shrink-0" />
                            检出安全规则命中：
                          </div>
                          <div>{site.findings.join("；")}</div>
                        </div>
                      )}

                      {/* 时间信息 */}
                      <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground pt-1 border-t border-border/40">
                        <div>
                          <span className="text-foreground/70">创建时间：</span>
                          <div>{formatDate(site.createdAt)}</div>
                        </div>
                        <div>
                          <span className="text-foreground/70">有效期至：</span>
                          <div>{formatDate(site.expiresAt)}</div>
                        </div>
                      </div>

                      {/* 移动端操作按钮组 */}
                      <div className="flex flex-wrap items-center gap-1.5 pt-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleView(site.name)}
                          disabled={isRowLoading}
                          className="h-8 text-xs border-border text-blue-400 hover:bg-blue-950/40 flex-1 min-w-[70px]"
                        >
                          <Eye className="h-3.5 w-3.5 mr-1" />
                          预览
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditingName(site.name)
                            setNewName(site.name)
                            setError("")
                          }}
                          disabled={isRowLoading}
                          className="h-8 text-xs border-border text-yellow-400 hover:bg-yellow-950/40 flex-1 min-w-[70px]"
                        >
                          <Edit2 className="h-3.5 w-3.5 mr-1" />
                          改名
                        </Button>

                        {site.version === 2 && site.status === "review" && (
                          <Button
                            size="sm"
                            disabled={isRowLoading}
                            className="h-8 text-xs bg-amber-600 hover:bg-amber-700 text-white font-medium flex-1 min-w-[80px]"
                            onClick={() => handleSiteAction(site.name, () => approveSite(site.name))}
                          >
                            审核通过
                          </Button>
                        )}

                        {site.version === 2 && site.status === "disabled" && (
                          <Button
                            size="sm"
                            disabled={isRowLoading}
                            className="h-8 text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-medium flex-1 min-w-[80px]"
                            onClick={() => handleSiteAction(site.name, () => restoreSite(site.name))}
                          >
                            恢复上线
                          </Button>
                        )}

                        {site.version === 2 && (
                          <select
                            aria-label={`调整 ${site.name} 的有效期`}
                            defaultValue=""
                            disabled={isRowLoading}
                            className="h-8 rounded bg-muted/60 border border-input px-2 text-xs text-foreground flex-1 min-w-[100px]"
                            onChange={(event) => {
                              const hours = Number(event.currentTarget.value)
                              event.currentTarget.value = ""
                              if (hours) void handleSiteAction(site.name, () => changeSiteExpiry(site.name, hours))
                            }}
                          >
                            <option value="">调整期限</option>
                            <option value="24">1 天后到期</option>
                            <option value="72">3 天后到期</option>
                            <option value="168">7 天后到期</option>
                            <option value="720">30 天后到期</option>
                          </select>
                        )}

                        {site.status !== "disabled" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleDelete(site)}
                            disabled={isRowLoading}
                            className="h-8 text-xs border-border text-destructive hover:bg-destructive/20 flex-1 min-w-[70px]"
                          >
                            <Trash2 className="h-3.5 w-3.5 mr-1" />
                            下线
                          </Button>
                        )}

                        {site.version === 2 && (site.status === "disabled" || isExpired) && (
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={isRowLoading}
                            className="h-8 text-xs text-white font-medium w-full mt-1"
                            onClick={() => handlePurge(site)}
                          >
                            彻底清除（删除文件及数据）
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </Card>

        {/* 分页组件 */}
        {filteredSites.length > itemsPerPage && (
          <div className="flex flex-col sm:flex-row justify-between items-center mt-6 gap-4 text-xs text-muted-foreground">
            <div>
              显示第 <span className="text-foreground font-medium">{startIndex + 1}</span> 至{" "}
              <span className="text-foreground font-medium">
                {Math.min(startIndex + itemsPerPage, filteredSites.length)}
              </span>{" "}
              条，共 <span className="text-foreground font-medium">{filteredSites.length}</span> 条记录
            </div>

            <div className="flex items-center space-x-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="border-border text-foreground h-8 text-xs"
              >
                上一页
              </Button>

              <div className="flex items-center gap-1">
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let pageNum: number
                  if (totalPages <= 5) pageNum = i + 1
                  else if (currentPage <= 3) pageNum = i + 1
                  else if (currentPage >= totalPages - 2) pageNum = totalPages - 4 + i
                  else pageNum = currentPage - 2 + i

                  return (
                    <Button
                      key={pageNum}
                      variant={currentPage === pageNum ? "default" : "outline"}
                      size="sm"
                      onClick={() => setCurrentPage(pageNum)}
                      className={cn(
                        "h-8 w-8 p-0 text-xs",
                        currentPage === pageNum ? "bg-purple-600 text-white" : "border-border text-foreground"
                      )}
                    >
                      {pageNum}
                    </Button>
                  )
                })}
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="border-border text-foreground h-8 text-xs"
              >
                下一页
              </Button>
            </div>
          </div>
        )}

        {/* 修改站点名称对话框 */}
        <Dialog open={editingName !== null} onOpenChange={() => setEditingName(null)}>
          <DialogContent className="bg-card border-border text-foreground sm:max-w-md">
            <DialogHeader>
              <DialogTitle>修改站点名称</DialogTitle>
            </DialogHeader>
            <div className="py-3 space-y-2">
              <label htmlFor="newName" className="block text-sm font-medium text-foreground/90">
                新站点名称
              </label>
              <Input
                id="newName"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="1~64位字母、数字、连字符、下划线"
                className="bg-muted/40 border-input text-foreground font-mono"
              />
              <p className="text-xs text-muted-foreground">原名称：{editingName}</p>
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                variant="outline"
                onClick={() => setEditingName(null)}
                className="border-border text-muted-foreground hover:text-foreground"
              >
                取消
              </Button>
              <Button
                onClick={handleRename}
                disabled={!newName.trim() || newName.trim() === editingName}
                className="bg-purple-600 hover:bg-purple-700 text-white"
              >
                确认修改
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 后台安全沙箱预览对话框 */}
        <Dialog open={previewName !== null} onOpenChange={(open) => !open && setPreviewName(null)}>
          <DialogContent className="max-w-5xl h-[88vh] bg-card border-border text-foreground flex flex-col p-4 sm:p-6">
            <DialogHeader className="space-y-1">
              <DialogTitle className="flex items-center gap-2 text-base sm:text-lg">
                <Eye className="h-4 w-4 text-blue-400" />
                后台安全沙箱预览：<span className="font-mono text-purple-300">{previewName}</span>
              </DialogTitle>
              <p className="text-xs text-muted-foreground">
                预览运行在隔离沙箱环境中（sandbox=&quot;allow-scripts&quot;），即使公开分享已过期或被下线，管理员仍可在此查看原始网页文件。
              </p>
            </DialogHeader>

            <div className="flex-1 min-h-0 rounded-md overflow-hidden bg-white border border-border mt-2">
              {isPreviewLoading ? (
                <div className="h-full grid place-items-center text-gray-500 gap-2">
                  <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
                  <span className="text-xs">正在安全加载站点文件...</span>
                </div>
              ) : (
                <iframe
                  title={`站点 ${previewName || ""} 的后台预览`}
                  srcDoc={previewHtml}
                  sandbox="allow-scripts"
                  referrerPolicy="no-referrer"
                  className="w-full h-full border-0"
                />
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </main>
  )
}
