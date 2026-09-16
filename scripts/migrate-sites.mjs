import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"

const SITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
const sourceDirectory = path.join(process.cwd(), "public", "sites")
const targetDirectory = process.env.SITES_DIR
  ? path.resolve(process.env.SITES_DIR)
  : path.join(process.cwd(), "data", "sites")

function validName(name) {
  return /^[a-zA-Z0-9_-]+$/.test(name)
}

async function main() {
  await fs.mkdir(targetDirectory, { recursive: true })

  let files
  try {
    files = await fs.readdir(sourceDirectory)
  } catch (error) {
    if (error && error.code === "ENOENT") {
      console.log("没有需要迁移的 public/sites 目录。")
      return
    }
    throw error
  }

  let migrated = 0
  let skipped = 0
  for (const file of files.filter((name) => name.endsWith(".html"))) {
    const name = file.slice(0, -5)
    if (!validName(name)) {
      console.warn(`跳过名称不安全的文件：${file}`)
      skipped += 1
      continue
    }

    const sourceHtml = path.join(sourceDirectory, file)
    const targetHtml = path.join(targetDirectory, file)
    const targetMetadata = path.join(targetDirectory, `${name}.meta.json`)

    try {
      await fs.access(targetHtml)
      console.warn(`目标文件已存在，保留源文件并跳过：${file}`)
      skipped += 1
      continue
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error
    }

    const stats = await fs.stat(sourceHtml)
    const now = Date.now()
    const candidate = stats.birthtimeMs > 0 && stats.birthtimeMs <= now
      ? stats.birthtimeMs
      : stats.mtimeMs
    const createdAt = new Date(candidate)
    const metadata = {
      schemaVersion: 1,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + SITE_LIFETIME_MS).toISOString(),
    }

    await fs.copyFile(sourceHtml, targetHtml, constants.COPYFILE_EXCL)
    try {
      await fs.writeFile(targetMetadata, JSON.stringify(metadata, null, 2), {
        encoding: "utf8",
        flag: "wx",
      })
    } catch (error) {
      await fs.unlink(targetHtml).catch(() => undefined)
      throw error
    }

    // 目标 HTML 和元数据均落盘后才移除旧副本，避免迁移中断造成文件丢失。
    await fs.unlink(sourceHtml)
    console.log(`已迁移：${file}`)
    migrated += 1
  }

  console.log(`迁移完成：成功 ${migrated}，跳过 ${skipped}。`)
}

main().catch((error) => {
  console.error("迁移失败，未完成的源文件仍保留在 public/sites：", error)
  process.exitCode = 1
})
