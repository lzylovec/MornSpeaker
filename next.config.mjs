import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const configDir = dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  serverExternalPackages: ["@prisma/client", "prisma", "@prisma/adapter-mariadb", "mariadb", "bcryptjs", "@xenova/transformers", "onnxruntime-node", "sharp", "alipay-sdk"],
  output: "standalone",
  outputFileTracingRoot: configDir,
  images: {
    unoptimized: true,
  },
}

export default nextConfig
