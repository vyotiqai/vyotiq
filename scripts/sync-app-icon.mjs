import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(root, 'resources', 'branding', 'identity', 'vyotiq.com-dark.png')
const runtimePath = path.join(root, 'resources', 'icon.png')
const outputPath = path.join(root, 'resources', 'icon.ico')
const sizes = [16, 24, 32, 48, 64, 128, 256]

function iconDirectory(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  const entries = Buffer.alloc(images.length * 16)
  let offset = header.length + entries.length
  images.forEach(({ size, data }, index) => {
    const entryOffset = index * 16
    entries.writeUInt8(size === 256 ? 0 : size, entryOffset)
    entries.writeUInt8(size === 256 ? 0 : size, entryOffset + 1)
    entries.writeUInt8(0, entryOffset + 2)
    entries.writeUInt8(0, entryOffset + 3)
    entries.writeUInt16LE(1, entryOffset + 4)
    entries.writeUInt16LE(32, entryOffset + 6)
    entries.writeUInt32LE(data.length, entryOffset + 8)
    entries.writeUInt32LE(offset, entryOffset + 12)
    offset += data.length
  })

  return Buffer.concat([header, entries, ...images.map(({ data }) => data)])
}

const source = await readFile(sourcePath)
const runtimePng = await sharp(source).resize(1024, 1024, { fit: 'cover' }).png().toBuffer()
const images = await Promise.all(
  sizes.map(async (size) => ({
    size,
    data: await sharp(source).resize(size, size, { fit: 'cover' }).png().toBuffer()
  }))
)

await writeFile(runtimePath, runtimePng)
await writeFile(outputPath, iconDirectory(images))
console.log(
  `[sync-app-icon] synced identity artwork to ${path.relative(root, runtimePath)} and ${path.relative(root, outputPath)}`
)
