import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"

async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}

function zip(entries) {
  const local = []
  const central = []
  let offset = 0
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name)
    const body = Buffer.from(content)
    const checksum = crc32(body)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(body.length, 18)
    header.writeUInt32LE(body.length, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    local.push(header, nameBytes, body)

    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt32LE(checksum, 16)
    directory.writeUInt32LE(body.length, 20)
    directory.writeUInt32LE(body.length, 24)
    directory.writeUInt16LE(nameBytes.length, 28)
    directory.writeUInt32LE(offset, 42)
    central.push(directory, nameBytes)
    offset += header.length + nameBytes.length + body.length
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBytes, end])
}

async function startApp(t) {
  const port = await freePort()
  const root = await mkdtemp(path.join(tmpdir(), "linecode-site-test-"))
  const origin = `http://127.0.0.1:${port}`
  const bin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next")
  const app = spawn(process.execPath, [bin, "dev", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SITES_DIR: root,
      SITE_PUBLIC_BASE_URL: origin,
      ADMIN_USERNAME: "test-admin",
      ADMIN_PASSWORD: "test-password-very-long",
      ADMIN_SESSION_SECRET: "test-secret-32-bytes-long-and-random-enough",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  app.stdout.on("data", (chunk) => { output += String(chunk) })
  app.stderr.on("data", (chunk) => { output += String(chunk) })
  t.after(async () => {
    app.kill()
    await delay(500)
    await rm(root, { recursive: true, force: true })
  })
  for (let attempt = 0; attempt < 120; attempt++) {
    if (app.exitCode !== null) throw new Error(`Next exited early:\n${output}`)
    try {
      const response = await fetch(`${origin}/api/health`)
      if (response.status === 200) return { origin, root }
    } catch {}
    await delay(500)
  }
  throw new Error(`Next did not become ready:\n${output}`)
}

async function create(origin, fields) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  const response = await fetch(`${origin}/api/sites`, { method: "POST", body: form })
  return { response, body: await response.json() }
}

test("HTML and ZIP publishing, review, and expiry", { timeout: 180_000 }, async (t) => {
  const { origin, root } = await startApp(t)

  const html = await create(origin, {
    kind: "html",
    html: "<html><body><h1>Shared page</h1></body></html>",
    expiresInHours: "24",
  })
  assert.equal(html.response.status, 201)
  assert.equal(html.body.status, "active")
  const page = await fetch(`${origin}/${html.body.name}`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /Shared page/)
  assert.match(page.headers.get("content-security-policy"), /sandbox allow-scripts/)

  const uploadedHtml = await create(origin, {
    kind: "file",
    file: new File(["<html><body><h1>Uploaded HTML</h1></body></html>"], "page.html", { type: "text/html" }),
    expiresInHours: "24",
  })
  assert.equal(uploadedHtml.response.status, 201)
  assert.equal(uploadedHtml.body.status, "active")
  assert.match(await (await fetch(`${origin}/${uploadedHtml.body.name}`)).text(), /Uploaded HTML/)

  const archive = zip([
    ["index.html", "<html><body><link rel='stylesheet' href='style.css'>ZIP page</body></html>"],
    ["style.css", "body { color: red }"],
  ])
  const zipped = await create(origin, {
    kind: "file",
    file: new File([archive], "site.zip", { type: "application/zip" }),
    expiresInHours: "72",
  })
  assert.equal(zipped.response.status, 201)
  assert.equal(zipped.body.status, "active")
  const zipPage = await fetch(`${origin}/${zipped.body.name}`)
  assert.equal(zipPage.status, 200)
  assert.match(await zipPage.text(), new RegExp(`<base href="/${zipped.body.name}/">`))
  const asset = await fetch(`${origin}/${zipped.body.name}/style.css`)
  assert.equal(asset.status, 200)
  assert.match(await asset.text(), /color: red/)

  const review = await create(origin, {
    kind: "html",
    html: "<html><body><input type='password'></body></html>",
  })
  assert.equal(review.body.status, "review")
  assert.equal((await fetch(`${origin}/${review.body.name}`)).status, 404)

  const metaPath = path.join(root, html.body.name, "site.json")
  const meta = JSON.parse(await readFile(metaPath, "utf8"))
  meta.expiresAt = new Date(Date.now() - 1000).toISOString()
  await writeFile(metaPath, JSON.stringify(meta))
  assert.equal((await fetch(`${origin}/${html.body.name}`)).status, 410)
  meta.status = "disabled"
  meta.expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString()
  meta.disabledAt = new Date().toISOString()
  await writeFile(metaPath, JSON.stringify(meta))
  assert.equal((await fetch(`${origin}/${html.body.name}`)).status, 404)

  meta.expiresAt = new Date(Date.now() - 31 * 24 * 3600_000).toISOString()
  await writeFile(metaPath, JSON.stringify(meta))
  const nextSite = await create(origin, {
    kind: "html",
    html: "<html><body>Cleanup trigger</body></html>",
  })
  assert.equal(nextSite.response.status, 201)
  await assert.rejects(readFile(metaPath, "utf8"), { code: "ENOENT" })

  const unsafe = await create(origin, {
    kind: "file",
    file: new File([zip([["../escape.html", "<html><body>x</body></html>"], ["index.html", "<html><body>x</body></html>"]])], "unsafe.zip"),
  })
  assert.equal(unsafe.response.status, 400)
})
