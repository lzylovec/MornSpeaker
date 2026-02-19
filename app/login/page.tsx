"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { useToast } from "@/hooks/use-toast"
import { getSupabaseBrowserClient } from "@/lib/supabase/browser"
import { useAuth } from "@/components/auth-provider"
import { WechatMiniProgramDetector } from "@/components/wechat-mini-program-detector"
import {
  clearWxMpLoginParams,
  ensureMiniProgramEnv,
  exchangeCodeForToken,
  isMiniProgram,
  parseWxMpLoginCallback,
  requestWxMpLogin,
} from "@/lib/wechat-mp"

export default function LoginPage() {
  const router = useRouter()
  const { toast } = useToast()
  const supabase = useMemo(() => getSupabaseBrowserClient(), [])
  const { user, isLoading } = useAuth()
  const isTencent = process.env.NEXT_PUBLIC_DEPLOY_TARGET === "tencent"

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [view, setView] = useState<"form" | "verify" | "reset">("form")
  const [emailCode, setEmailCode] = useState("")
  const [resetCode, setResetCode] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [resetResendCountdown, setResetResendCountdown] = useState(0)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isInMiniProgram, setIsInMiniProgram] = useState(false)
  const [verificationId, setVerificationId] = useState<string | null>(null)
  const [verificationEmail, setVerificationEmail] = useState<string | null>(null)
  const [resetVerificationId, setResetVerificationId] = useState<string | null>(null)
  const [resetVerificationEmail, setResetVerificationEmail] = useState<string | null>(null)
  const verificationRequestLock = useRef(false)
  const verificationVerifyLock = useRef(false)
  const resetRequestLock = useRef(false)
  const resetVerifyLock = useRef(false)
  const wechatRedirectHandledRef = useRef(false)
  const tencentLogoutKey = "tencent:auth:logged_out"
  const wechatAppId = (
    process.env.NEXT_PUBLIC_WECHAT_APP_ID ||
    process.env.NEXT_PUBLIC_TENCENT_WECHAT_APP_ID ||
    ""
  ).trim()
  const wechatScope = (process.env.NEXT_PUBLIC_WECHAT_SCOPE || "snsapi_login").trim() || "snsapi_login"
  const wechatProviderId = (
    process.env.NEXT_PUBLIC_WECHAT_PROVIDER_ID ||
    (wechatScope === "snsapi_login" ? "wx_open" : "wx_public")
  ).trim() || (wechatScope === "snsapi_login" ? "wx_open" : "wx_public")
  const isMedianApp =
    typeof window !== "undefined" &&
    (!!(window as any).median_status_checker ||
      !!(window as any).JSBridge ||
      navigator.userAgent.toLowerCase().includes("median") ||
      navigator.userAgent.toLowerCase().includes("gonative"))
  const canUseWechatLogin = isTencent && (isMiniProgram() || isInMiniProgram || isMedianApp)
  const clearTencentLoggedOut = () => {
    if (!isTencent) return
    try {
      window.localStorage.removeItem(tencentLogoutKey)
    } catch {
      return
    }
  }

  const ensureCloudbasePersistence = async (auth: unknown) => {
    const persistence = auth as { setPersistence?: (mode: string) => Promise<void> }
    if (typeof persistence.setPersistence === "function") {
      await persistence.setPersistence("local")
    }
  }

  type WechatOauthAuth = {
    genProviderRedirectUri: (params: {
      provider_id: string
      redirect_uri: string
      provider_redirect_uri?: string
      state: string
      scope?: string
      response_type?: string
    }) => Promise<{ uri?: string }>
    grantProviderToken: (params: {
      provider_id: string
      provider_redirect_uri?: string
      provider_code?: string
    }) => Promise<{ provider_token?: string }>
    signInWithProvider: (params: { provider_token: string }) => Promise<unknown>
  }

  const getWechatSupport = (auth: unknown) => {
    const legacy = auth as {
      weixinAuthProvider?: (options: { appid: string; scope?: string; state?: string }) => {
        signInWithRedirect: () => Promise<void>
        getRedirectResult: () => Promise<unknown>
      }
    }
    if (typeof legacy.weixinAuthProvider === "function") {
      if (!wechatAppId) {
        throw new Error("未配置微信 AppID")
      }
      return {
        mode: "legacy" as const,
        provider: legacy.weixinAuthProvider({
          appid: wechatAppId,
          scope: wechatScope,
          state: "login",
        }),
      }
    }
    const oauthAuth = auth as Partial<WechatOauthAuth>
    if (
      typeof oauthAuth.genProviderRedirectUri === "function" &&
      typeof oauthAuth.grantProviderToken === "function" &&
      typeof oauthAuth.signInWithProvider === "function"
    ) {
      return { mode: "oauth" as const, auth: oauthAuth as WechatOauthAuth }
    }
    throw new Error("当前 SDK 不支持微信登录")
  }

  const getWechatRedirectUri = () => {
    const url = new URL(window.location.href)
    url.searchParams.delete("code")
    url.searchParams.delete("state")
    return url.toString()
  }

  const buildTencentUsername = (value: string) => {
    const localPart = value.split("@")[0] ?? ""
    let normalized = localPart.toLowerCase().replace(/[^0-9a-z-_]/g, "-")
    if (!/^[a-z]/.test(normalized)) {
      normalized = `u${normalized}`
    }
    if (normalized.length < 6) {
      normalized = (normalized + "000000").slice(0, 6)
    }
    if (normalized.length > 25) {
      normalized = normalized.slice(0, 25)
    }
    if (!/^[a-z][0-9a-z-_]{5,24}$/.test(normalized)) {
      normalized = normalized.replace(/[^0-9a-z-_]/g, "-")
      if (!/^[a-z]/.test(normalized)) {
        normalized = `u${normalized}`
      }
      if (normalized.length < 6) {
        normalized = (normalized + "000000").slice(0, 6)
      }
      if (normalized.length > 25) {
        normalized = normalized.slice(0, 25)
      }
    }
    return normalized
  }

  const syncTencentUser = async (trimmedEmail: string, rawPassword: string) => {
    if (!isTencent) return
    if (!trimmedEmail || !rawPassword) return
    try {
      await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: trimmedEmail,
          password: rawPassword,
          name: buildTencentUsername(trimmedEmail),
        }),
      })
    } catch {
      return
    }
  }

  useEffect(() => {
    if (isLoading) return
    if (user) router.replace("/")
  }, [isLoading, router, user])

  useEffect(() => {
    if (!isTencent) return
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    if (!params.get("code")) return
    if (wechatRedirectHandledRef.current) return
    wechatRedirectHandledRef.current = true
    const run = async () => {
      try {
        const { getCloudBaseAuth } = await import("@/lib/cloudbase-client")
        const auth = getCloudBaseAuth()
        await ensureCloudbasePersistence(auth)
        const code = params.get("code")
        if (!code) return
        const support = getWechatSupport(auth)
        if (support.mode === "legacy") {
          const result = await support.provider.getRedirectResult()
          if (result) {
            clearTencentLoggedOut()
            router.replace("/")
            return
          }
          return
        }
        const state = params.get("state") || ""
        try {
          const expected = window.sessionStorage.getItem("tencent:wechat:state") || ""
          if (expected && state && expected !== state) {
            throw new Error("登录状态校验失败")
          }
        } catch (e) {
          throw e
        }
        const redirectUri = getWechatRedirectUri()
        const tokenRes = await support.auth.grantProviderToken({
          provider_id: wechatProviderId,
          provider_redirect_uri: redirectUri,
          provider_code: code,
        })
        const providerToken = tokenRes?.provider_token
        if (!providerToken) {
          throw new Error("未获取到微信授权凭证")
        }
        await support.auth.signInWithProvider({ provider_token: providerToken })
        clearTencentLoggedOut()
        router.replace("/")
        return
      } catch (e) {
        const message = extractTencentAuthError(e)
        toast({ title: "微信登录失败", description: message, variant: "destructive" })
      }
    }
    void run()
  }, [isTencent, router, toast])

  const handleMpLoginCallback = useCallback(async () => {
    if (!isTencent) return
    const callback = parseWxMpLoginCallback()
    if (!callback) return
    setIsSubmitting(true)
    try {
      if (callback.token && callback.openid) {
        const res = await fetch("/api/auth/mp-callback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: callback.token,
            openid: callback.openid,
            expiresIn: callback.expiresIn,
            nickName: callback.nickName,
            avatarUrl: callback.avatarUrl,
          }),
        })
        if (res.ok) {
          clearTencentLoggedOut()
          clearWxMpLoginParams()
          window.location.assign("/")
          return
        }
      }
      if (callback.code) {
        const result = await exchangeCodeForToken(
          callback.code,
          callback.nickName,
          callback.avatarUrl
        )
        if (result.success) {
          clearTencentLoggedOut()
          clearWxMpLoginParams()
          window.location.assign("/")
          return
        }
      }
      clearWxMpLoginParams()
    } catch (error) {
      clearWxMpLoginParams()
      const message = extractTencentAuthError(error)
      toast({ title: "微信登录失败", description: message, variant: "destructive" })
    } finally {
      setIsSubmitting(false)
    }
  }, [isTencent, toast])

  useEffect(() => {
    void handleMpLoginCallback()
  }, [handleMpLoginCallback])

  useEffect(() => {
    if (view !== "reset") return
    if (resetResendCountdown <= 0) return
    const timer = window.setTimeout(() => {
      setResetResendCountdown((prev) => (prev > 0 ? prev - 1 : 0))
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [resetResendCountdown, view])

  const formatAuthError = (e: unknown): { title: string; description: string; variant?: "destructive"; nextView?: "verify" } => {
    const message =
      e instanceof Error ? e.message : typeof e === "string" ? e : "操作失败"
    const normalized = message.toLowerCase()
    const status = typeof (e as { status?: unknown } | null)?.status === "number" ? (e as { status: number }).status : undefined

    if (normalized.includes("invalid login credentials") || normalized.includes("invalid credentials")) {
      return { title: "账号或密码错误", description: "请检查邮箱和密码后重试。", variant: "destructive" }
    }

    if (/not confirmed|confirm(ed)?|验证邮箱/i.test(message) || normalized.includes("email not confirmed")) {
      return { title: "邮箱未验证", description: "请先完成邮箱验证后再登录。", nextView: "verify" }
    }

    if (normalized.includes("user already registered") || normalized.includes("already registered")) {
      return { title: "该邮箱已注册", description: "请直接登录，或稍后使用找回密码。", variant: "destructive" }
    }

    if (normalized.includes("provider email not found") || normalized.includes("email not found from endpoint")) {
      return { title: "邮箱登录未开启", description: "请在云开发控制台启用邮箱登录并配置发件邮箱。", variant: "destructive" }
    }

    if (normalized.includes("too many requests") || status === 429) {
      return { title: "请求过于频繁", description: "请稍后再试。", variant: "destructive" }
    }

    if (normalized.includes("network") || normalized.includes("fetch failed")) {
      return { title: "网络异常", description: "请检查网络连接后重试。", variant: "destructive" }
    }

    return { title: "登录失败", description: message, variant: "destructive" }
  }

  const extractTencentAuthError = (e: unknown): string => {
    if (e instanceof Error && e.message) return e.message
    if (typeof e === "string") return e
    if (e && typeof e === "object") {
      const maybe = e as { message?: unknown; error?: unknown; status?: unknown }
      if (typeof maybe.status === "string" && maybe.status) return maybe.status
      if (typeof maybe.message === "string" && maybe.message) return maybe.message
      if (maybe.error) return extractTencentAuthError(maybe.error)
      if (typeof (e as { toString?: () => string }).toString === "function") {
        const text = (e as { toString: () => string }).toString()
        if (text && text !== "[object Object]") return text
      }
    }
    return "操作失败"
  }

  const validateTencentPassword = (value: string): boolean => {
    if (!value) return false
    if (value.length < 6 || value.length > 20) return false
    const hasLetter = /[A-Za-z]/.test(value)
    const hasNumber = /\d/.test(value)
    return hasLetter && hasNumber
  }

  const handleEmailLogin = async () => {
    setIsSubmitting(true)
    try {
      if (isTencent) {
        const { getCloudBaseAuth } = await import("@/lib/cloudbase-client")
        const auth = getCloudBaseAuth()
        await ensureCloudbasePersistence(auth)
        const trimmedEmail = email.trim()
        if (!trimmedEmail) {
          toast({ title: "邮箱不能为空", description: "请输入邮箱后重试。", variant: "destructive" })
          return
        }

        // 尝试本地登录逻辑 (用于本地环境或 CloudBase 登录失败时)
        const tryLocalLogin = async () => {
          const res = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: trimmedEmail, password })
          })
          const data = await res.json()
          if (data.success) {
            clearTencentLoggedOut()
            window.location.assign("/")
            return true
          }
          return false
        }

        // 如果是本地环境，优先尝试本地 API 登录以获得更好的开发体验
        const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
        if (isLocal) {
          const success = await tryLocalLogin()
          if (success) return
        }

        if (typeof auth.signOut === "function") {
          try {
            await auth.signOut()
          } catch { }
        }

        try {
          if (typeof auth.signInWithPassword === "function") {
            const result = await auth.signInWithPassword({ email: trimmedEmail, password })
            if (result?.error) throw result.error
            clearTencentLoggedOut()
            await syncTencentUser(trimmedEmail, password)
            router.replace("/")
            return
          }
          if (typeof auth.signInWithEmailAndPassword === "function") {
            await auth.signInWithEmailAndPassword(trimmedEmail, password)
            clearTencentLoggedOut()
            await syncTencentUser(trimmedEmail, password)
            router.replace("/")
            return
          }
        } catch (cloudbaseErr) {
          // 如果 CloudBase 登录失败且之前没尝试过本地登录，则尝试本地登录
          if (!isLocal) {
            const success = await tryLocalLogin()
            if (success) return
          }
          throw cloudbaseErr
        }

        toast({ title: "当前 SDK 不支持邮箱密码登录", description: "请升级云开发 JS SDK 后重试。", variant: "destructive" })
        return
      }
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      })
      if (error) throw error
      router.replace("/")
    } catch (e) {
      const formatted = formatAuthError(e)
      toast({
        title: formatted.title,
        description: formatted.description,
        variant: formatted.variant,
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleEmailSignup = async () => {
    setIsSubmitting(true)
    try {
      if (isTencent) {
        const trimmedEmail = email.trim()
        const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"

        // 本地环境直接调用注册接口，跳过验证码
        if (isLocal) {
          const res = await fetch("/api/auth/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: trimmedEmail, password })
          })
          const data = await res.json()
          if (data.success) {
            toast({ title: "注册成功", description: "账号已在本地环境创建，请直接登录。" })
            return
          } else {
            throw new Error(data.error || "注册失败")
          }
        }

        const { getCloudBaseAuth } = await import("@/lib/cloudbase-client")
        const auth = getCloudBaseAuth()
        await ensureCloudbasePersistence(auth)
        if (verificationRequestLock.current) return
        verificationRequestLock.current = true
        try {
          const verification = await auth.getVerification({ email: trimmedEmail })
          setVerificationId(verification.verification_id)
          setVerificationEmail(trimmedEmail)
          if (verification.is_user) {
            toast({ title: "该邮箱已注册", description: "请直接登录。", variant: "destructive" })
            setView("form")
            return
          }
          toast({
            title: "验证码已发送",
            description: "请查收邮箱验证码完成注册。",
          })
          setView("verify")
        } finally {
          verificationRequestLock.current = false
        }
        return
      }
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
      })
      if (error) throw error

      if (data.session) {
        router.replace("/")
        return
      }

      toast({
        title: "注册成功",
        description: "验证码已发送到邮箱，请输入验证码完成注册并登录。",
      })
      setView("verify")
    } catch (e) {
      const message = e instanceof Error ? e.message : "注册失败"
      toast({ title: "注册失败", description: message, variant: "destructive" })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleVerifySignupCode = async () => {
    setIsSubmitting(true)
    try {
      const trimmedEmail = email.trim()
      const trimmedCode = emailCode.trim()
      if (isTencent) {
        const { getCloudBaseAuth } = await import("@/lib/cloudbase-client")
        const auth = getCloudBaseAuth()
        await ensureCloudbasePersistence(auth)
        if (!trimmedEmail || !trimmedCode) {
          toast({ title: "验证码不能为空", description: "请输入邮箱验证码后重试。", variant: "destructive" })
          return
        }
        if (!password) {
          toast({ title: "密码不能为空", description: "请输入密码后重试。", variant: "destructive" })
          return
        }
        if (verificationVerifyLock.current) return
        verificationVerifyLock.current = true
        try {
          if (verificationEmail && verificationEmail !== trimmedEmail) {
            toast({ title: "邮箱不一致", description: "请使用接收验证码的邮箱完成验证。", variant: "destructive" })
            return
          }
          const signUpRes = await auth.signUp({
            email: trimmedEmail,
            password,
            username: buildTencentUsername(trimmedEmail),
          })
          if (signUpRes?.error) throw signUpRes.error
          if (!signUpRes?.data?.verifyOtp) {
            throw new Error("验证码流程不可用")
          }
          const verifyRes = await signUpRes.data.verifyOtp({
            token: trimmedCode,
            messageId: verificationId || undefined,
          })
          if (verifyRes?.error) throw verifyRes.error
          clearTencentLoggedOut()
          await syncTencentUser(trimmedEmail, password)
          toast({ title: "验证成功", description: "已完成注册并登录。" })
          router.replace("/")
          return
        } finally {
          verificationVerifyLock.current = false
        }
      }
      const { data, error } = await supabase.auth.verifyOtp({
        email: trimmedEmail,
        token: trimmedCode,
        type: "signup",
      })
      if (error) throw error

      if (data.session) {
        toast({ title: "验证成功", description: "已完成注册并登录。" })
        router.replace("/")
        return
      }

      const { error: loginError } = await supabase.auth.signInWithPassword({
        email: trimmedEmail,
        password,
      })
      if (loginError) throw loginError
      toast({ title: "验证成功", description: "已完成注册并登录。" })
      router.replace("/")
    } catch (e) {
      if (isTencent) {
        const rawMessage = extractTencentAuthError(e)
        const normalized = rawMessage.toLowerCase()
        let description = rawMessage
        if (normalized.includes("invalid_argument")) {
          description = "参数不合法。请重新获取验证码，并将密码设置为包含字母和数字的 6-20 位组合。"
        } else if (normalized.includes("invalid_verification_code")) {
          description = "验证码无效或已过期，请点击重新发送后再试。"
        } else if (normalized.includes("already_exists")) {
          description = "该邮箱已注册，请直接登录或重置密码。"
        } else if (normalized.includes("invalid_password")) {
          description = "密码不符合要求，请使用包含字母和数字的 6-20 位组合。"
        }
        toast({
          title: "验证失败",
          description,
          variant: "destructive",
        })
        return
      }
      const formatted = formatAuthError(e)
      toast({
        title: formatted.title === "登录失败" ? "验证失败" : formatted.title,
        description: formatted.description,
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleResendSignupCode = async () => {
    setIsSubmitting(true)
    try {
      const trimmedEmail = email.trim()
      if (isTencent) {
        const { getCloudBaseAuth } = await import("@/lib/cloudbase-client")
        const auth = getCloudBaseAuth()
        await ensureCloudbasePersistence(auth)
        if (verificationRequestLock.current) return
        verificationRequestLock.current = true
        try {
          const verification = await auth.getVerification({ email: trimmedEmail })
          setVerificationId(verification.verification_id)
          setVerificationEmail(trimmedEmail)
          toast({ title: "已重新发送", description: "请查收邮箱中的验证码。" })
        } finally {
          verificationRequestLock.current = false
        }
        return
      }
      const { error } = await supabase.auth.resend({
        type: "signup",
        email: trimmedEmail,
      })
      if (error) throw error
      toast({ title: "已重新发送", description: "请查收邮箱中的验证码。" })
    } catch (e) {
      const message = e instanceof Error ? e.message : "发送失败"
      toast({ title: "发送失败", description: message, variant: "destructive" })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSendResetCode = async () => {
    setIsSubmitting(true)
    try {
      if (!isTencent) {
        toast({ title: "当前环境暂不支持", description: "请联系管理员处理密码找回。", variant: "destructive" })
        return
      }
      const trimmedEmail = email.trim()
      if (!trimmedEmail) {
        toast({ title: "邮箱不能为空", description: "请输入邮箱后重试。", variant: "destructive" })
        return
      }
      const { getCloudBaseAuth } = await import("@/lib/cloudbase-client")
      const auth = getCloudBaseAuth()
      await ensureCloudbasePersistence(auth)
      if (resetRequestLock.current) return
      resetRequestLock.current = true
      try {
        const verification = await auth.getVerification({ email: trimmedEmail })
        setResetVerificationId(verification.verification_id)
        setResetVerificationEmail(trimmedEmail)
        if (!verification.is_user) {
          toast({ title: "邮箱未注册", description: "该邮箱尚未注册，请先完成注册。", variant: "destructive" })
          return
        }
        setResetResendCountdown(60)
        toast({ title: "验证码已发送", description: "请查收邮箱中的验证码。" })
      } finally {
        resetRequestLock.current = false
      }
    } catch (e) {
      const message = extractTencentAuthError(e)
      toast({ title: "发送失败", description: message, variant: "destructive" })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleResetPassword = async () => {
    setIsSubmitting(true)
    try {
      if (!isTencent) {
        toast({ title: "当前环境暂不支持", description: "请联系管理员处理密码找回。", variant: "destructive" })
        return
      }
      const trimmedEmail = email.trim()
      const trimmedResetCode = resetCode.trim()
      if (!trimmedEmail || !trimmedResetCode || !password || !confirmPassword) {
        toast({ title: "信息不完整", description: "请填写邮箱、新密码、确认密码和验证码。", variant: "destructive" })
        return
      }
      if (password !== confirmPassword) {
        toast({ title: "两次密码不一致", description: "请确认两次输入的新密码相同。", variant: "destructive" })
        return
      }
      if (!validateTencentPassword(password)) {
        toast({ title: "密码不符合要求", description: "请使用包含字母和数字的 6-20 位组合。", variant: "destructive" })
        return
      }
      if (resetVerificationEmail && resetVerificationEmail !== trimmedEmail) {
        toast({ title: "邮箱不一致", description: "请使用接收验证码的邮箱完成重置。", variant: "destructive" })
        return
      }

      const { getCloudBaseAuth } = await import("@/lib/cloudbase-client")
      const auth = getCloudBaseAuth()
      await ensureCloudbasePersistence(auth)
      if (resetVerifyLock.current) return
      resetVerifyLock.current = true
      try {
        const verifyRes = await auth.verify({
          verification_code: trimmedResetCode,
          verification_id: resetVerificationId || undefined,
        })
        const verificationToken = verifyRes?.verification_token
        if (!verificationToken) {
          throw new Error("验证码无效或已过期，请重新发送后重试")
        }
        await auth.resetPassword({
          email: trimmedEmail,
          new_password: password,
          verification_token: verificationToken,
        })
      } finally {
        resetVerifyLock.current = false
      }

      toast({ title: "密码重置成功", description: "请使用新密码登录。" })
      setPassword("")
      setConfirmPassword("")
      setResetCode("")
      setResetResendCountdown(0)
      setResetVerificationId(null)
      setResetVerificationEmail(null)
      setView("form")
    } catch (e) {
      const rawMessage = extractTencentAuthError(e)
      const normalized = rawMessage.toLowerCase()
      let description = rawMessage
      if (normalized.includes("invalid_verification_code")) {
        description = "验证码无效或已过期，请重新发送后重试。"
      } else if (normalized.includes("invalid_password")) {
        description = "密码不符合要求，请使用包含字母和数字的 6-20 位组合。"
      }
      toast({ title: "重置失败", description, variant: "destructive" })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleGoogleLogin = async () => {
    setIsSubmitting(true)
    try {
      const redirectTo = `${window.location.origin}/auth/callback`
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo, skipBrowserRedirect: true },
      })
      if (error) throw error
      if (data?.url) {
        window.location.assign(data.url)
        return
      }
      throw new Error("无法获取 Google 授权链接")
    } catch (e) {
      const message = e instanceof Error ? e.message : "Google 登录失败"
      toast({ title: "登录失败", description: message, variant: "destructive" })
      setIsSubmitting(false)
    }
  }

  const handleWechatLogin = async () => {
    setIsSubmitting(true)
    try {
      const { getCloudBaseAuth } = await import("@/lib/cloudbase-client")
      const auth = getCloudBaseAuth()
      await ensureCloudbasePersistence(auth)
      const support = getWechatSupport(auth)
      clearTencentLoggedOut()
      if (support.mode === "legacy") {
        await support.provider.signInWithRedirect()
        return
      }
      const redirectUri = getWechatRedirectUri()
      const state = `login_${Math.random().toString(36).slice(2, 10)}`
      try {
        window.sessionStorage.setItem("tencent:wechat:state", state)
      } catch {
        return
      }
      const { uri } = await support.auth.genProviderRedirectUri({
        provider_id: wechatProviderId,
        redirect_uri: redirectUri,
        provider_redirect_uri: redirectUri,
        state,
        scope: wechatScope,
        response_type: "code",
      })
      if (!uri) {
        throw new Error("无法获取微信授权链接")
      }
      window.location.assign(uri)
    } catch (e) {
      const message = extractTencentAuthError(e)
      toast({ title: "微信登录失败", description: message, variant: "destructive" })
      setIsSubmitting(false)
    }
  }

  const handleWechatLoginClick = async () => {
    if (!canUseWechatLogin) return
    // Android App Detection (Median/GoNative)
    if (isMedianApp) {
      setIsSubmitting(true)
      try {
        const appId = "wxd2f4ea51e526a132"
        const redirectUri = `${window.location.origin}/auth/wechat/android/callback`
        const state = `login_${Math.random().toString(36).slice(2, 10)}`
        const scope = "snsapi_userinfo"

        const authUrl = `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${appId}&redirect_uri=${encodeURIComponent(
          redirectUri
        )}&response_type=code&scope=${scope}&state=${state}#wechat_redirect`

        window.location.href = authUrl
        return
      } catch (e) {
        const message = extractTencentAuthError(e)
        toast({ title: "微信登录失败", description: message, variant: "destructive" })
        setIsSubmitting(false)
        return
      }
    }

    const isMpFlag = isMiniProgram() || isInMiniProgram
    if (isMpFlag) {
      setIsSubmitting(true)
      try {
        const ok = await requestWxMpLogin()
        if (!ok) {
          throw new Error("未检测到微信小程序环境")
        }
      } catch (e) {
        const message = extractTencentAuthError(e)
        toast({ title: "微信登录失败", description: message, variant: "destructive" })
        setIsSubmitting(false)
      }
      return
    }
    const ensured = await ensureMiniProgramEnv()
    if (ensured) {
      setIsSubmitting(true)
      try {
        const ok = await requestWxMpLogin()
        if (!ok) {
          throw new Error("未检测到微信小程序环境")
        }
      } catch (e) {
        const message = extractTencentAuthError(e)
        toast({ title: "微信登录失败", description: message, variant: "destructive" })
        setIsSubmitting(false)
      }
      return
    }
    await handleWechatLogin()
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">登录 / 注册</CardTitle>
          <CardDescription>
            {view === "verify"
              ? "输入邮箱验证码完成注册并登录"
              : view === "reset"
                ? "通过邮箱验证码重置密码"
              : isTencent
                ? (canUseWechatLogin ? "使用邮箱或微信继续" : "仅使用邮箱继续")
                : "使用邮箱或 Google 账号继续"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <WechatMiniProgramDetector onDetect={setIsInMiniProgram} />
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">邮箱</Label>
              <Input
                id="email"
                type="email"
                placeholder="name@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">{view === "reset" ? "新密码" : "密码"}</Label>
              <Input
                id="password"
                type="password"
                placeholder={view === "reset" ? "请输入新密码" : "请输入密码"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={view === "form" ? "current-password" : "new-password"}
                required
              />
              <p className="text-xs text-muted-foreground">密码需包含字母和数字，长度 6-20 位。</p>
            </div>

            {view === "verify" ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="emailCode">邮箱验证码</Label>
                  <Input
                    id="emailCode"
                    inputMode="numeric"
                    placeholder="请输入邮件中的验证码"
                    value={emailCode}
                    onChange={(e) => setEmailCode(e.target.value)}
                    autoComplete="one-time-code"
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Button onClick={handleVerifySignupCode} disabled={isSubmitting || !email.trim() || !emailCode.trim()}>
                    验证并登录
                  </Button>
                  <Button variant="outline" onClick={handleResendSignupCode} disabled={isSubmitting || !email.trim()}>
                    重新发送
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  className="w-full"
                  onClick={() => {
                    setEmailCode("")
                    setVerificationId(null)
                    setVerificationEmail(null)
                    setView("form")
                  }}
                  disabled={isSubmitting}
                >
                  返回登录 / 注册
                </Button>
              </>
            ) : view === "reset" ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">确认新密码</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    placeholder="请再次输入新密码"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    autoComplete="new-password"
                    required
                  />
                  {confirmPassword && password !== confirmPassword ? (
                    <p className="text-xs text-destructive">两次输入的密码不一致</p>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="resetCode">邮箱验证码</Label>
                  <Input
                    id="resetCode"
                    inputMode="numeric"
                    placeholder="请输入邮件中的验证码"
                    value={resetCode}
                    onChange={(e) => setResetCode(e.target.value)}
                    autoComplete="one-time-code"
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Button
                    onClick={handleResetPassword}
                    disabled={isSubmitting || !email.trim() || !password || !confirmPassword || password !== confirmPassword || !resetCode.trim()}
                  >
                    重置密码
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleSendResetCode}
                    disabled={isSubmitting || !email.trim() || resetResendCountdown > 0}
                  >
                    {resetResendCountdown > 0 ? `${resetResendCountdown}s后重发` : "发送验证码"}
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  className="w-full"
                  onClick={() => {
                    setPassword("")
                    setConfirmPassword("")
                    setResetCode("")
                    setResetResendCountdown(0)
                    setResetVerificationId(null)
                    setResetVerificationEmail(null)
                    setView("form")
                  }}
                  disabled={isSubmitting}
                >
                  返回登录 / 注册
                </Button>
              </>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Button onClick={handleEmailLogin} disabled={isSubmitting || !email.trim() || !password}>
                  邮箱登录
                </Button>
                <Button variant="outline" onClick={handleEmailSignup} disabled={isSubmitting || !email.trim() || !password}>
                  邮箱注册
                </Button>
              </div>
            )}

            {view === "form" && isTencent ? (
              <div className="flex justify-center pt-1">
                <Button
                  variant="link"
                  className="h-auto p-0 text-sm font-medium text-muted-foreground hover:text-primary focus-visible:text-primary"
                  onClick={() => {
                    setPassword("")
                    setConfirmPassword("")
                    setResetCode("")
                    setResetResendCountdown(0)
                    setResetVerificationId(null)
                    setResetVerificationEmail(null)
                    setView("reset")
                  }}
                  disabled={isSubmitting}
                >
                  忘记密码？通过邮箱验证码找回
                </Button>
              </div>
            ) : null}
          </div>

          {view === "form" ? (
            isTencent ? (
              canUseWechatLogin ? (
                <>
                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t border-border" />
                    </div>
                    <div className="relative flex justify-center text-xs uppercase">
                      <span className="bg-card px-2 text-muted-foreground">或</span>
                    </div>
                  </div>
                  <Button variant="outline" className="w-full bg-transparent" onClick={handleWechatLoginClick} disabled={isSubmitting}>
                    使用微信登录
                  </Button>
                </>
              ) : null
            ) : (
              <>
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t border-border" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">或</span>
                  </div>
                </div>
                <Button variant="outline" className="w-full bg-transparent" onClick={handleGoogleLogin} disabled={isSubmitting}>
                  使用 Google 登录
                </Button>
              </>
            )
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
