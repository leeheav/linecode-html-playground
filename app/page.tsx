import { CreateSite } from "@/components/create-site"
import Link from "next/link"

export default function HomePage() {
  return (
    <main className="min-h-screen bg-black text-white">
      <div className="container mx-auto px-4 py-12">
        <div className="mb-8 text-center">
          <h1 className="text-4xl font-bold mb-2 bg-gradient-to-r from-purple-500 via-pink-500 to-red-500 text-transparent bg-clip-text animate-gradient">
            HTML Playground
          </h1>
          <p className="text-gray-400 max-w-2xl mx-auto">
            粘贴你的 HTML 代码，给它取个名字（或者让我们为你生成一个），立即获得一个有效期为 7 天的可分享 URL。到期后文件仍会保留，仅管理员可在后台查看。
          </p>
        </div>

        <CreateSite />

        <Link href="/ldpadmin" className="hidden">
          Admin
        </Link>
      </div>
    </main>
  )
}

