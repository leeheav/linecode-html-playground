import { CreateSite } from "@/components/create-site"
import Link from "next/link"

export default function HomePage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="container mx-auto px-4 py-12 max-w-5xl">
        <div className="mb-8 text-center space-y-3">
          <h1 className="text-4xl sm:text-5xl font-bold bg-gradient-to-r from-purple-500 via-pink-500 to-red-500 text-transparent bg-clip-text animate-gradient tracking-tight">
            HTML Playground
          </h1>
          <p className="text-muted-foreground max-w-2xl mx-auto text-sm sm:text-base leading-relaxed">
            支持粘贴 HTML 源码或上传 HTML / ZIP 压缩包，可自定义站点名称与 1 至 30 天有效期，通过基础安全检查后即可获得专属分享链接。
          </p>
        </div>

        <CreateSite />

        <Link href="/ldpadmin" className="hidden" aria-hidden="true" tabIndex={-1}>
          Admin
        </Link>
      </div>
    </main>
  )
}
