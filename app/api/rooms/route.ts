import { type NextRequest, NextResponse } from "next/server"
import { getRoomStore } from "@/lib/store"
import type { Message, User } from "@/lib/store/types"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { Prisma } from "@prisma/client"
import { getMariaPool, getPrisma } from "@/lib/prisma"
import crypto from "node:crypto"

const ROOM_TTL_MS = 24 * 60 * 60 * 1000
const USER_PRESENCE_TTL_MS = 120 * 1000
const USER_PRESENCE_HEARTBEAT_MS = 30 * 1000
const SIGNAL_TTL_MS = 60 * 1000
const SETTINGS_KEY = "rooms_auto_delete_after_24h"
const ROOM_ACTIVITY_COLUMN = "last_activity_at"
const ROOM_SETTINGS_PREFIX = "room:"
const ACTION_RATE_WINDOW_MS = 60 * 1000
const ACTION_RATE_LIMITS = {
  poll: 60,
  signal: 600,
  join: 60,
  leave: 60,
  message: 60,
  kick: 60,
  update_language: 60,
  update_user: 60,
  update_settings: 60,
  inspect: 120,
} as const

// poll 限流配置
const POLL_RATE_LIMIT_MS = 3000  // 常规 poll 请求最小间隔3秒
const POLL_RATE_LIMIT_ACTIVE_CALL_MS = 3000 // 通话中最小轮询间隔
const POLL_MAX_MESSAGES = 120
const LONG_POLL_TIMEOUT_MS = 25 * 1000

type SettingsCache = { value: boolean; fetchedAt: number }
type CleanupCache = { lastRunAt: number }
type MysqlClient = Awaited<ReturnType<typeof getPrisma>>
type SettingsStore =
  | { kind: "supabase"; client: SupabaseClient }
  | { kind: "mysql"; client: MysqlClient }
  | { kind: "memory" }

const globalForRoomSettings = globalThis as unknown as {
  __voicelinkRoomAutoDeleteCache?: SettingsCache
  __voicelinkRoomCleanupCache?: CleanupCache
  __voicelinkRoomJoinSettings?: Map<string, unknown>
  __voicelinkAppSettingsOpenid?: { value: boolean; fetchedAt: number }
  __voicelinkRoomSignals?: Map<string, Array<{ to: string; from: string; payload: unknown; createdAt: number }>>
  __voicelinkPollRateLimit?: Map<string, number>  // poll 限流缓存
  __voicelinkActionRateLimit?: Map<string, { count: number; resetTime: number }>
  __voicelinkRoomVersion?: Map<string, number>
  __voicelinkRoomWatchers?: Map<string, Set<() => void>>
}

if (!globalForRoomSettings.__voicelinkRoomSignals) {
  globalForRoomSettings.__voicelinkRoomSignals = new Map()
}

if (!globalForRoomSettings.__voicelinkRoomVersion) {
  globalForRoomSettings.__voicelinkRoomVersion = new Map()
}

if (!globalForRoomSettings.__voicelinkRoomWatchers) {
  globalForRoomSettings.__voicelinkRoomWatchers = new Map()
}

function ensureRoomVersion(roomId: string): number {
  const map = globalForRoomSettings.__voicelinkRoomVersion!
  const existing = map.get(roomId)
  if (typeof existing === "number" && Number.isFinite(existing) && existing > 0) {
    return existing
  }
  const initial = Date.now()
  map.set(roomId, initial)
  return initial
}

function notifyRoomChanged(roomId: string) {
  const versions = globalForRoomSettings.__voicelinkRoomVersion!
  const previous = ensureRoomVersion(roomId)
  const next = Math.max(Date.now(), previous + 1)
  versions.set(roomId, next)

  const watchersMap = globalForRoomSettings.__voicelinkRoomWatchers!
  const watchers = watchersMap.get(roomId)
  if (!watchers || watchers.size === 0) return
  for (const wake of Array.from(watchers)) {
    try {
      wake()
    } catch {
      // ignore watcher errors
    }
  }
  watchersMap.delete(roomId)
}

async function waitForRoomChange(roomId: string, currentVersion: number, timeoutMs: number): Promise<"changed" | "timeout"> {
  if (ensureRoomVersion(roomId) > currentVersion) {
    return "changed"
  }

  return new Promise((resolve) => {
    const watchersMap = globalForRoomSettings.__voicelinkRoomWatchers!
    const roomWatchers = watchersMap.get(roomId) ?? new Set<() => void>()
    watchersMap.set(roomId, roomWatchers)

    let settled = false
    const cleanup = () => {
      roomWatchers.delete(onWake)
      if (roomWatchers.size === 0) watchersMap.delete(roomId)
    }

    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (result: "changed" | "timeout") => {
      if (settled) return
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      cleanup()
      resolve(result)
    }

    const onWake = () => finish("changed")
    roomWatchers.add(onWake)

    if (ensureRoomVersion(roomId) > currentVersion) {
      finish("changed")
      return
    }

    timer = setTimeout(() => finish("timeout"), timeoutMs)
  })
}

