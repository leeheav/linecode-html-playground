"use client"

import type React from "react"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import {
  adminLogin,
  adminLogout,
  checkAdminSession,
  deleteSite,
  getAllSites,
  renameSite,
} from "@/app/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Eye, Trash2, Edit2, LogOut } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"

interface Site {
  name: string
  html: string
  createdAt: Date
}

export default function AdminPage() {
  const router = useRouter()
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isCheckingSession, setIsCheckingSession] = useState(true)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [loginError, setLoginError] = useState("")
  const [sites, setSites] = useState<Site[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [newName, setNewName] = useState("")
  const [error, setError] = useState("")
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage] = useState(10)

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
      loadSites()
    }
  }, [isAuthenticated])

  const loadSites = async () => {
    setIsLoading(true)
    const result = await getAllSites()

    if (result.unauthorized) {
      setIsAuthenticated(false)
      setSites([])
      setLoginError(result.error || "会话已过期，请重新登录")
    } else {
      setSites(result.sites)
      setError(result.error || "")
    }
    setIsLoading(false)
  }

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

  const handleDelete = async (siteName: string) => {
    if (!confirm(`确定要删除站点 "${siteName}" 吗？`)) {
      return
    }

    const result = await deleteSite(siteName)
    if (result.success) {
      await loadSites()
    } else {
      if (result.error === "未登录或会话已过期") {
        setIsAuthenticated(false)
        setSites([])
        setLoginError(result.error)
        return
      }
      setError(result.error || "删除失败")
    }
  }

  const handleRename = async () => {
    if (!editingName || !newName) return

    setError("")
    const result = await renameSite(editingName, newName)
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
  }

  const handleView = (siteName: string) => {
    window.open(`/${siteName}`, "_blank")
  }

  const handleLogout = async () => {
    await adminLogout()
    setIsAuthenticated(false)
    setSites([])
    setUsername("")
    setPassword("")
    router.push("/")
  }

  if (isCheckingSession) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center">
        <p className="text-gray-400">正在验证管理员会话...</p>
      </main>
    )
  }

  const formatDate = (date: Date) => {
    return new Date(date).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  }

  // 分页计算
  const totalPages = Math.ceil(sites.length / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex = startIndex + itemsPerPage
  const currentSites = sites.slice(startIndex, endIndex)

  const handlePageChange = (page: number) => {
    setCurrentPage(page)
  }

  if (!isAuthenticated) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center">
        <Card className="w-full max-w-md p-8 bg-gray-900 border-gray-800">
          <h1 className="text-2xl font-bold mb-6 text-center">管理员登录</h1>
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label htmlFor="username" className="block text-sm font-medium mb-2 text-gray-300">
                用户名
              </label>
              <Input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="bg-gray-800 border-gray-700 text-white"
                required
              />
            </div>
            <div>
              <label htmlFor="password" className="block text-sm font-medium mb-2 text-gray-300">
                密码
              </label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="bg-gray-800 border-gray-700 text-white"
                required
              />
            </div>
            {loginError && (
              <Alert variant="destructive" className="bg-red-900/50 border-red-800 text-red-200">
                <AlertDescription>{loginError}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" className="w-full bg-purple-600 hover:bg-purple-700">
              登录
            </Button>
          </form>
        </Card>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">站点管理</h1>
          <Button onClick={handleLogout} variant="outline" className="border-gray-700 text-gray-300 bg-transparent">
            <LogOut className="h-4 w-4 mr-2" />
            退出登录
          </Button>
        </div>

        {error && (
          <Alert variant="destructive" className="mb-4 bg-red-900/50 border-red-800 text-red-200">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Card className="bg-gray-900 border-gray-800">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-gray-800 hover:bg-gray-800/50">
                  <TableHead className="text-gray-300">名称</TableHead>
                  <TableHead className="text-gray-300">创建时间</TableHead>
                  <TableHead className="text-gray-300 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-gray-400">
                      加载中...
                    </TableCell>
                  </TableRow>
                ) : currentSites.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-gray-400">
                      暂无站点
                    </TableCell>
                  </TableRow>
                ) : (
                  currentSites.map((site) => (
                    <TableRow key={site.name} className="border-gray-800 hover:bg-gray-800/50">
                      <TableCell className="font-medium text-white">{site.name}</TableCell>
                      <TableCell className="text-gray-400">{formatDate(site.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleView(site.name)}
                            className="text-blue-400 hover:text-blue-300 hover:bg-gray-800"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setEditingName(site.name)
                              setNewName(site.name)
                              setError("")
                            }}
                            className="text-yellow-400 hover:text-yellow-300 hover:bg-gray-800"
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleDelete(site.name)}
                            className="text-red-400 hover:text-red-300 hover:bg-gray-800"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </Card>

        {/* 分页组件 */}
        {sites.length > itemsPerPage && (
          <div className="flex justify-center items-center mt-6 space-x-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePageChange(currentPage - 1)}
              disabled={currentPage === 1}
              className="border-gray-700 text-gray-300 bg-transparent disabled:opacity-50"
            >
              上一页
            </Button>
            
            <div className="flex space-x-1">
              {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                let pageNum
                if (totalPages <= 5) {
                  pageNum = i + 1
                } else if (currentPage <= 3) {
                  pageNum = i + 1
                } else if (currentPage >= totalPages - 2) {
                  pageNum = totalPages - 4 + i
                } else {
                  pageNum = currentPage - 2 + i
                }
                
                return (
                  <Button
                    key={pageNum}
                    variant={currentPage === pageNum ? "default" : "outline"}
                    size="sm"
                    onClick={() => handlePageChange(pageNum)}
                    className={`${
                      currentPage === pageNum 
                        ? "bg-purple-600 hover:bg-purple-700" 
                        : "border-gray-700 text-gray-300 bg-transparent"
                    }`}
                  >
                    {pageNum}
                  </Button>
                )
              })}
            </div>
            
            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePageChange(currentPage + 1)}
              disabled={currentPage === totalPages}
              className="border-gray-700 text-gray-300 bg-transparent disabled:opacity-50"
            >
              下一页
            </Button>
            
            <span className="text-gray-400 text-sm ml-4">
              第 {currentPage} 页，共 {totalPages} 页
            </span>
            <span className="text-gray-400 text-sm">
              （共 {sites.length} 条记录）
            </span>
          </div>
        )}

        <Dialog open={editingName !== null} onOpenChange={() => setEditingName(null)}>
          <DialogContent className="bg-gray-900 border-gray-800 text-white">
            <DialogHeader>
              <DialogTitle>修改站点名称</DialogTitle>
            </DialogHeader>
            <div className="py-4">
              <label htmlFor="newName" className="block text-sm font-medium mb-2 text-gray-300">
                新名称
              </label>
              <Input
                id="newName"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="bg-gray-800 border-gray-700 text-white"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditingName(null)} className="border-gray-700 text-gray-300">
                取消
              </Button>
              <Button onClick={handleRename} className="bg-purple-600 hover:bg-purple-700">
                确认
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </main>
  )
}
