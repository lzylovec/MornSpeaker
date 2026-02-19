import { type NextRequest, NextResponse } from "next/server"
import { getMariaPool, isMariaDbConnectionError } from "@/lib/prisma"

export const runtime = "nodejs"

const isTencentTarget = () => {
  const publicTarget = String(process.env.NEXT_PUBLIC_DEPLOY_TARGET ?? "").trim().toLowerCase()
  const privateTarget = String(process.env.DEPLOY_TARGET ?? "").trim().toLowerCase()
  return publicTarget === "tencent" || privateTarget === "tencent"
}

const resolveDisplayName = (value: unknown): string | null => {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export async function GET(request: NextRequest) {
  try {
    if (!isTencentTarget()) {
      return NextResponse.json({ success: false, error: "Not supported" }, { status: 400 })
    }
    const { searchParams } = new URL(request.url)
    const userId = searchParams.get("userId")?.trim()
    const email = searchParams.get("email")?.trim()
    if (!userId && !email) {
      return NextResponse.json({ success: false, error: "Missing userId or email" }, { status: 400 })
    }
    const pool = await getMariaPool()
    const rows = await pool.query(
      email ? "SELECT name FROM `User` WHERE email = ? LIMIT 1" : "SELECT name FROM `User` WHERE id = ? LIMIT 1",
      [email || userId]
    )
    const user = Array.isArray(rows) && rows.length > 0 ? rows[0] : null
    const displayName = user?.name ?? null
    return NextResponse.json({ success: true, displayName })
  } catch (error) {
    if (isTencentTarget() && process.env.NODE_ENV !== "production" && isMariaDbConnectionError(error)) {
      return NextResponse.json({ success: true, displayName: null })
    }
    console.error("Get profile error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!isTencentTarget()) {
      return NextResponse.json({ success: false, error: "Not supported" }, { status: 400 })
    }
    const body = (await request.json()) as { userId?: string; email?: string; displayName?: string }
    const userId = body.userId?.trim()
    const email = body.email?.trim()
    const displayName = resolveDisplayName(body.displayName)
    if (!userId && !email) {
      return NextResponse.json({ success: false, error: "Missing userId or email" }, { status: 400 })
    }
    if (!displayName) {
      return NextResponse.json({ success: false, error: "Invalid displayName" }, { status: 400 })
    }
    const pool = await getMariaPool()
    if (email) {
      await pool.query("UPDATE `User` SET name = ?, updatedAt = NOW() WHERE email = ? LIMIT 1", [
        displayName,
        email,
      ])
    } else {
      await pool.query("UPDATE `User` SET name = ?, updatedAt = NOW() WHERE id = ? LIMIT 1", [
        displayName,
        userId,
      ])
    }
    return NextResponse.json({ success: true, displayName })
  } catch (error) {
    if (isTencentTarget() && process.env.NODE_ENV !== "production" && isMariaDbConnectionError(error)) {
      return NextResponse.json({ success: false, displayName: null, error: "Database unavailable" })
    }
    console.error("Save profile error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