function enqueueSignal(roomId: string, to: string, from: string, payload: unknown) {
  const map = globalForRoomSettings.__voicelinkRoomSignals!
  const list = map.get(roomId) ?? []
  const now = Date.now()
  const fresh = list.filter((s) => now - s.createdAt < SIGNAL_TTL_MS)

  const payloadRecord = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null
  const payloadType = typeof payloadRecord?.type === "string" ? payloadRecord.type : ""
  const payloadCallId = typeof payloadRecord?.callId === "string" ? payloadRecord.callId : ""

  if (payloadType === "call_caption") {
    const merged = fresh.filter((s) => {
      if (s.to !== to || s.from !== from) return true
      const queuedPayload =
        typeof s.payload === "object" && s.payload !== null ? (s.payload as Record<string, unknown>) : null
      const queuedType = typeof queuedPayload?.type === "string" ? queuedPayload.type : ""
      const queuedCallId = typeof queuedPayload?.callId === "string" ? queuedPayload.callId : ""
      if (queuedType !== "call_caption") return true
      return queuedCallId !== payloadCallId
    })
    merged.push({ to, from, payload, createdAt: now })
    map.set(roomId, merged)
    return
  }

  fresh.push({ to, from, payload, createdAt: now })
  map.set(roomId, fresh)
}

function consumeActionRateLimit(key: string, maxRequests: number, nowMs: number) {
  if (!globalForRoomSettings.__voicelinkActionRateLimit) {
    globalForRoomSettings.__voicelinkActionRateLimit = new Map()
  }
  const cache = globalForRoomSettings.__voicelinkActionRateLimit
  const entry = cache.get(key)

  if (!entry || nowMs > entry.resetTime) {
    cache.set(key, { count: 1, resetTime: nowMs + ACTION_RATE_WINDOW_MS })
    return { ok: true as const, retryAfterMs: 0 }
  }

  if (entry.count >= maxRequests) {
    return { ok: false as const, retryAfterMs: Math.max(1, entry.resetTime - nowMs) }
  }

  entry.count += 1
  return { ok: true as const, retryAfterMs: 0 }
}

function collectSignals(roomId: string, userId: string): unknown[] {
  const map = globalForRoomSettings.__voicelinkRoomSignals!
  const list = map.get(roomId) ?? []
  const now = Date.now()
  const fresh = list.filter((s) => now - s.createdAt < SIGNAL_TTL_MS)
  const mine = fresh.filter((s) => s.to === userId).map((s) => ({ from: s.from, payload: s.payload }))
  const remaining = fresh.filter((s) => s.to !== userId)
  map.set(roomId, remaining)
  return mine
}

function isTencentTarget(): boolean {
  const target = String(process.env.DEPLOY_TARGET ?? process.env.NEXT_PUBLIC_DEPLOY_TARGET ?? "")
    .trim()
    .toLowerCase()
  return target === "tencent"
}

function getSupabaseClient(): SupabaseClient | null {
  if (isTencentTarget()) return null
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY

  if (!supabaseUrl || !supabaseKey) return null
  return createClient(supabaseUrl, supabaseKey)
}

function parseLastSeenAt(value: unknown): number {
  if (typeof value !== "string") return Number.NaN
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout")), ms)
    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((err) => {
        clearTimeout(timer)
        reject(err)
      })
  })
}

async function isMariaDbReady(timeoutMs: number): Promise<boolean> {
  try {
    const pool = await withTimeout(getMariaPool(), timeoutMs)
    await withTimeout(pool.query("SELECT 1"), timeoutMs)
    return true
  } catch (e) {
    console.error("[Rooms API] MariaDB not ready:", e)
    return false
  }
}

async function getSettingsStore(): Promise<SettingsStore> {
  const supabase = getSupabaseClient()
  if (supabase) return { kind: "supabase", client: supabase }
  if (isTencentTarget()) {
    const client = await getPrisma()
    return { kind: "mysql", client }
  }
  return { kind: "memory" }
}

function extractEnabledFromSettingValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value
  if (typeof value !== "object" || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.enabled === "boolean") return v.enabled
  return null
}

async function getSettingValue(store: SettingsStore, key: string): Promise<unknown | null> {
  if (store.kind === "supabase") {
    const { data, error } = await store.client.from("app_settings").select("value").eq("key", key).maybeSingle()
    if (error || !data) return null
    return (data as { value?: unknown } | null)?.value ?? null
  }
  if (store.kind === "mysql") {
    const data = await store.client.appSetting.findUnique({ where: { key } })
    return data?.value ?? null
  }
  return getInMemorySettingsStore().get(key) ?? null
}

async function ensureAppSettingsOpenidColumn(client: MysqlClient): Promise<boolean> {
  try {
    const cached = globalForRoomSettings.__voicelinkAppSettingsOpenid
    if (cached && Date.now() - cached.fetchedAt < 10 * 60_000) return cached.value
    const rows = await client.$queryRaw<{ cnt?: number | bigint }[]>(
      Prisma.sql`SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'app_settings' AND column_name = '_openid'`
    )
    const count = Number(rows?.[0]?.cnt ?? 0)
    if (count === 0) {
      await client.$executeRaw(Prisma.sql`ALTER TABLE app_settings ADD COLUMN \`_openid\` VARCHAR(64) DEFAULT '' NOT NULL`)
    }
    globalForRoomSettings.__voicelinkAppSettingsOpenid = { value: true, fetchedAt: Date.now() }
    return true
  } catch (e) {
    console.error("[Rooms API] ensure app_settings _openid failed:", e)
    globalForRoomSettings.__voicelinkAppSettingsOpenid = { value: false, fetchedAt: Date.now() }
    return false
  }
}

