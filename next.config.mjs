import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const configDir = dirname(fileURLToPath(import.meta.url))

const resolveAllowedDevOrigin = (rawValue) => {
  const value = String(rawValue ?? '').trim()
  if (!value) return null

  try {
    const normalized = value.includes('://') ? value : `https://${value}`
    return new URL(normalized).host
  } catch {
    return null
  }
}

const tunnelHost = resolveAllowedDevOrigin(process.env.DEV_TUNNEL_ORIGIN)
const allowedDevOrigins = tunnelHost ? [tunnelHost] : undefined

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  allowedDevOrigins,
  serverExternalPackages: ["@prisma/client", "prisma", "@prisma/adapter-mariadb", "mariadb", "bcryptjs", "@xenova/transformers", "onnxruntime-node", "sharp", "alipay-sdk"],
  output: "standalone",
  outputFileTracingRoot: configDir,
  images: {
    unoptimized: true,
  },
}

export default nextConfig