async function setSettingValue(store: SettingsStore, key: string, value: unknown): Promise<void> {
  if (store.kind === "supabase") {
    await store.client
      .from("app_settings")
      .upsert(
        {
          key,
          value,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" },
      )
    return
  }
  if (store.kind === "mysql") {
    const nextValue = value as Prisma.InputJsonValue
    const hasOpenid = await ensureAppSettingsOpenidColumn(store.client)
    if (hasOpenid) {
      await store.client.$executeRaw(
        Prisma.sql`
          INSERT INTO app_settings (\`key\`, \`value\`, updated_at, _openid)
          VALUES (${key}, CAST(${JSON.stringify(nextValue)} AS JSON), NOW(), '')
          ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), updated_at = VALUES(updated_at)
        `
      )
      return
    }
    await store.client.$executeRaw(
      Prisma.sql`
        INSERT INTO app_settings (\`key\`, \`value\`, updated_at)
        VALUES (${key}, CAST(${JSON.stringify(nextValue)} AS JSON), NOW())
        ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), updated_at = VALUES(updated_at)
      `
    )
    return
  }
  getInMemorySettingsStore().set(key, value)
}

async function getRoomAutoDeleteEnabled(store: SettingsStore): Promise<boolean> {
  const cached = globalForRoomSettings.__voicelinkRoomAutoDeleteCache
  if (cached && Date.now() - cached.fetchedAt < 30_000) return cached.value

  const value = await getSettingValue(store, SETTINGS_KEY)
  const enabled = extractEnabledFromSettingValue(value) ?? false
  globalForRoomSettings.__voicelinkRoomAutoDeleteCache = { value: enabled, fetchedAt: Date.now() }
  return enabled
}

async function maybeCleanupExpiredRooms(store: SettingsStore): Promise<void> {
  const cache = globalForRoomSettings.__voicelinkRoomCleanupCache
  const now = Date.now()
  if (cache && now - cache.lastRunAt < 10 * 60_000) return

  globalForRoomSettings.__voicelinkRoomCleanupCache = { lastRunAt: now }
  const enabled = await getRoomAutoDeleteEnabled(store)
  if (!enabled) return

  if (store.kind === "supabase") {
    const cutoff = new Date(now - ROOM_TTL_MS).toISOString()
    const { error } = await store.client
      .from("rooms")
      .delete()
      .or(`and(${ROOM_ACTIVITY_COLUMN}.is.null,created_at.lt.${cutoff}),${ROOM_ACTIVITY_COLUMN}.lt.${cutoff}`)
    if (error) {
      await store.client.from("rooms").delete().lt("created_at", cutoff)
    }
    return
  }
  if (store.kind === "mysql") {
    const cutoff = new Date(now - ROOM_TTL_MS)
    await store.client.room.deleteMany({
      where: {
        OR: [{ lastActivityAt: { lt: cutoff } }, { createdAt: { lt: cutoff } }],
      },
    })
  }
}

async function cleanupRoomIfExpired(store: SettingsStore, roomId: string): Promise<boolean> {
  const enabled = await getRoomAutoDeleteEnabled(store)
  if (!enabled) return false

  if (store.kind === "supabase") {
    const { data, error } = await store.client
      .from("rooms")
      .select(`created_at,${ROOM_ACTIVITY_COLUMN}`)
      .eq("id", roomId)
      .maybeSingle()
    if (error) {
      const fallback = await store.client.from("rooms").select("created_at").eq("id", roomId).maybeSingle()
      if (fallback.error || !fallback.data) return false
      const createdAt = (fallback.data as { created_at?: unknown }).created_at
      if (typeof createdAt !== "string") return false
      const createdMs = Date.parse(createdAt)
      if (!Number.isFinite(createdMs)) return false
      if (Date.now() - createdMs <= ROOM_TTL_MS) return false
      await store.client.from("rooms").delete().eq("id", roomId)
      return true
    }
    if (!data) return false

    const createdAt = (data as { created_at?: unknown }).created_at
    const lastActivityAt = (data as Record<string, unknown>)[ROOM_ACTIVITY_COLUMN]

    const createdAtStr = typeof createdAt === "string" ? createdAt : null
    const lastActivityStr = typeof lastActivityAt === "string" ? lastActivityAt : null

    const createdMs = createdAtStr ? Date.parse(createdAtStr) : Number.NaN
    const lastActivityMs = lastActivityStr ? Date.parse(lastActivityStr) : Number.NaN
    const effectiveMs = Number.isFinite(lastActivityMs)
      ? lastActivityMs
      : Number.isFinite(createdMs)
        ? createdMs
        : Number.NaN

    if (!Number.isFinite(effectiveMs)) return false
    if (Date.now() - effectiveMs <= ROOM_TTL_MS) return false

    await store.client.from("rooms").delete().eq("id", roomId)
    return true
  }

  if (store.kind === "mysql") {
    const room = await store.client.room.findUnique({
      where: { id: roomId },
      select: { createdAt: true, lastActivityAt: true },
    })
    if (!room) return false
    const createdMs = room.createdAt ? room.createdAt.getTime() : Number.NaN
    const lastActivityMs = room.lastActivityAt ? room.lastActivityAt.getTime() : Number.NaN
    const effectiveMs = Number.isFinite(lastActivityMs)
      ? lastActivityMs
      : Number.isFinite(createdMs)
        ? createdMs
        : Number.NaN
    if (!Number.isFinite(effectiveMs)) return false
    if (Date.now() - effectiveMs <= ROOM_TTL_MS) return false
    await store.client.room.delete({ where: { id: roomId } })
    return true
  }

  return false
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

type JoinSessionPolicy = "allow" | "single_account"

function normalizeJoinSessionPolicy(value: unknown): JoinSessionPolicy {
  if (typeof value !== "string") return "allow"
  const v = value.trim().toLowerCase()
  if (v === "single_account" || v === "single-account" || v === "singleaccount") return "single_account"
  return "allow"
}

function getJoinSessionPolicy(): JoinSessionPolicy {
  const direct = normalizeJoinSessionPolicy(process.env.VOICELINK_JOIN_SESSION_POLICY)
  if (direct === "single_account") return direct

  const flag = String(process.env.VOICELINK_KICK_SAME_ACCOUNT_ON_JOIN ?? "").trim().toLowerCase()
  if (flag === "1" || flag === "true" || flag === "yes" || flag === "on") return "single_account"

  return "single_account"
}

function getAccountIdFromUserId(userId: string): string | null {
  const raw = typeof userId === "string" ? userId.trim() : ""
  if (!raw) return null
  const parts = raw.split(":").map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]
  const base = parts.slice(0, -1).join(":").trim()
  return base || parts[0]
}

type RoomJoinMode = "public" | "password"

type RoomSettings = {
  adminUserId: string
  joinMode: RoomJoinMode
  passwordSalt?: string
  passwordHash?: string
  updatedAt?: string
}

function getRoomSettingsKey(roomId: string) {
  return `${ROOM_SETTINGS_PREFIX}${roomId}:settings`
}

function getInMemorySettingsStore() {
  if (!globalForRoomSettings.__voicelinkRoomJoinSettings) {
    globalForRoomSettings.__voicelinkRoomJoinSettings = new Map()
  }
  return globalForRoomSettings.__voicelinkRoomJoinSettings
}

function normalizeJoinMode(value: unknown): RoomJoinMode | null {
  if (value === "public" || value === "password") return value
  return null
}

function parseRoomSettings(value: unknown): RoomSettings | null {
  if (typeof value !== "object" || value === null) return null
  const v = value as Record<string, unknown>
  if (!isNonEmptyString(v.adminUserId)) return null
  const joinMode = normalizeJoinMode(v.joinMode)
  if (!joinMode) return null
  const passwordSalt = typeof v.passwordSalt === "string" ? v.passwordSalt : undefined
  const passwordHash = typeof v.passwordHash === "string" ? v.passwordHash : undefined
  const updatedAt = typeof v.updatedAt === "string" ? v.updatedAt : undefined
  return { adminUserId: v.adminUserId.trim(), joinMode, passwordSalt, passwordHash, updatedAt }
}

function derivePasswordHash(password: string, saltBase64: string) {
  const salt = Buffer.from(saltBase64, "base64")
  const hash = crypto.scryptSync(password, salt, 32)
  return hash.toString("base64")
}

function hashPasswordForStorage(password: string) {
  const salt = crypto.randomBytes(16)
  const saltBase64 = salt.toString("base64")
  const hashBase64 = derivePasswordHash(password, saltBase64)
  return { saltBase64, hashBase64 }
}

function verifyPassword(password: string, saltBase64: string, expectedHashBase64: string) {
  const actual = derivePasswordHash(password, saltBase64)
  const a = Buffer.from(actual, "base64")
  const b = Buffer.from(expectedHashBase64, "base64")
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

async function getRoomSettings(store: SettingsStore, roomId: string): Promise<RoomSettings | null> {
  const key = getRoomSettingsKey(roomId)
  const value = await getSettingValue(store, key)
  return parseRoomSettings(value)
}

async function setRoomSettings(store: SettingsStore, roomId: string, settings: RoomSettings): Promise<void> {
  const key = getRoomSettingsKey(roomId)
  const value: RoomSettings = { ...settings, updatedAt: new Date().toISOString() }
  await setSettingValue(store, key, value)
}

function parseMessage(value: unknown): Message | null {
  if (typeof value !== "object" || value === null) return null
  const msg = value as Record<string, unknown>

  if (!isNonEmptyString(msg.id)) return null
  if (!isNonEmptyString(msg.userId)) return null
  if (!isNonEmptyString(msg.userName)) return null
  if (!isNonEmptyString(msg.originalText)) return null
  if (!isNonEmptyString(msg.originalLanguage)) return null
  if (!isNonEmptyString(msg.timestamp)) return null

  const rawAudioUrl = typeof msg.audioUrl === "string" ? msg.audioUrl.trim() : ""
  const audioUrl =
    rawAudioUrl && !rawAudioUrl.startsWith("data:") && rawAudioUrl.length <= 2048
      ? rawAudioUrl
      : undefined
  const translatedText = typeof msg.translatedText === "string" ? msg.translatedText : undefined
  const targetLanguage = typeof msg.targetLanguage === "string" ? msg.targetLanguage : undefined

  return {
    id: msg.id,
    userId: msg.userId,
    userName: msg.userName,
    originalText: msg.originalText,
    originalLanguage: msg.originalLanguage,
    timestamp: msg.timestamp,
    audioUrl,
    translatedText,
    targetLanguage,
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) {
      return NextResponse.json({ success: false, error: "Invalid JSON" }, { status: 400 })
    }

    const action = body.action
    const roomId = body.roomId
    const userId = body.userId
    const userName = body.userName
    const sourceLanguage = body.sourceLanguage
    const targetLanguage = body.targetLanguage
    const message = body.message
    const avatarUrl = body.avatarUrl
    const joinPassword = body.joinPassword
    const createJoinMode = body.createJoinMode
    const createPassword = body.createPassword
    const settingsJoinMode = body.joinMode
    const settingsPassword = body.password
    const targetUserId = body.targetUserId
    const since = body.since
    const callActive = body.callActive
    const roomVersionRaw = body.roomVersion
    const longPollRaw = body.longPoll

    if (typeof action !== "string" || action.trim().length === 0) {
      return NextResponse.json({ success: false, error: "Invalid action" }, { status: 400 })
    }

    const actionName = action.trim()
    const nowMs = Date.now()
    const ip =
      request.headers.get("x-forwarded-for") ||
      request.headers.get("x-real-ip") ||
      "unknown"
    const roomIdKey = typeof roomId === "string" ? roomId.trim() : ""
    const userIdKey = typeof userId === "string" ? userId.trim() : ""
    const limit = ACTION_RATE_LIMITS[actionName as keyof typeof ACTION_RATE_LIMITS] ?? 60
    const limitKey =
      actionName === "poll" || actionName === "signal"
        ? `rooms:${actionName}:${roomIdKey || "no-room"}:${userIdKey || ip}`
        : `rooms:${actionName}:${ip}`
    const limitResult = consumeActionRateLimit(limitKey, limit, nowMs)
    if (!limitResult.ok) {
      return NextResponse.json(
        {
          success: false,
          error: "Too many requests",
          action: actionName,
          retryAfter: limitResult.retryAfterMs,
        },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": String(limit),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Action": actionName,
            "Retry-After": String(Math.ceil(limitResult.retryAfterMs / 1000)),
          },
        },
      )
    }

    let store = getRoomStore()
    let settingsStore: SettingsStore
    try {
      settingsStore = await getSettingsStore()
    } catch (e) {
      console.error("[Rooms API] Failed to get settings store, falling back to memory:", e)
      settingsStore = { kind: "memory" }
    }
    if (isTencentTarget()) {
      const ready = await isMariaDbReady(2500)
      if (!ready) {
        return NextResponse.json({ success: false, error: "Database not ready" }, { status: 503 })
      }
    }
    if (settingsStore.kind !== "memory") {
      try {
        await maybeCleanupExpiredRooms(settingsStore)
      } catch (e) {
        console.error("[Rooms API] Cleanup error:", e)
      }
    }

    if (action === "inspect") {
      if (typeof roomId !== "string" || roomId.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid roomId" }, { status: 400 })
      }
      const rid = roomId.trim()
      try {
        const [room, settings] = await Promise.all([
          store.getRoom(rid).catch(() => null),
          getRoomSettings(settingsStore, rid).catch(() => null),
        ])
        const exists = Boolean(settings) || Boolean(room)
        const joinMode = settings?.joinMode ?? "public"
        const requiresPassword = joinMode === "password"
        return NextResponse.json({
          success: true,
          exists,
          settings: settings
            ? { adminUserId: settings.adminUserId, joinMode: settings.joinMode, requiresPassword }
            : exists
              ? { adminUserId: room?.users?.[0]?.id ?? null, joinMode, requiresPassword }
              : null,
        })
      } catch (e) {
        console.error("[Rooms API] Inspect error:", e)
        return NextResponse.json({ success: false, error: "Inspect failed" }, { status: 500 })
      }
    }

    if (action === "join") {
      if (typeof roomId !== "string" || roomId.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid roomId" }, { status: 400 })
      }
      // ... existing checks ...
      if (typeof userId !== "string" || userId.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid userId" }, { status: 400 })
      }
      if (typeof userName !== "string" || userName.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid userName" }, { status: 400 })
      }
      if (typeof sourceLanguage !== "string" || sourceLanguage.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid sourceLanguage" }, { status: 400 })
      }
      if (typeof targetLanguage !== "string" || targetLanguage.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid targetLanguage" }, { status: 400 })
      }

      const rid = roomId.trim()
      const uid = userId.trim()

      if (settingsStore.kind !== "memory") {
        try {
          await cleanupRoomIfExpired(settingsStore, rid)
        } catch (e) {
          console.error("[Rooms API] Individual cleanup error:", e)
        }
      }

      try {
        let existingRoom = await store.getRoom(rid).catch(() => null)
        let settings = await getRoomSettings(settingsStore, rid).catch(() => null)
        const requestedCreateJoinMode = normalizeJoinMode(createJoinMode) ?? null
        const requestedCreatePassword = typeof createPassword === "string" ? createPassword : null
        const joinSessionPolicy = getJoinSessionPolicy()
        const accountId = getAccountIdFromUserId(uid)

        if (joinSessionPolicy === "single_account" && accountId && existingRoom?.users?.length) {
          const staleUserIds = existingRoom.users
            .map((u) => u.id)
            .filter((id) => id !== uid && getAccountIdFromUserId(id) === accountId)

          if (staleUserIds.length > 0) {
            await Promise.all(staleUserIds.map((staleId) => store.leaveRoom(rid, staleId).catch(() => null)))
            existingRoom = await store.getRoom(rid).catch(() => null)
          }

          if (settings && getAccountIdFromUserId(settings.adminUserId) === accountId && settings.adminUserId !== uid) {
            const next: RoomSettings = { ...settings, adminUserId: uid }
            await setRoomSettings(settingsStore, rid, next)
            settings = next
          }
        }

        if (!settings) {
          const canClaimAdmin = !existingRoom || existingRoom.users.length === 0
          const adminUserId = canClaimAdmin ? uid : existingRoom?.users?.[0]?.id ?? uid
          const joinMode: RoomJoinMode =
            requestedCreateJoinMode ?? (requestedCreatePassword && requestedCreatePassword.trim() ? "password" : "public")
          const next: RoomSettings = { adminUserId, joinMode }
          if (joinMode === "password") {
            const passwordValue = requestedCreatePassword?.trim() ?? ""
            if (!passwordValue) {
              return NextResponse.json({ success: false, error: "Password required" }, { status: 400 })
            }
            const { saltBase64, hashBase64 } = hashPasswordForStorage(passwordValue)
            next.passwordSalt = saltBase64
            next.passwordHash = hashBase64
          }
          await setRoomSettings(settingsStore, rid, next)
          settings = next
        } else {
          if (settings.joinMode === "password") {
            const passwordValue = typeof joinPassword === "string" ? joinPassword.trim() : ""
            if (!passwordValue) {
              return NextResponse.json({ success: false, error: "Password required" }, { status: 401 })
            }
            if (!settings.passwordSalt || !settings.passwordHash) {
              return NextResponse.json({ success: false, error: "Password config invalid" }, { status: 500 })
            }
            const ok = verifyPassword(passwordValue, settings.passwordSalt, settings.passwordHash)
            if (!ok) {
              return NextResponse.json({ success: false, error: "Invalid password" }, { status: 401 })
            }
          }
        }

        const avatar =
          typeof avatarUrl === "string" && avatarUrl.trim().length > 0
            ? avatarUrl.trim()
            : `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(userId)}`

        const nowIso = new Date().toISOString()
        const roomData = await store.joinRoom(rid, {
          id: uid,
          name: userName.trim(),
          sourceLanguage: sourceLanguage.trim(),
          targetLanguage: targetLanguage.trim(),
          avatar,
          lastSeenAt: nowIso,
        })
        notifyRoomChanged(rid)

        return NextResponse.json({
          success: true,
          room: roomData,
          settings: settings ? { adminUserId: settings.adminUserId, joinMode: settings.joinMode } : null,
        })
      } catch (e) {
        console.error("[Rooms API] Join error:", e)
        return NextResponse.json({
          success: false,
          error: e instanceof Error ? e.message : "Join failed"
        }, { status: 500 })
      }
    }

    if (action === "leave") {
      if (typeof roomId !== "string" || roomId.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid roomId" }, { status: 400 })
      }
      if (typeof userId !== "string" || userId.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid userId" }, { status: 400 })
      }

      if (settingsStore.kind !== "memory") {
        const expired = await cleanupRoomIfExpired(settingsStore, roomId.trim())
        if (expired) {
          return NextResponse.json({ success: false, error: "Room expired" }, { status: 410 })
        }
      }

      await store.leaveRoom(roomId.trim(), userId.trim())
      notifyRoomChanged(roomId.trim())
      return NextResponse.json({ success: true })
    }

    if (action === "update_settings") {
      if (typeof roomId !== "string" || roomId.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid roomId" }, { status: 400 })
      }
      if (typeof userId !== "string" || userId.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid userId" }, { status: 400 })
      }
      const rid = roomId.trim()
      const uid = userId.trim()
      const current = await getRoomSettings(settingsStore, rid)
      if (!current) {
        return NextResponse.json({ success: false, error: "Room settings not found" }, { status: 404 })
      }
      if (current.adminUserId !== uid) {
        return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 })
      }
      const nextMode = normalizeJoinMode(settingsJoinMode)
      if (!nextMode) {
        return NextResponse.json({ success: false, error: "Invalid joinMode" }, { status: 400 })
      }

      const next: RoomSettings = { adminUserId: current.adminUserId, joinMode: nextMode }
      if (nextMode === "password") {
        const passwordValue = typeof settingsPassword === "string" ? settingsPassword.trim() : ""
        const keepExisting = !passwordValue && current.passwordSalt && current.passwordHash
        if (keepExisting) {
          next.passwordSalt = current.passwordSalt
          next.passwordHash = current.passwordHash
        } else {
          if (!passwordValue) {
            return NextResponse.json({ success: false, error: "Password required" }, { status: 400 })
          }
          const { saltBase64, hashBase64 } = hashPasswordForStorage(passwordValue)
          next.passwordSalt = saltBase64
          next.passwordHash = hashBase64
        }
      }
      await setRoomSettings(settingsStore, rid, next)
      notifyRoomChanged(rid)
      return NextResponse.json({ success: true, settings: { adminUserId: next.adminUserId, joinMode: next.joinMode } })
    }

    if (action === "kick") {
      if (typeof roomId !== "string" || roomId.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid roomId" }, { status: 400 })
      }
      if (typeof userId !== "string" || userId.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid userId" }, { status: 400 })
      }
      if (typeof targetUserId !== "string" || targetUserId.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid targetUserId" }, { status: 400 })
      }
      const rid = roomId.trim()
      const uid = userId.trim()
      const tid = targetUserId.trim()
      const settings = await getRoomSettings(settingsStore, rid)
      if (!settings) {
        return NextResponse.json({ success: false, error: "Room settings not found" }, { status: 404 })
      }
      if (settings.adminUserId !== uid) {
        return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 })
      }
      if (settings.adminUserId === tid) {
        return NextResponse.json({ success: false, error: "Cannot kick admin" }, { status: 400 })
      }

      if (settingsStore.kind !== "memory") {
        const expired = await cleanupRoomIfExpired(settingsStore, rid)
        if (expired) {
          return NextResponse.json({ success: false, error: "Room expired" }, { status: 410 })
        }
      }

      await store.leaveRoom(rid, tid)
      notifyRoomChanged(rid)
      return NextResponse.json({ success: true })
    }

    if (action === "update_language") {
      if (typeof roomId !== "string" || roomId.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid roomId" }, { status: 400 })
      }
      if (typeof userId !== "string" || userId.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid userId" }, { status: 400 })
      }
      if (typeof sourceLanguage !== "string" || sourceLanguage.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid sourceLanguage" }, { status: 400 })
      }
      if (typeof targetLanguage !== "string" || targetLanguage.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid targetLanguage" }, { status: 400 })
      }

      if (settingsStore.kind !== "memory") {
        const expired = await cleanupRoomIfExpired(settingsStore, roomId.trim())
        if (expired) {
          return NextResponse.json({ success: false, error: "Room expired" }, { status: 410 })
        }
      }

      const rid = roomId.trim()
      const uid = userId.trim()
      const roomData = await store.getRoom(rid)
      if (!roomData) {
        return NextResponse.json({ success: false, error: "Room not found" }, { status: 404 })
      }
      const existingUser = roomData.users.find((u) => u.id === uid)
      if (!existingUser) {
        return NextResponse.json({ success: false, error: "User not found" }, { status: 404 })
      }

      const nextUser = {
        ...existingUser,
        sourceLanguage: sourceLanguage.trim(),
        targetLanguage: targetLanguage.trim(),
        lastSeenAt: new Date().toISOString(),
      }

      await store.joinRoom(rid, nextUser)
      notifyRoomChanged(rid)
      return NextResponse.json({ success: true })
    }

    if (action === "update_user") {
      if (typeof roomId !== "string" || roomId.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid roomId" }, { status: 400 })
      }
      if (typeof userId !== "string" || userId.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid userId" }, { status: 400 })
      }
      if (typeof userName !== "string" || userName.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid userName" }, { status: 400 })
      }

      if (settingsStore.kind !== "memory") {
        const expired = await cleanupRoomIfExpired(settingsStore, roomId.trim())
        if (expired) {
          return NextResponse.json({ success: false, error: "Room expired" }, { status: 410 })
        }
      }

      const rid = roomId.trim()
      const uid = userId.trim()
      const roomData = await store.getRoom(rid)
      if (!roomData) {
        return NextResponse.json({ success: false, error: "Room not found" }, { status: 404 })
      }
      const existingUser = roomData.users.find((u) => u.id === uid)
      if (!existingUser) {
        return NextResponse.json({ success: false, error: "User not found" }, { status: 404 })
      }

      const nextUser = {
        ...existingUser,
        name: userName.trim(),
        avatar:
          typeof avatarUrl === "string" && avatarUrl.trim().length > 0 ? avatarUrl.trim() : existingUser.avatar,
        lastSeenAt: new Date().toISOString(),
      }

      await store.joinRoom(rid, nextUser)
      notifyRoomChanged(rid)
      return NextResponse.json({ success: true })
    }

    if (action === "message") {
      if (typeof roomId !== "string" || roomId.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid roomId" }, { status: 400 })
      }
      const parsedMessage = parseMessage(message)
      if (!parsedMessage) {
        return NextResponse.json({ success: false, error: "Invalid message" }, { status: 400 })
      }

      if (settingsStore.kind !== "memory") {
        const expired = await cleanupRoomIfExpired(settingsStore, roomId.trim())
        if (expired) {
          return NextResponse.json({ success: false, error: "Room expired" }, { status: 410 })
        }
      }

      const savedMessage = await store.sendMessage(roomId.trim(), parsedMessage)
      if (settingsStore.kind === "supabase") {
        await settingsStore.client
          .from("rooms")
          .update({ [ROOM_ACTIVITY_COLUMN]: new Date().toISOString() })
          .eq("id", roomId.trim())
      }
      notifyRoomChanged(roomId.trim())
      return NextResponse.json({ success: true, message: savedMessage })
    }

    if (action === "signal") {
      if (typeof roomId !== "string" || roomId.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid roomId" }, { status: 400 })
      }
      if (typeof userId !== "string" || userId.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid userId" }, { status: 400 })
      }
      const toUserId = typeof body.toUserId === "string" ? body.toUserId.trim() : ""
      if (!toUserId) {
        return NextResponse.json({ success: false, error: "Invalid toUserId" }, { status: 400 })
      }
      const payload = body.payload
      if (typeof payload !== "object" || payload === null) {
        return NextResponse.json({ success: false, error: "Invalid payload" }, { status: 400 })
      }

      const room = await store.getRoom(roomId.trim())
      if (!room) {
        return NextResponse.json({ success: false, error: "Room not found" }, { status: 404 })
      }

      const senderId = userId.trim()
      const sender = room.users.find((u) => u.id === senderId)
      if (sender) {
        const nowIso = new Date().toISOString()
        const lastSeenMs = parseLastSeenAt(sender.lastSeenAt)
        if (!Number.isFinite(lastSeenMs) || Date.now() - lastSeenMs >= USER_PRESENCE_HEARTBEAT_MS) {
          void store.joinRoom(roomId.trim(), { ...sender, lastSeenAt: nowIso }).catch(() => null)
        }
      }

      enqueueSignal(roomId.trim(), toUserId, senderId, payload)
      notifyRoomChanged(roomId.trim())
      return NextResponse.json({ success: true })
    }

    if (action === "poll") {
      if (typeof roomId !== "string" || roomId.trim().length === 0) {
        return NextResponse.json({ success: false, error: "Invalid roomId" }, { status: 400 })
      }

      const rid = roomId.trim()
      const uid = typeof userId === "string" ? userId.trim() : ""
      const sinceMs =
        typeof since === "string" && since.trim().length > 0
          ? Date.parse(since)
          : Number.NaN
      const isActiveCall = callActive === true
      const roomVersion =
        typeof roomVersionRaw === "number"
          ? roomVersionRaw
          : Number.parseInt(typeof roomVersionRaw === "string" ? roomVersionRaw : "", 10)
      const wantsLongPoll = longPollRaw !== false
      const minPollIntervalMs = isActiveCall ? POLL_RATE_LIMIT_ACTIVE_CALL_MS : POLL_RATE_LIMIT_MS
      
      // poll 频率限制检查
      if (!globalForRoomSettings.__voicelinkPollRateLimit) {
        globalForRoomSettings.__voicelinkPollRateLimit = new Map()
      }
      const pollKey = `${rid}:${uid || 'anonymous'}`
      const lastPoll = globalForRoomSettings.__voicelinkPollRateLimit.get(pollKey) || 0
      const nowMs = Date.now()
      if (!wantsLongPoll && nowMs - lastPoll < minPollIntervalMs) {
        // 请求过于频繁，返回缓存数据或简单响应
        return NextResponse.json({ 
          success: true,
          throttled: true,
          retryAfter: minPollIntervalMs - (nowMs - lastPoll)
        }, { status: 429 })
      }
      if (!wantsLongPoll) {
        globalForRoomSettings.__voicelinkPollRateLimit.set(pollKey, nowMs)
      }

      if (wantsLongPoll && Number.isFinite(roomVersion) && roomVersion > 0) {
        const waitResult = await waitForRoomChange(rid, roomVersion, LONG_POLL_TIMEOUT_MS)
        if (waitResult === "timeout") {
          return NextResponse.json({
            success: true,
            timeout: true,
            roomVersion: ensureRoomVersion(rid),
          })
        }
      }

      if (settingsStore.kind !== "memory") {
        const expired = await cleanupRoomIfExpired(settingsStore, roomId.trim())
        if (expired) {
          return NextResponse.json({ success: false, error: "Room expired" }, { status: 410 })
        }
      }

      const nowIso = new Date().toISOString()

      const roomData = await store.getRoom(rid)
      if (!roomData) {
        return NextResponse.json({ success: false, error: "Room not found" }, { status: 404 })
      }

      let users = roomData.users
      const updates: Promise<unknown>[] = []

      if (uid) {
        const currentUser = users.find((u) => u.id === uid)
        if (currentUser) {
          const lastSeenMs = parseLastSeenAt(currentUser.lastSeenAt)
          if (!Number.isFinite(lastSeenMs) || nowMs - lastSeenMs >= USER_PRESENCE_HEARTBEAT_MS) {
            const nextUser: User = { ...currentUser, lastSeenAt: nowIso }
            updates.push(store.joinRoom(rid, nextUser))
            users = users.map((u) => (u.id === uid ? nextUser : u))
          }
        }
      }

      const activeUsers: User[] = []
      for (const user of users) {
        let lastSeenMs = parseLastSeenAt(user.lastSeenAt)
        let nextUser = user
        if (!Number.isFinite(lastSeenMs)) {
          nextUser = { ...user, lastSeenAt: nowIso }
          updates.push(store.joinRoom(rid, nextUser))
          lastSeenMs = nowMs
        }
        if (Number.isFinite(lastSeenMs) && nowMs - lastSeenMs > USER_PRESENCE_TTL_MS) {
          updates.push(store.leaveRoom(rid, user.id))
          continue
        }
        activeUsers.push(nextUser)
      }

      if (updates.length > 0) {
        await Promise.allSettled(updates)
      }

      const settings = await getRoomSettings(settingsStore, roomId.trim()).catch(() => null)
      const signals = uid ? collectSignals(rid, uid) : []
      const currentRoomVersion = ensureRoomVersion(rid)
      const incrementalMessages = Array.isArray(roomData.messages)
        ? roomData.messages.filter((msg) => {
            if (!Number.isFinite(sinceMs)) return true
            const ts = Date.parse(msg.timestamp)
            if (Number.isFinite(ts)) return ts > sinceMs
            return true
          })
        : []
      return NextResponse.json({
        success: true,
        room: {
          ...roomData,
          users: activeUsers,
          messages: incrementalMessages.slice(-POLL_MAX_MESSAGES),
        },
        roomVersion: currentRoomVersion,
        signals,
        settings: settings ? { adminUserId: settings.adminUserId, joinMode: settings.joinMode } : null,
      })
    }

    return NextResponse.json({ success: false, error: "Invalid action" }, { status: 400 })
  } catch (error) {
    console.error("[v0] Room API error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
