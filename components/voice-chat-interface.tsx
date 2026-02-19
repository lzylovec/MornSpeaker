"use client"

import { useState, useCallback, useEffect, useMemo, useRef } from "react"
import { useParams, useSearchParams } from "next/navigation"
import { Header } from "@/components/header"
import { ChatArea } from "@/components/chat-area"
import { VoiceControls } from "@/components/voice-controls"
import { RoomJoin } from "@/components/room-join"
import { UserList, type User } from "@/components/user-list"
import { AdSlot } from "@/components/ad-slot"
import { detectLanguageFromText, encodeFloat32ToWav, resampleTo16k, transcribeAudio, translateText } from "@/lib/audio-utils"
import { useToast } from "@/hooks/use-toast"
import type { AppSettings } from "@/components/settings-dialog"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { LogOut, Copy, Check, Settings, Users, Mic, MicOff, PhoneOff, Phone, Video, VideoOff, ScreenShare, ScreenShareOff, ArrowRightLeft, Send } from "lucide-react"
import { useAuth } from "@/components/auth-provider"
import { useI18n } from "@/components/i18n-provider"
import { Sheet, SheetContent, SheetTrigger, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { useTextToSpeech } from "@/hooks/use-text-to-speech"
import TRTC from "trtc-sdk-v5"
import { RealtimeTranscriber } from "trtc-sdk-v5/plugins/realtime-transcriber"
import { TencentASR } from "@/lib/asr-client"

declare global {
  interface Window {
    __medianPushNativeAudio?: (base64: string, sampleRate: number, channels: number) => void
    mornspeakerOnSystemAudioStatus?: (status: string) => void
    mornspeakerStartSystemAudio?: () => void
    mornspeakerStopSystemAudio?: () => void
    AndroidTencentAsr?: {
      startAsr: (configJson: string) => void
      stopAsr: () => void
      cancelAsr: () => void
    }
    mornspeakerOnAsrResult?: (text: string, isFinal: boolean) => void
    mornspeakerOnAsrError?: (error: string) => void
    mornspeakerOnAsrState?: (state: string) => void
  }
}

export type Language = {
  code: string
  name: string
  flag: string
}

type SpeechRecognitionAlternativeLike = { transcript: string }
type SpeechRecognitionResultLike = { length: number;[index: number]: SpeechRecognitionAlternativeLike }
type SpeechRecognitionResultListLike = { length: number;[index: number]: SpeechRecognitionResultLike }
type SpeechRecognitionEventLike = { results: SpeechRecognitionResultListLike }
type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: unknown) => void) | null
  onend: (() => void) | null
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

export const SUPPORTED_LANGUAGES: Language[] = [
  { code: "en-US", name: "英语", flag: "🇺🇸" },
  { code: "zh-CN", name: "中文", flag: "🇨🇳" },
  { code: "ja-JP", name: "日语", flag: "🇯🇵" },
  { code: "es-ES", name: "西班牙语", flag: "🇪🇸" },
  { code: "fr-FR", name: "法语", flag: "🇫🇷" },
  { code: "de-DE", name: "德语", flag: "🇩🇪" },
  { code: "ko-KR", name: "韩语", flag: "🇰🇷" },
  { code: "pt-BR", name: "葡萄牙语", flag: "🇧🇷" },
]

export type Message = {
  id: string
  userId: string
  userName: string
  originalText: string
  translatedText: string
  originalLanguage: string
  targetLanguage: string
  timestamp: Date
  isUser: boolean
  audioUrl?: string
  userAvatar?: string
}

type RoomSettings = { adminUserId: string; joinMode: "public" | "password" } | null
type CallSignalType = "call_invite" | "call_accept" | "call_reject" | "call_end" | "call_busy" | "webrtc_offer" | "webrtc_answer" | "webrtc_ice" | "call_caption"
type CallSignalPayload = {
  type: CallSignalType
  callId: string
  fromUserId: string
  fromUserName: string
  toUserId: string
  sdp?: string
  sdpType?: RTCSdpType
  candidate?: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }
  transcript?: string
  confirmedTranscript?: string
  translation?: string
  sourceLanguage?: string
  targetLanguage?: string
  timestamp?: number
  seq?: number
}

const LIVE_CAPTION_SEND_DEBOUNCE_MS = 350
const LIVE_CAPTION_MAX_TEXT_LENGTH = 800
const ACTIVE_CALL_POLL_FAST_INTERVAL_MS = 3000
const ACTIVE_CALL_POLL_INTERVAL_MS = 3000
const ACTIVE_CALL_POLL_IDLE_INTERVAL_MS = 6000
const IDLE_POLL_INTERVAL_MS = 6000

type VoiceChatInterfaceProps = {
  initialRoomId?: string | null
  autoJoin?: boolean
}

export function VoiceChatInterface({ initialRoomId, autoJoin = false }: VoiceChatInterfaceProps) {
  const params = useParams()
  const searchParams = useSearchParams()
  const { profile, user, updateUserMetadata } = useAuth()
  const { t, locale } = useI18n()
  const [isInRoom, setIsInRoom] = useState(false)
  const [roomId, setRoomId] = useState("")
  const [anonUserId] = useState(() => {
    const fallback = `user-${Math.random().toString(36).substring(2, 11)}`
    if (typeof window === "undefined") return fallback
    const storageKey = "voicelink_anon_user_id"
    let storage: Storage | null = null
    try {
      storage = window.sessionStorage
    } catch {
      storage = null
    }
    const existing = storage?.getItem(storageKey)
    if (existing) return existing
    try {
      storage?.setItem(storageKey, fallback)
    } catch { }
    return fallback
  })
  const [roomUserId, setRoomUserId] = useState("")
  const [joinedAuthUserId, setJoinedAuthUserId] = useState<string | null>(null)
  const clientInstanceIdRef = useRef("")
  const [userName, setUserName] = useState("")
  const [users, setUsers] = useState<User[]>([])
  const [roomSettings, setRoomSettings] = useState<RoomSettings>(null)
  const [copied, setCopied] = useState(false)

  const [messages, setMessages] = useState<Message[]>([])
  const [inputText, setInputText] = useState("")
  const [sourceLanguage, setSourceLanguage] = useState<Language>(SUPPORTED_LANGUAGES[0])
  const [targetLanguage, setTargetLanguage] = useState<Language>(SUPPORTED_LANGUAGES[0])
  const [isRecording, setIsRecording] = useState(false)
  const [liveTranscript, setLiveTranscript] = useState("")
  const urlRoomId = useMemo(() => {
    const paramRoomId = typeof params?.roomId === "string" ? params.roomId.trim() : ""
    const searchRoomId = searchParams?.get("roomId")?.trim() ?? ""
    const propRoomId = typeof initialRoomId === "string" ? initialRoomId.trim() : ""
    return paramRoomId || searchRoomId || propRoomId || ""
  }, [initialRoomId, params, searchParams])
  const [liveTranslation, setLiveTranslation] = useState("")
  const [liveTranscriptLines, setLiveTranscriptLines] = useState<string[]>([])
  const [liveTranslationLines, setLiveTranslationLines] = useState<string[]>([])
  const [remoteLiveTranscript, setRemoteLiveTranscript] = useState("")
  const [remoteConfirmedTranscript, setRemoteConfirmedTranscript] = useState("")
  const [remoteLiveTranslation, setRemoteLiveTranslation] = useState("")
  const [remoteLiveSourceLanguage, setRemoteLiveSourceLanguage] = useState("")
  const [remoteLiveUserName, setRemoteLiveUserName] = useState("")
  const [liveSpeechSupported, setLiveSpeechSupported] = useState(true)
  const [isProcessing, setIsProcessing] = useState(false)
  const [settings, setSettings] = useState<AppSettings>({
    darkMode: false,
    autoPlayTranslations: true,
    onlyHearTranslatedVoice: true,
    speechRate: 0.9,
    speechVolume: 1.0,
    saveHistory: true,
    platform: "web",
  })
  const isTencentDeploy =
    typeof process !== "undefined" &&
    String(process.env.NEXT_PUBLIC_DEPLOY_TARGET ?? "")
      .trim()
      .toLowerCase() === "tencent"
  const isMobile = useMemo(() => {
    if (typeof navigator === "undefined") return false
    return /iphone|ipad|ipod|android/i.test(navigator.userAgent)
  }, [])
  const [callStatus, setCallStatus] = useState<"idle" | "outgoing" | "incoming" | "active">("idle")
  const [callPeer, setCallPeer] = useState<{ id: string; name: string } | null>(null)
  const [callId, setCallId] = useState<string | null>(null)
  const [incomingCallOpen, setIncomingCallOpen] = useState(false)
  const [isCallStreaming, setIsCallStreaming] = useState(false)
  const [callDurationSec, setCallDurationSec] = useState(0)
  const [isCallMuted, setIsCallMuted] = useState(false)
  const [callLiveEnabled, setCallLiveEnabled] = useState(true)
  const [isVideoEnabled, setIsVideoEnabled] = useState(false)
  const [isScreenSharing, setIsScreenSharing] = useState(false)
  const [remoteVideoAvailable, setRemoteVideoAvailable] = useState(false)
  const [remoteScreenAvailable, setRemoteScreenAvailable] = useState(false)
  const [remoteVideoUserId, setRemoteVideoUserId] = useState<string | null>(null)
  const [remoteScreenUserId, setRemoteScreenUserId] = useState<string | null>(null)
  const [remoteVideoStreamType, setRemoteVideoStreamType] = useState<any>(null)
  const [remoteScreenStreamType, setRemoteScreenStreamType] = useState<any>(null)
  // TRTC 全局设置（从后台管理读取）
  const [trtcGloballyEnabled, setTrtcGloballyEnabled] = useState<boolean | null>(null)
  const { toast } = useToast()
  const pollIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollAbortRef = useRef<AbortController | null>(null)
  const pollInFlightRef = useRef(false)
  const pollFailureCountRef = useRef(0)
  const pollLastCaptionActivityAtRef = useRef(0)
  const lastSyncedMessageAtRef = useRef<string | null>(null)
  const roomVersionRef = useRef(0)
  const pollSyncRoomRef = useRef<string | null>(null)
  const translationCacheRef = useRef<Map<string, string>>(new Map())
  const leaveInitiatedRef = useRef(false)
  const [roomSettingsOpen, setRoomSettingsOpen] = useState(false)
  const [roomSettingsJoinMode, setRoomSettingsJoinMode] = useState<"public" | "password">("public")
  const [roomSettingsPassword, setRoomSettingsPassword] = useState("")
  const [roomSettingsSaving, setRoomSettingsSaving] = useState(false)
  const [isUsersSheetOpen, setIsUsersSheetOpen] = useState(false)
  const languagePrefsInitKeyRef = useRef<string | null>(null)
  const lastSavedLanguagePrefsRef = useRef<{ userKey: string; source: string; target: string } | null>(null)
  const lastRoomLanguageUpdateRef = useRef<{ roomId: string; userId: string; source: string; target: string } | null>(null)
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const liveTranslateAbortRef = useRef<AbortController | null>(null)
  const liveTranslateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const remoteTranslateAbortRef = useRef<AbortController | null>(null)
  const remoteTranslateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const liveCaptionSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastLiveCaptionSentRef = useRef<{
    callId: string
    toUserId: string
    transcript: string
    confirmedTranscript: string
    translation: string
  } | null>(null)
  const liveCaptionSeqRef = useRef(0)
  const remoteCaptionSeqRef = useRef<Map<string, number>>(new Map())
  const liveAutoBreakTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const liveCommittedTranscriptRef = useRef("")
  const liveCommittedTranslationRef = useRef("")
  const fallbackRecorderRef = useRef<MediaRecorder | null>(null)
  const fallbackStreamRef = useRef<MediaStream | null>(null)
  const fallbackStreamOwnedRef = useRef(false)
  const fallbackQueueRef = useRef<Blob[]>([])
  const fallbackProcessingRef = useRef(false)
  const fallbackLastTextRef = useRef("")
  const fallbackAudioContextRef = useRef<AudioContext | null>(null)
  const fallbackProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const fallbackBufferedChunksRef = useRef<Float32Array[]>([])
  const fallbackBufferedSamplesRef = useRef(0)
  const callStatusRef = useRef(callStatus)
  const callPeerRef = useRef<{ id: string; name: string } | null>(null)
  const callIdRef = useRef<string | null>(null)
  const callRecorderRef = useRef<MediaRecorder | null>(null)
  const callStreamRef = useRef<MediaStream | null>(null)
  const callQueueRef = useRef<Blob[]>([])
  const callProcessingRef = useRef(false)
  const callActiveRef = useRef(false)
  const trtcRef = useRef<any>(null)
  const tencentAsrRef = useRef<any>(null)
  const aiTranscriberListenerRef = useRef<any>(null)
  const aiTranscriberStateListenerRef = useRef<any>(null)
  const aiTranscriberCustomListenerRef = useRef<any>(null)
  const aiTranscriberRobotIdRef = useRef<string | null>(null)
  const trtcErrorListenerRef = useRef<any>(null)
  const aiTranscriberTranslationRef = useRef<string>("")
  const aiTranscriberSourceLangRef = useRef<string>("")
  const aiTranscriberTargetLangRef = useRef<string>("")
  const trtcUserIdRef = useRef<string | null>(null)
  const trtcRoomIdRef = useRef<number | null>(null)
  const trtcCleanupInProgressRef = useRef(false)
  const [trtcTranscriberActive, setTrtcTranscriberActive] = useState(false)
  const [trtcTranscriberTranslationActive, setTrtcTranscriberTranslationActive] = useState(false)
  const trtcTranscriberActiveRef = useRef(false)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
  const localVideoRef = useRef<HTMLDivElement | null>(null)
  const remoteVideoRef = useRef<HTMLDivElement | null>(null)
  const localScreenRef = useRef<HTMLDivElement | null>(null)
  const remoteScreenRef = useRef<HTMLDivElement | null>(null)
  const remoteVideoStartedRef = useRef<string | null>(null)
  const remoteScreenStartedRef = useRef<string | null>(null)
  const liveListenRef = useRef(false)
  const { speak, speakWithOptions, unlock: unlockTts, isSupported: ttsSupported, isUnlocked: isTtsUnlocked, isSpeaking: ttsSpeaking, getVoices, getLastVoice } = useTextToSpeech({
    rate: settings.speechRate,
    volume: settings.speechVolume,
  })
  const remoteCommittedTranslationRef = useRef("")
  const remoteCommittedTranscriptRef = useRef("")
  const remoteSpokenTranslationRef = useRef("")
  const remoteLastSpokenTextRef = useRef("")
  const trtcCustomCaptionActiveRef = useRef(false)
  const remoteTranslateLatestRef = useRef("")
  const remoteTranslateSourceRef = useRef("")
  const remoteTranslateTargetRef = useRef("")
  const mutePipelineStateRef = useRef<boolean | null>(null)
  const remoteTranslationSignalAtRef = useRef(0)
  const callAsrErrorToastAtRef = useRef(0)
  const ttsUnlockedRef = useRef(false)
  const ttsUnlockingRef = useRef(false)
  const ttsSpeakingRef = useRef(false)
  const ttsLastStartRef = useRef(0)
  const ttsUnsupportedNotifiedRef = useRef(false)
  const pendingTtsRef = useRef<{ text: string; lang: string } | null>(null)
  const ttsDeferredTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ttsDeferredTextRef = useRef("")
  const ttsDeferredFullRef = useRef("")
  const finalCaptionDedupRef = useRef<Map<string, { text: string; at: number }>>(new Map())
  const trtcSettingLoadedRef = useRef(false)
  const trtcEnabledCacheRef = useRef(false)

  const refreshTrtcSetting = useCallback(async (options?: { force?: boolean }) => {
    const force = options?.force === true
    if (!force && trtcSettingLoadedRef.current) {
      return trtcEnabledCacheRef.current
    }
    try {
      const res = await fetch("/api/settings/trtc", { cache: "no-store" })
      const data = (await res.json().catch(() => null)) as { enabled?: unknown } | null
      const enabled = data?.enabled === true
      setTrtcGloballyEnabled(enabled)
      trtcEnabledCacheRef.current = enabled
      trtcSettingLoadedRef.current = true
      return enabled
    } catch (err) {
      console.error("[TRTC] Failed to fetch setting:", err)
      if (trtcSettingLoadedRef.current) {
        return trtcEnabledCacheRef.current
      }
      setTrtcGloballyEnabled(false)
      trtcEnabledCacheRef.current = false
      trtcSettingLoadedRef.current = true
      return false
    }
  }, [])

  // 仅初始化时获取 TRTC 全局设置，通话前再按需刷新
  useEffect(() => {
    void refreshTrtcSetting({ force: true })
  }, [refreshTrtcSetting])

  useEffect(() => {
    callStatusRef.current = callStatus
    callPeerRef.current = callPeer
    callIdRef.current = callId
  }, [callStatus, callPeer, callId])

  useEffect(() => {
    if (typeof window === "undefined") return
    const shouldIgnore = (message: string) => {
      const normalized = String(message || "").toLowerCase()
      return (
        normalized.includes("api_call_aborted") ||
        normalized.includes("unsubscribe aborted") ||
        normalized.includes("0x404d") ||
        (normalized.includes("connection closed") && normalized.includes("unsubscribe"))
      )
    }
    const handleError = (event: ErrorEvent) => {
      const message = event?.message || event?.error?.message || ""
      if (shouldIgnore(message)) {
        event.preventDefault?.()
      }
    }
    const handleRejection = (event: PromiseRejectionEvent) => {
      const reason = event?.reason
      const message = typeof reason === "string" ? reason : reason?.message || ""
      if (shouldIgnore(message)) {
        event.preventDefault?.()
      }
    }
    window.addEventListener("error", handleError)
    window.addEventListener("unhandledrejection", handleRejection)
    return () => {
      window.removeEventListener("error", handleError)
      window.removeEventListener("unhandledrejection", handleRejection)
    }
  }, [])

  useEffect(() => {
    ttsUnlockedRef.current = isTtsUnlocked
  }, [isTtsUnlocked])

  useEffect(() => {
    ttsSpeakingRef.current = ttsSpeaking
    if (ttsSpeaking) {
      ttsLastStartRef.current = Date.now()
    }
  }, [ttsSpeaking])

  // Native ASR Callbacks
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.mornspeakerOnAsrResult = (text: string, isFinal: boolean) => {
        console.log("Native ASR Result:", text, isFinal)
        const isHallucination = (t: string) => {
          const str = t.toLowerCase().replace(/[.,!?。，！？]/g, '')
          if (str === "你好") return true
          if (str === "你好你好") return true
          if (str === "不客气") return true
          if (str === "谢谢") return true
          if (str === "bye") return true
          if (str === "you're welcome") return true
          if (str === "字幕" || str.includes("subtitles by")) return true
          if (str === "amaraorg") return true
          return false
        }

        if (text && !isHallucination(text)) {
          // Native SDK returns full text for the current sentence/segment?
          // Based on TencentAsrManager.java:
          // onSliceSuccess (interim) -> isFinal=false
          // onSegmentSuccess (final) -> isFinal=true
          // And it passes result.getText() which is usually the text of the current sentence.

          // Logic similar to WebSocket handling
          // But we don't have voice_id here easily unless we change Java.
          // Assuming Java sends the accumulated text for the current sentence.

          if (isFinal) {
            const isCJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text)
            sessionTranscriptRef.current += text + (isCJK ? "" : " ")
            setConfirmedTranscript(sessionTranscriptRef.current)
            setLiveTranscript(sessionTranscriptRef.current)
            setIsInterim(false)
          } else {
            setLiveTranscript(sessionTranscriptRef.current + text)
            setIsInterim(true)
          }
        }
      }

      window.mornspeakerOnAsrError = (error: string) => {
        console.error("Native ASR Error:", error)
        toast({
          title: "语音识别错误",
          description: error,
          variant: "destructive",
        })
        setAsrMode("off")
      }

      window.mornspeakerOnAsrState = (state: string) => {
        console.log("Native ASR State:", state)
        if (state === "recording") {
          setAsrMode("websocket") // reuse websocket mode indicator for active state
        } else if (state === "stopped") {
          setAsrMode("off")
        }
      }
    }
  }, [toast])

  const randomId = useCallback((): string => {
    if (typeof window !== "undefined" && typeof window.crypto?.randomUUID === "function") {
      return window.crypto.randomUUID()
    }
    return `call-${Math.random().toString(36).substring(2, 11)}`
  }, [])

  const fallbackTrtcUserId = useCallback((value: string) => {
    const input = typeof value === "string" ? value : String(value)
    let hash1 = 2166136261
    let hash2 = 2166136261 ^ 0xffffffff
    for (let i = 0; i < input.length; i += 1) {
      const code = input.charCodeAt(i)
      hash1 = Math.imul(hash1 ^ code, 16777619) >>> 0
      hash2 = Math.imul(hash2 ^ (code + 2654435761), 16777619) >>> 0
    }
    const part1 = hash1.toString(16).padStart(8, "0")
    const part2 = hash2.toString(16).padStart(8, "0")
    return (part1 + part2 + part1 + part2).slice(0, 32)
  }, [])

  const getTrtcUserId = useCallback(async (userId: string) => {
    const subtle = globalThis.crypto?.subtle
    if (subtle && typeof TextEncoder !== "undefined") {
      try {
        const msgUint8 = new TextEncoder().encode(userId)
        const hashBuffer = await subtle.digest("SHA-256", msgUint8)
        const hashArray = Array.from(new Uint8Array(hashBuffer))
        const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
        return hashHex.substring(0, 32)
      } catch {
        return fallbackTrtcUserId(userId)
      }
    }
    return fallbackTrtcUserId(userId)
  }, [fallbackTrtcUserId])

  const stopFallbackLive = useCallback(() => {
    // Stop Android Native ASR if running
    if (typeof window !== "undefined" && window.AndroidTencentAsr && isMobile) {
      try {
        window.AndroidTencentAsr.stopAsr()
      } catch (e) {
        console.error("Error stopping Android ASR", e)
      }
    }

    if (fallbackRecorderRef.current) {
      try {
        if (fallbackRecorderRef.current.state !== "inactive") {
          fallbackRecorderRef.current.stop()
        }
      } catch { }
      fallbackRecorderRef.current = null
    }
    if (fallbackProcessorRef.current) {
      try {
        fallbackProcessorRef.current.disconnect()
      } catch { }
      fallbackProcessorRef.current = null
    }
    if (fallbackAudioContextRef.current) {
      try {
        void fallbackAudioContextRef.current.close()
      } catch { }
      fallbackAudioContextRef.current = null
    }
    if (fallbackStreamRef.current && fallbackStreamOwnedRef.current) {
      try {
        fallbackStreamRef.current.getTracks().forEach((t) => t.stop())
      } catch { }
    }
    fallbackStreamRef.current = null
    fallbackStreamOwnedRef.current = false
    fallbackQueueRef.current = []
    fallbackProcessingRef.current = false
    fallbackLastTextRef.current = ""
    fallbackBufferedChunksRef.current = []
    fallbackBufferedSamplesRef.current = 0
  }, [])

  const resetTrtcTranscriberState = useCallback(() => {
    aiTranscriberRobotIdRef.current = null
    aiTranscriberTranslationRef.current = ""
    aiTranscriberSourceLangRef.current = ""
    aiTranscriberTargetLangRef.current = ""
    trtcTranscriberActiveRef.current = false
    setTrtcTranscriberActive(false)
    setTrtcTranscriberTranslationActive(false)
    trtcCustomCaptionActiveRef.current = false
  }, [])

  const stopTrtcRealtimeTranscriber = useCallback(async () => {
    const trtc = trtcRef.current
    const robotId = aiTranscriberRobotIdRef.current
    if (trtc && robotId && trtcTranscriberActiveRef.current) {
      try {
        await trtc.stopPlugin("RealtimeTranscriber", { transcriberRobotId: robotId })
      } catch { }
    }
    resetTrtcTranscriberState()
  }, [resetTrtcTranscriberState])

  const isTrtcAbortError = useCallback((error: any) => {
    const message = error?.errorMessage || error?.message || error
    const normalized = String(message || "").toLowerCase()
    const codeValue = typeof error?.errorCode === "number"
      ? error.errorCode
      : Number.parseInt(String(error?.errorCode ?? error?.code ?? ""), 10)
    return (
      normalized.includes("api_call_aborted") ||
      normalized.includes("unsubscribe aborted") ||
      codeValue === 0x404d ||
      codeValue === 16461
    )
  }, [])

  const safeStopLocalAudio = useCallback(async (trtc: any) => {
    if (!trtc || typeof trtc.stopLocalAudio !== "function") return
    try {
      await Promise.resolve(trtc.stopLocalAudio())
    } catch (err) {
      if (!isTrtcAbortError(err)) {
        console.error("[TRTC] stopLocalAudio failed", err)
      }
    }
  }, [isTrtcAbortError])

  const safeStopLocalVideo = useCallback(async (trtc: any) => {
    if (!trtc || typeof trtc.stopLocalVideo !== "function") return
    try {
      await Promise.resolve(trtc.stopLocalVideo())
    } catch (err) {
      if (!isTrtcAbortError(err)) {
        console.error("[TRTC] stopLocalVideo failed", err)
      }
    }
  }, [isTrtcAbortError])

  const safeStopScreenShare = useCallback(async (trtc: any) => {
    if (!trtc) return
    const stopFn = trtc.stopScreenShare || trtc.stopScreenCapture || trtc.stopLocalScreen
    if (typeof stopFn !== "function") return
    try {
      await Promise.resolve(stopFn.call(trtc))
    } catch (err) {
      if (!isTrtcAbortError(err)) {
        console.error("[TRTC] stopScreenShare failed", err)
      }
    }
  }, [isTrtcAbortError])

  const safeExitTrtcRoom = useCallback(async (trtc: any) => {
    if (!trtc || typeof trtc.exitRoom !== "function") return
    try {
      await Promise.resolve(trtc.exitRoom())
    } catch (err) {
      if (!isTrtcAbortError(err)) {
        console.error("[TRTC] exitRoom failed", err)
      }
    }
  }, [isTrtcAbortError])

  const safeDestroyTrtc = useCallback(async (trtc: any) => {
    if (!trtc || typeof trtc.destroy !== "function") return
    try {
      await Promise.resolve(trtc.destroy())
    } catch (err) {
      if (!isTrtcAbortError(err)) {
        console.error("[TRTC] destroy failed", err)
      }
    }
  }, [isTrtcAbortError])

  const resolveAsrEngineModelType = useCallback((languageCode: string) => {
    const raw = typeof languageCode === "string" ? languageCode.trim() : ""
    const normalized = raw.replaceAll("_", "-")
    const primary = (normalized.split("-")[0] ?? normalized).toLowerCase()
    if (primary === "en") return "16k_en"
    if (primary === "ja") return "16k_ja"
    if (primary === "ko") return "16k_ko"
    return "16k_zh"
  }, [])


  const cleanupTrtc = useCallback(async () => {
    const trtc = trtcRef.current
    if (!trtc) return
    if (trtcCleanupInProgressRef.current) return
    trtcCleanupInProgressRef.current = true
    try {
      if (aiTranscriberListenerRef.current) {
        trtc.off(TRTC.EVENT.REALTIME_TRANSCRIBER_MESSAGE, aiTranscriberListenerRef.current)
        aiTranscriberListenerRef.current = null
      }
      if (aiTranscriberStateListenerRef.current) {
        trtc.off(TRTC.EVENT.REALTIME_TRANSCRIBER_STATE_CHANGED, aiTranscriberStateListenerRef.current)
        aiTranscriberStateListenerRef.current = null
      }
      if (aiTranscriberCustomListenerRef.current) {
        trtc.off(TRTC.EVENT.CUSTOM_MESSAGE, aiTranscriberCustomListenerRef.current)
        aiTranscriberCustomListenerRef.current = null
      }
      resetTrtcTranscriberState()
      await safeStopScreenShare(trtc)
      await safeStopLocalVideo(trtc)
      await safeStopLocalAudio(trtc)
      await safeExitTrtcRoom(trtc)
      await safeDestroyTrtc(trtc)
      trtcRef.current = null
      trtcUserIdRef.current = null
      trtcRoomIdRef.current = null
    } finally {
      trtcCleanupInProgressRef.current = false
    }
  }, [resetTrtcTranscriberState, safeDestroyTrtc, safeExitTrtcRoom, safeStopLocalAudio, safeStopLocalVideo, safeStopScreenShare])

  const startCallFallbackAsr = useCallback(async (options?: { sourceLanguageCode?: string }) => {
    if (tencentAsrRef.current) return
    let stream = callStreamRef.current
    if (!stream) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      callStreamRef.current = stream
    }
    const audioTrack = stream.getAudioTracks()[0]
    if (!audioTrack) {
      throw new Error("No audio track")
    }
    const sourceCode = typeof options?.sourceLanguageCode === "string" && options.sourceLanguageCode.trim()
      ? options.sourceLanguageCode
      : sourceLanguage.code
    const engineModelType = resolveAsrEngineModelType(sourceCode)
    tencentAsrRef.current = new TencentASR({
      audioTrack,
      engineModelType,
      OnRecognitionResultChange: (res: any) => {
        if (res?.result?.voice_text_str) {
          setLiveTranscript(sessionTranscriptRef.current + res.result.voice_text_str)
          setIsInterim(true)
        }
      },
      OnSentenceEnd: (res: any) => {
        if (res?.result?.voice_text_str) {
          const text = res.result.voice_text_str
          sessionTranscriptRef.current += text
          setConfirmedTranscript(sessionTranscriptRef.current)
          setLiveTranscript(sessionTranscriptRef.current)
          setIsInterim(false)
        }
      },
      OnError: (err: any) => {
        console.error("ASR Error", err)
        setIsCallStreaming(false)
        const now = Date.now()
        if (now - callAsrErrorToastAtRef.current > 5000) {
          callAsrErrorToastAtRef.current = now
          toast({
            title: "实时翻译连接异常",
            description: "语音通话正常，但字幕翻译暂时不可用",
            variant: "destructive",
          })
        }
      },
    })
    await tencentAsrRef.current.start()
    setIsCallStreaming(true)
  }, [resolveAsrEngineModelType, sourceLanguage.code, toast])

  const stopCallFallbackAsr = useCallback(() => {
    if (tencentAsrRef.current) {
      tencentAsrRef.current.stop()
      tencentAsrRef.current = null
    }
    setIsCallStreaming(false)
  }, [])

  const startTrtcRealtimeTranscriber = useCallback(async (options: {
    sourceLanguage: string
    targetLanguage?: string
    roomId: number
    userId: string
  }) => {
    const trtc = trtcRef.current
    if (!trtc) return false
    const normalize = (value: string) => {
      const raw = typeof value === "string" ? value.trim() : ""
      const normalized = raw.replaceAll("_", "-")
      return (normalized.split("-")[0] ?? normalized).toLowerCase()
    }
    const sourceLanguage = normalize(options.sourceLanguage)
    const targetLanguage = options.targetLanguage ? normalize(options.targetLanguage) : ""
    const robotId = `transcriber_${options.roomId}_robot_${options.userId}`
    aiTranscriberRobotIdRef.current = robotId
    aiTranscriberSourceLangRef.current = sourceLanguage
    aiTranscriberTargetLangRef.current = targetLanguage
    try {
      await trtc.startPlugin("RealtimeTranscriber", {
        sourceLanguage,
        translationLanguages: targetLanguage ? [targetLanguage] : undefined,
        userIdsToTranscribe: options.userId,
        transcriberRobotId: robotId,
      })
      trtcTranscriberActiveRef.current = true
      setTrtcTranscriberActive(true)
      setTrtcTranscriberTranslationActive(Boolean(targetLanguage))
      if (tencentAsrRef.current) {
        tencentAsrRef.current.stop()
        tencentAsrRef.current = null
      }
      stopFallbackLive()
      return true
    } catch {
      trtcTranscriberActiveRef.current = false
      setTrtcTranscriberActive(false)
      setTrtcTranscriberTranslationActive(false)
      return false
    }
  }, [stopFallbackLive])

  const resetCallState = useCallback(() => {
    setCallStatus("idle")
    callStatusRef.current = "idle"
    setCallPeer(null)
    callPeerRef.current = null
    setCallId(null)
    callIdRef.current = null
    setIncomingCallOpen(false)
    setIsCallStreaming(false)
    setCallDurationSec(0)
    setIsCallMuted(false)
    mutePipelineStateRef.current = null
    setCallLiveEnabled(true)
    setIsVideoEnabled(false)
    setIsScreenSharing(false)
    setRemoteVideoAvailable(false)
    setRemoteScreenAvailable(false)
    setRemoteVideoUserId(null)
    setRemoteScreenUserId(null)
    setRemoteVideoStreamType(null)
    setRemoteScreenStreamType(null)
    setLiveTranscript("")
    setLiveTranslation("")
    setLiveTranscriptLines([])
    setLiveTranslationLines([])
    setConfirmedTranscript("")
    liveCommittedTranscriptRef.current = ""
    liveCommittedTranslationRef.current = ""
    lastLiveCaptionSentRef.current = null
    liveCaptionSeqRef.current = 0
    sessionTranscriptRef.current = ""
    lastVoiceIdRef.current = ""
    lastReceivedTextRef.current = ""
    if (liveAutoBreakTimerRef.current) {
      clearTimeout(liveAutoBreakTimerRef.current)
      liveAutoBreakTimerRef.current = null
    }
    setRemoteLiveTranscript("")
    setRemoteConfirmedTranscript("")
    setRemoteLiveTranslation("")
    setRemoteLiveSourceLanguage("")
    setRemoteLiveUserName("")
    remoteTranslationSignalAtRef.current = 0
    remoteCommittedTranslationRef.current = ""
    remoteCommittedTranscriptRef.current = ""
    remoteCaptionSeqRef.current.clear()
    trtcCustomCaptionActiveRef.current = false
    stopFallbackLive()
    callActiveRef.current = false
    callQueueRef.current = []
    callProcessingRef.current = false
    if (callRecorderRef.current) {
      try {
        callRecorderRef.current.stop()
      } catch { }
      callRecorderRef.current = null
    }
    if (callStreamRef.current) {
      try {
        callStreamRef.current.getTracks().forEach((t) => t.stop())
      } catch { }
      callStreamRef.current = null
    }
    void cleanupTrtc()
    if (tencentAsrRef.current) {
      tencentAsrRef.current.stop()
      tencentAsrRef.current = null
    }
    if (remoteAudioRef.current) {
      try {
        remoteAudioRef.current.srcObject = null
      } catch { }
    }
  }, [cleanupTrtc, stopFallbackLive])

  const callPeerUser = useMemo(() => users.find((item) => item.id === callPeer?.id), [users, callPeer?.id])

  const globalVoiceActivityRef = useRef<number | undefined>(undefined)
  const vadIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const vadAudioContextRef = useRef<AudioContext | null>(null)
  const vadAnalyzerRef = useRef<AnalyserNode | null>(null)
  const vadSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)

  const shouldLiveListen = isRecording || (callStatus === "active" && callLiveEnabled && !isCallMuted)

  useEffect(() => {
    liveListenRef.current = shouldLiveListen
  }, [shouldLiveListen])

  // Initialize VAD when local mic stream is active
  useEffect(() => {
    if (callStatus !== "active" && !shouldLiveListen) {
      // Cleanup VAD if not needed
      if (vadIntervalRef.current) {
        clearInterval(vadIntervalRef.current)
        vadIntervalRef.current = null
      }
      if (vadAudioContextRef.current) {
        vadAudioContextRef.current.close().catch(() => { })
        vadAudioContextRef.current = null
      }
      globalVoiceActivityRef.current = undefined
      return
    }

    const initVad = async () => {
      try {
        const stream = callStreamRef.current || fallbackStreamRef.current
        if (!stream) return

        if (!vadAudioContextRef.current) {
          const AudioContext = window.AudioContext || (window as any).webkitAudioContext
          if (!AudioContext) return
          vadAudioContextRef.current = new AudioContext()
        }

        const ctx = vadAudioContextRef.current
        if (ctx.state === "suspended") await ctx.resume()

        if (!vadAnalyzerRef.current) {
          vadAnalyzerRef.current = ctx.createAnalyser()
          vadAnalyzerRef.current.fftSize = 512
        }

        // Don't recreate source if already connected to same stream?
        // Actually streams change, so safer to recreate source
        if (vadSourceRef.current) {
          vadSourceRef.current.disconnect()
        }

        // Create source from the stream (clone track to avoid interfering?)
        // MediaStreamSourceNode can be created from stream
        // Note: Chrome allows multiple sources from same stream
        const source = ctx.createMediaStreamSource(stream)
        source.connect(vadAnalyzerRef.current)
        vadSourceRef.current = source

        // Start polling volume
        if (vadIntervalRef.current) clearInterval(vadIntervalRef.current)

        const dataArray = new Uint8Array(vadAnalyzerRef.current.frequencyBinCount)

        vadIntervalRef.current = setInterval(() => {
          if (!vadAnalyzerRef.current) return
          vadAnalyzerRef.current.getByteTimeDomainData(dataArray)

          let sumSq = 0
          for (let i = 0; i < dataArray.length; i++) {
            const norm = (dataArray[i] - 128) / 128
            sumSq += norm * norm
          }
          const rms = Math.sqrt(sumSq / dataArray.length)

          // Threshold: 0.01 is roughly silence. 0.02 is quiet noise.
          // Adjusted for mobile: 0.01 for mobile, 0.04 for desktop
          const vadThreshold = isMobile ? 0.01 : 0.04
          if (rms > vadThreshold) {
            globalVoiceActivityRef.current = Date.now()
          }
        }, 100)

      } catch (err) {
        console.error("[v0] VAD init failed:", err)
      }
    }

    // Delay init to ensure stream is ready
    const timer = setTimeout(() => void initVad(), 1000)
    return () => clearTimeout(timer)
  }, [callStatus, shouldLiveListen, callStreamRef.current, fallbackStreamRef.current])

  const formatCallDuration = useCallback((value: number) => {
    const total = Math.max(0, Math.floor(value))
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const seconds = total % 60
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    return `${minutes}:${String(seconds).padStart(2, "0")}`
  }, [])

  const sourceLanguageRef = useRef<string>(sourceLanguage.code)
  useEffect(() => {
    sourceLanguageRef.current = sourceLanguage.code
  }, [sourceLanguage.code])

  const [asrMode, setAsrMode] = useState<"off" | "http" | "websocket">("off")
  const [isInterim, setIsInterim] = useState(false)
  const [confirmedTranscript, setConfirmedTranscript] = useState("")

  // Tencent Cloud Real-time ASR WebSocket Client (Managed by TencentASR class)
  const sessionTranscriptRef = useRef<string>("")
  const lastVoiceIdRef = useRef<string>("")
  const lastReceivedTextRef = useRef<string>("")
  const nativeAudioActiveRef = useRef(false)

  // Handle Android Native Audio Bridge
  useEffect(() => {
    if (typeof window === "undefined") return

    // Callback for native audio data (base64 PCM 16k 16bit mono)
    window.__medianPushNativeAudio = (base64: string, sampleRate: number, channels: number) => {
      try {
        const binaryString = window.atob(base64)
        const len = binaryString.length
        const bytes = new Uint8Array(len)
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryString.charCodeAt(i)
        }
        // Convert Uint8Array to Int16Array (PCM 16bit)
        const pcmData = new Int16Array(bytes.buffer)

        // Simple VAD (Voice Activity Detection) for Android Native Audio
        let sumSq = 0
        for (let i = 0; i < pcmData.length; i++) {
          const sample = pcmData[i] / 32768.0
          sumSq += sample * sample
        }
        const rms = Math.sqrt(sumSq / pcmData.length)
        if (rms < 0.01) return

        // Push to ASR logic
        if (tencentAsrRef.current) {
          tencentAsrRef.current.feedAudio(pcmData)
        }
      } catch (e) {
        console.error("Native audio decode error", e)
      }
    }

    // ... (status callback)
    window.mornspeakerOnSystemAudioStatus = (status: string) => {
      // ...
    }

    return () => { }
  }, [])

  const connectNativeAsr = useCallback(async (options?: { sourceLanguageCode?: string }) => {
    if (tencentAsrRef.current) return
    const sourceCode = typeof options?.sourceLanguageCode === "string" && options.sourceLanguageCode.trim()
      ? options.sourceLanguageCode
      : sourceLanguage.code
    const engineModelType = resolveAsrEngineModelType(sourceCode)

    tencentAsrRef.current = new TencentASR({
      // No audio track provided -> Manual feed mode
      engineModelType,
      OnRecognitionResultChange: (res: any) => {
        if (res?.result?.voice_text_str) {
          setLiveTranscript(sessionTranscriptRef.current + res.result.voice_text_str)
          setIsInterim(true)
        }
      },
      OnSentenceEnd: (res: any) => {
        if (res?.result?.voice_text_str) {
          const text = res.result.voice_text_str
          sessionTranscriptRef.current += text
          setConfirmedTranscript(sessionTranscriptRef.current)
          setLiveTranscript(sessionTranscriptRef.current)
          setIsInterim(false)
        }
      },
      OnError: (err: any) => console.error("Native ASR Error", err)
    })
    await tencentAsrRef.current.start()
  }, [resolveAsrEngineModelType, sourceLanguage.code])

  const startFallbackLive = useCallback(async () => {
    // If we are in a call, we rely on TRTC ASR, so don't start fallback.
    if (callStatusRef.current === "active") return

    if (fallbackRecorderRef.current || fallbackProcessorRef.current || tencentAsrRef.current) return
    try {
      // Android Native ASR Support
      if (typeof window !== "undefined" && window.AndroidTencentAsr && isMobile) {
        const sourceCode = sourceLanguage.code === "auto"
          ? (typeof navigator !== "undefined" && navigator.language
            ? navigator.language
            : locale === "zh"
              ? "zh-CN"
              : locale === "ja"
                ? "ja-JP"
                : "en-US")
          : sourceLanguage.code
        // Initialize JS WS client to receive audio from native
        await connectNativeAsr({ sourceLanguageCode: sourceCode })

        // Trigger native side to start capturing and pushing audio
        // We pass empty config or minimal config as the native side handles capture
        // The native side expects a JSON string config
        const config = JSON.stringify({
          sourceLanguage: sourceCode,
        })
        window.AndroidTencentAsr.startAsr(config)

        return
      }

      // Web Fallback (getUserMedia + TencentASR class)
      // If TRTC is active, skip fallback as TRTC manages audio/ASR
      if (trtcRef.current) return

      let stream: MediaStream | null = null
      let owned = false
      const sourceCode = sourceLanguage.code === "auto"
        ? (typeof navigator !== "undefined" && navigator.language
          ? navigator.language
          : locale === "zh"
            ? "zh-CN"
            : locale === "ja"
              ? "ja-JP"
              : "en-US")
        : sourceLanguage.code
      const engineModelType = resolveAsrEngineModelType(sourceCode)

      const constraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          sampleSize: 16,
        }
      }
      stream = await navigator.mediaDevices.getUserMedia(constraints)
      owned = true

      fallbackStreamRef.current = stream
      fallbackStreamOwnedRef.current = owned

      const audioTrack = stream.getAudioTracks()[0]
      if (audioTrack) {
        if (tencentAsrRef.current) {
          tencentAsrRef.current.stop()
        }
        tencentAsrRef.current = new TencentASR({
          audioTrack,
          engineModelType,
          OnRecognitionResultChange: (res: any) => {
            if (res?.result?.voice_text_str) {
              setLiveTranscript(mergeLiveDisplay(sessionTranscriptRef.current, res.result.voice_text_str))
              setIsInterim(true)
            }
          },
          OnSentenceEnd: (res: any) => {
            if (res?.result?.voice_text_str) {
              const text = res.result.voice_text_str
              sessionTranscriptRef.current += text
              setConfirmedTranscript(sessionTranscriptRef.current)
              setLiveTranscript(sessionTranscriptRef.current)
              setIsInterim(false)
            }
          },
          OnError: (err: any) => {
            console.error("ASR Error", err)
            // If WS fails, maybe try HTTP fallback?
            // For now just log.
          }
        })
        tencentAsrRef.current.start()
        setAsrMode("websocket")
      }

      setLiveSpeechSupported(true)
    } catch (e) {
      console.error("Failed to start fallback ASR", e)
      setLiveSpeechSupported(false)
      toast({
        title: t("toast.errorTitle"),
        description: t("voice.micPermissionAlert"),
        variant: "destructive",
      })
      stopFallbackLive()
    }
  }, [connectNativeAsr, isMobile, locale, resolveAsrEngineModelType, sourceLanguage.code, stopFallbackLive, t, toast])



  const sendSignal = useCallback(
    async (toUserId: string, payload: Record<string, unknown>) => {
      if (!roomId || !roomUserId) return
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "signal",
          roomId,
          userId: roomUserId,
          toUserId,
          payload,
        }),
      })
      if (!res.ok) throw new Error("发送信令失败")
    },
    [roomId, roomUserId],
  )

  const fetchUserSig = async (userId: string) => {
    const res = await fetch(`/api/trtc/user-sig?userId=${encodeURIComponent(userId)}`)
    if (!res.ok) throw new Error("Failed to fetch UserSig")
    const data = await res.json()
    const userSig = typeof data?.userSig === "string" ? data.userSig.trim() : ""
    const sdkAppId = typeof data?.sdkAppId === "number"
      ? data.sdkAppId
      : Number.parseInt(String(data?.sdkAppId ?? ""), 10)
    if (!userSig || !Number.isFinite(sdkAppId) || sdkAppId <= 0) {
      throw new Error("Invalid TRTC credentials")
    }
    return { userSig, sdkAppId }
  }

  const uiLocaleToLanguageCode = useCallback((): string => {
    if (typeof navigator !== "undefined" && typeof navigator.language === "string") {
      const lang = navigator.language.trim()
      const lower = lang.toLowerCase()
      if (lower.startsWith("zh")) return "zh-CN"
      if (lower.startsWith("ja")) return "ja-JP"
      if (lower.startsWith("ko")) return "ko-KR"
      return lang
    }
    if (locale === "zh") return "zh-CN"
    if (locale === "ja") return "ja-JP"
    return "en-US"
  }, [locale])

  const primaryOf = useCallback((code: string) => {
    const raw = typeof code === "string" ? code.trim() : ""
    const normalized = raw.replaceAll("_", "-")
    return (normalized.split("-")[0] ?? normalized).toLowerCase()
  }, [])

  const appendText = useCallback((base: string, addition: string) => {
    const left = typeof base === "string" ? base.trim() : ""
    const right = typeof addition === "string" ? addition.trim() : ""
    if (!right) return left
    return left ? `${left} ${right}`.trim() : right
  }, [])

  const appendFinalText = useCallback((base: string, addition: string) => {
    const left = typeof base === "string" ? base.trim() : ""
    const right = typeof addition === "string" ? addition.trim() : ""
    if (!right) return left
    if (!left) return right
    if (left.endsWith(right)) return left
    return `${left} ${right}`.trim()
  }, [])

  const trimCaptionPayloadText = useCallback((value: string) => {
    const text = typeof value === "string" ? value.trim() : ""
    if (!text) return ""
    if (text.length <= LIVE_CAPTION_MAX_TEXT_LENGTH) return text
    return text.slice(-LIVE_CAPTION_MAX_TEXT_LENGTH).trimStart()
  }, [])

  const normalizeFinalText = useCallback((value: string) => {
    const raw = typeof value === "string" ? value.trim() : ""
    const compact = raw.replace(/\s+/g, "")
    return compact.replace(/[。！？!?]+$/g, "").toLowerCase()
  }, [])

  const normalizeDisplayText = useCallback((value: string) => {
    const raw = typeof value === "string" ? value.trim() : ""
    if (!raw) return ""
    return raw.replace(/\s+/g, "").replace(/[。！？!?]+$/g, "").toLowerCase()
  }, [])

  const shouldAcceptFinalCaption = useCallback((key: string, text: string) => {
    const normalized = normalizeFinalText(text)
    if (!normalized) return false
    const now = Date.now()
    const previous = finalCaptionDedupRef.current.get(key)
    if (previous && previous.text === normalized && now - previous.at < 6000) {
      return false
    }
    finalCaptionDedupRef.current.set(key, { text: normalized, at: now })
    return true
  }, [normalizeFinalText])

  const mergeLiveDisplay = useCallback((base: string, current: string) => {
    const left = typeof base === "string" ? base.trim() : ""
    const right = typeof current === "string" ? current.trim() : ""
    if (!right) return left
    if (!left) return right
    const leftNorm = normalizeDisplayText(left)
    const rightNorm = normalizeDisplayText(right)
    if (!leftNorm) return right
    if (rightNorm.startsWith(leftNorm)) return right
    if (leftNorm.startsWith(rightNorm)) return left
    if (leftNorm.endsWith(rightNorm)) return left
    return appendText(left, right)
  }, [appendText, normalizeDisplayText])

  const bindTrtcRealtimeTranscriberEvents = useCallback((trtc: any) => {
    if (aiTranscriberListenerRef.current) {
      trtc.off(TRTC.EVENT.REALTIME_TRANSCRIBER_MESSAGE, aiTranscriberListenerRef.current)
      aiTranscriberListenerRef.current = null
    }
    if (aiTranscriberStateListenerRef.current) {
      trtc.off(TRTC.EVENT.REALTIME_TRANSCRIBER_STATE_CHANGED, aiTranscriberStateListenerRef.current)
      aiTranscriberStateListenerRef.current = null
    }
    if (aiTranscriberCustomListenerRef.current) {
      trtc.off(TRTC.EVENT.CUSTOM_MESSAGE, aiTranscriberCustomListenerRef.current)
      aiTranscriberCustomListenerRef.current = null
    }
    if (trtcErrorListenerRef.current) {
      trtc.off(TRTC.EVENT.ERROR, trtcErrorListenerRef.current)
      trtcErrorListenerRef.current = null
    }
    const handleMessage = (event: any) => {
      if (!event) return
      if (callStatusRef.current !== "active") return
      if (!liveListenRef.current) return
      const localId = trtcUserIdRef.current
      const speakerId = typeof event.speakerUserId === "string" ? event.speakerUserId : String(event.speakerUserId || "")
      if (localId && speakerId && speakerId !== localId) return
      const sourceText = typeof event.sourceText === "string" ? event.sourceText : ""
      const translationTexts = Array.isArray(event.translationTexts) ? event.translationTexts : []
      const targetLang = aiTranscriberTargetLangRef.current
      const targetPrimary = targetLang ? primaryOf(targetLang) : ""
      const matchedTranslation = translationTexts.find((item: any) => {
        if (!item) return false
        const lang = typeof item.language === "string" ? item.language : ""
        return lang && (lang === targetLang || primaryOf(lang) === targetPrimary)
      })
      const translationText = typeof matchedTranslation?.text === "string" ? matchedTranslation.text : ""

      if (event.isCompleted) {
        // Final result: append to committed transcript
        const baseTranscript = sessionTranscriptRef.current
        if (shouldAcceptFinalCaption("local:source", sourceText)) {
          const mergedTranscript = appendFinalText(baseTranscript, sourceText)
          sessionTranscriptRef.current = mergedTranscript
          setConfirmedTranscript(mergedTranscript)
          setLiveTranscript(mergedTranscript)
        }

        const baseTranslation = liveCommittedTranslationRef.current
        if (shouldAcceptFinalCaption("local:translation", translationText)) {
          const mergedTranslation = appendFinalText(baseTranslation, translationText)
          if (mergedTranslation) {
            liveCommittedTranslationRef.current = mergedTranslation
            aiTranscriberTranslationRef.current = mergedTranslation
            setLiveTranslation(mergedTranslation)
          } else if (aiTranscriberSourceLangRef.current && aiTranscriberSourceLangRef.current === aiTranscriberTargetLangRef.current) {
            const mergedTranscript = sessionTranscriptRef.current
            liveCommittedTranslationRef.current = mergedTranscript
            aiTranscriberTranslationRef.current = mergedTranscript
            setLiveTranslation(mergedTranscript)
          }
        }
        setIsInterim(false)
      } else {
        // Interim result: show current sentence without appending to committed
        // sourceText is the current recognition result for this sentence, not an increment
        const baseTranscript = sessionTranscriptRef.current
        const displayTranscript = mergeLiveDisplay(baseTranscript, sourceText)
        setLiveTranscript(displayTranscript)

        const baseTranslation = liveCommittedTranslationRef.current
        const displayTranslation = mergeLiveDisplay(baseTranslation, translationText)
        if (displayTranslation) {
          aiTranscriberTranslationRef.current = displayTranslation
          setLiveTranslation(displayTranslation)
        } else if (aiTranscriberSourceLangRef.current && aiTranscriberSourceLangRef.current === aiTranscriberTargetLangRef.current) {
          setLiveTranslation(displayTranscript)
        }
        setIsInterim(true)
      }
    }
    const handleState = (event: any) => {
      if (!event) return
      const robotId = aiTranscriberRobotIdRef.current
      if (robotId && event.transcriberRobotId && event.transcriberRobotId !== robotId) return
      if (event.state === "started") {
        setTrtcTranscriberActive(true)
        return
      }
      if (event.state === "stopped") {
        setTrtcTranscriberActive(false)
      }
      if (event.error) {
        setTrtcTranscriberActive(false)
        setTrtcTranscriberTranslationActive(false)
        toast({
          title: "TRTC 转录失败",
          description: event.errorMessage || String(event.error),
          variant: "destructive",
        })
      }
    }
    aiTranscriberListenerRef.current = handleMessage
    aiTranscriberStateListenerRef.current = handleState
    trtc.on(TRTC.EVENT.REALTIME_TRANSCRIBER_MESSAGE, handleMessage)
    trtc.on(TRTC.EVENT.REALTIME_TRANSCRIBER_STATE_CHANGED, handleState)
    const handleCustomMessage = (event: any) => {
      if (!event || callStatusRef.current !== "active") return
      let raw = ""
      if (typeof event.data === "string") {
        raw = event.data
      } else if (event.data instanceof ArrayBuffer) {
        raw = new TextDecoder().decode(event.data)
      } else if (ArrayBuffer.isView(event.data)) {
        raw = new TextDecoder().decode(event.data)
      }
      if (!raw) return
      let message: any = null
      try {
        message = JSON.parse(raw)
      } catch {
        return
      }
      if (!message || message.type !== 10000) return
      const payload = message.payload || {}
      const senderId = typeof message.sender === "string" ? message.sender : ""
      const text = typeof payload.text === "string" ? payload.text : ""
      const translationText = typeof payload.translation_text === "string" ? payload.translation_text : ""
      const translationLang = typeof payload.translation_language === "string" ? payload.translation_language : ""
      const end = Boolean(payload.end)
      if (!text && !translationText) return
      trtcCustomCaptionActiveRef.current = true
      const targetPrimary = primaryOf(targetLanguage.code)
      const translationPrimary = translationLang ? primaryOf(translationLang) : ""
      const canUseTranslation = !translationLang || translationPrimary === targetPrimary
      const isLocal = senderId && senderId === trtcUserIdRef.current
      if (isLocal) {
        if (text) {
          const baseTranscript = sessionTranscriptRef.current
          if (end) {
            // Final result: append to committed transcript
            if (shouldAcceptFinalCaption("local:source", text)) {
              const mergedTranscript = appendFinalText(baseTranscript, text)
              sessionTranscriptRef.current = mergedTranscript
              setConfirmedTranscript(mergedTranscript)
              setLiveTranscript(mergedTranscript)
              setIsInterim(false)
            }
          } else {
            // Interim result: show current sentence without appending
            const displayTranscript = mergeLiveDisplay(baseTranscript, text)
            setLiveTranscript(displayTranscript)
            setIsInterim(true)
          }
        }
        if (translationText && canUseTranslation) {
          const baseTranslation = liveCommittedTranslationRef.current
          if (end) {
            // Final result: append to committed translation
            if (shouldAcceptFinalCaption("local:translation", translationText)) {
              const mergedTranslation = appendFinalText(baseTranslation, translationText)
              liveCommittedTranslationRef.current = mergedTranslation
              aiTranscriberTranslationRef.current = mergedTranslation
              setLiveTranslation(mergedTranslation)
              setTrtcTranscriberTranslationActive(true)
            }
          } else {
            // Interim result: show current translation without appending
            const displayTranslation = mergeLiveDisplay(baseTranslation, translationText)
            aiTranscriberTranslationRef.current = displayTranslation
            setLiveTranslation(displayTranslation)
            setTrtcTranscriberTranslationActive(true)
          }
        }
        return
      }
      if (text) {
        const baseTranscript = remoteCommittedTranscriptRef.current
        if (end) {
          // Final result: append to committed transcript
          if (shouldAcceptFinalCaption("remote:source", text)) {
            const mergedTranscript = appendFinalText(baseTranscript, text)
            remoteCommittedTranscriptRef.current = mergedTranscript
            setRemoteConfirmedTranscript(mergedTranscript)
            setRemoteLiveTranscript(mergedTranscript)
          }
        } else {
          // Interim result: show current sentence without appending
          const displayTranscript = mergeLiveDisplay(baseTranscript, text)
          setRemoteLiveTranscript(displayTranscript)
        }
      }
      if (translationText && canUseTranslation) {
        const baseTranslation = remoteCommittedTranslationRef.current
        if (end) {
          // Final result: append to committed translation
          if (shouldAcceptFinalCaption("remote:translation", translationText)) {
            const mergedTranslation = appendFinalText(baseTranslation, translationText)
            remoteCommittedTranslationRef.current = mergedTranslation
            setRemoteLiveTranslation(mergedTranslation)
          }
        } else {
          // Interim result: show current translation without appending
          const displayTranslation = mergeLiveDisplay(baseTranslation, translationText)
          setRemoteLiveTranslation(displayTranslation)
        }
      }
      if (callPeerRef.current?.name) {
        setRemoteLiveUserName(callPeerRef.current.name)
      }
    }
    aiTranscriberCustomListenerRef.current = handleCustomMessage
    trtc.on(TRTC.EVENT.CUSTOM_MESSAGE, handleCustomMessage)
  }, [appendFinalText, appendText, mergeLiveDisplay, primaryOf, shouldAcceptFinalCaption, targetLanguage.code, toast])

  const enterTRTCRoom = useCallback(async (roomIdStr: string, userId: string) => {
    try {
      const trtcEnabled = await refreshTrtcSetting({ force: true })

      await cleanupTrtc()

      const trtcUserId = await getTrtcUserId(userId)

      const roomIdNumeric = roomIdStr.split("").reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 0)
      let safeRoomId = roomIdNumeric === 0 ? 1 : roomIdNumeric
      if (safeRoomId > 4294967294) safeRoomId = 4294967294

      const trtc = TRTC.create({
        assetsPath: "https://web.sdk.qcloud.com/trtc/webrtc/v5/assets/",
      })
      trtc.use(RealtimeTranscriber)
      trtcRef.current = trtc
      trtcUserIdRef.current = trtcUserId
      trtcRoomIdRef.current = safeRoomId
      bindTrtcRealtimeTranscriberEvents(trtc)
      if (trtcErrorListenerRef.current) {
        trtc.off(TRTC.EVENT.ERROR, trtcErrorListenerRef.current)
        trtcErrorListenerRef.current = null
      }
      const handleTrtcError = (event: any) => {
        if (!event) return
        const message = event.errorMessage || event.message || "TRTC 连接错误"
        const normalized = String(message || "").toLowerCase()
        const codeValue = typeof event.errorCode === "number"
          ? event.errorCode
          : Number.parseInt(String(event.errorCode ?? event.code ?? ""), 10)
        const isAbort =
          normalized.includes("api_call_aborted") ||
          normalized.includes("unsubscribe aborted") ||
          codeValue === 0x404d ||
          codeValue === 16461
        const isConnectionClosed = normalized.includes("connection closed") || normalized.includes("connection")
        if ((trtcCleanupInProgressRef.current || !trtcRef.current) && isAbort) return
        if (isAbort && isConnectionClosed) return
        console.error("[TRTC] Error:", event)
        toast({ title: "语音通话连接失败", description: message, variant: "destructive" })
        void cleanupTrtc()
        void startCallFallbackAsr()
      }
      trtcErrorListenerRef.current = handleTrtcError
      trtc.on(TRTC.EVENT.ERROR, handleTrtcError)

      const { userSig, sdkAppId } = await fetchUserSig(trtcUserId)

      trtc.on(TRTC.EVENT.REMOTE_AUDIO_AVAILABLE, (event: any) => {
        if (remoteAudioRef.current) {
          // TRTC v5 auto-plays if element is provided in some versions, or we play the stream.
          // But v5 usually: trtc.startRemoteAudio({ userId, streamType }) and it plays via internal mechanism or we attach?
          // Actually, v5: trtc.on(TRTC.EVENT.REMOTE_AUDIO_AVAILABLE, event => { trtc.startRemoteAudio({ userId: event.userId, streamType: event.streamType }) })
          // And it manages playback.
          // We can also use: trtc.startRemoteAudio({ userId: event.userId, streamType: event.streamType, element: remoteAudioRef.current })?
          // Let's assume standard behavior:
          (trtc as any).startRemoteAudio({ userId: event.userId, streamType: event.streamType })
        }
      })
      trtc.on(TRTC.EVENT.REMOTE_VIDEO_AVAILABLE, (event: any) => {
        const userId = String(event?.userId ?? "")
        if (!userId) return
        const streamType = event?.streamType ?? TRTC.TYPE.STREAM_TYPE_MAIN
        const available = typeof event?.isAvailable === "boolean"
          ? event.isAvailable
          : typeof event?.available === "boolean"
            ? event.available
            : typeof event?.isVideoAvailable === "boolean"
              ? event.isVideoAvailable
              : true
        if (streamType === TRTC.TYPE.STREAM_TYPE_SUB) {
          setRemoteScreenAvailable(available)
          setRemoteScreenUserId(available ? userId : null)
          setRemoteScreenStreamType(available ? streamType : null)
          if (!available && typeof trtc.stopRemoteVideo === "function") {
            void trtc.stopRemoteVideo({ userId, streamType })
          }
          return
        }
        setRemoteVideoAvailable(available)
        setRemoteVideoUserId(available ? userId : null)
        setRemoteVideoStreamType(available ? streamType : null)
        if (!available && typeof trtc.stopRemoteVideo === "function") {
          void trtc.stopRemoteVideo({ userId, streamType })
        }
      })
      trtc.on(TRTC.EVENT.REMOTE_VIDEO_UNAVAILABLE, (event: any) => {
        const userId = String(event?.userId ?? "")
        if (!userId) return
        const streamType = event?.streamType ?? TRTC.TYPE.STREAM_TYPE_MAIN
        if (streamType === TRTC.TYPE.STREAM_TYPE_SUB) {
          setRemoteScreenAvailable(false)
          setRemoteScreenUserId(null)
          setRemoteScreenStreamType(null)
          if (typeof trtc.stopRemoteVideo === "function") {
            void trtc.stopRemoteVideo({ userId, streamType })
          }
          return
        }
        setRemoteVideoAvailable(false)
        setRemoteVideoUserId(null)
        setRemoteVideoStreamType(null)
        if (typeof trtc.stopRemoteVideo === "function") {
          void trtc.stopRemoteVideo({ userId, streamType })
        }
      })
      trtc.on(TRTC.EVENT.SCREEN_SHARE_STOPPED, () => {
        setIsScreenSharing(false)
      })
      trtc.on(TRTC.EVENT.PUBLISH_STATE_CHANGED, (event: any) => {
        const mediaType = event?.mediaType
        const state = event?.state
        if (mediaType === "screen" && state === "stopped") {
          setIsScreenSharing(false)
        }
      })
      trtc.on(TRTC.EVENT.TRACK, (event: any) => {
        const userId = String(event?.userId ?? "")
        const streamType = event?.streamType ?? TRTC.TYPE.STREAM_TYPE_MAIN
        const track = event?.track
        if (!userId || !track || track.kind !== "video") return
        if (streamType === TRTC.TYPE.STREAM_TYPE_SUB) {
          setRemoteScreenAvailable(true)
          setRemoteScreenUserId(userId)
          setRemoteScreenStreamType(streamType)
          if (isMobile) {
            setRemoteVideoAvailable(true)
            setRemoteVideoUserId(userId)
            setRemoteVideoStreamType(streamType)
          }
          return
        }
        setRemoteVideoAvailable(true)
        setRemoteVideoUserId(userId)
        setRemoteVideoStreamType(streamType)
      })
      trtc.on(TRTC.EVENT.VIDEO_PLAY_STATE_CHANGED, (event: any) => {
        const userId = String(event?.userId ?? "")
        const streamType = event?.streamType ?? TRTC.TYPE.STREAM_TYPE_MAIN
        const state = event?.state
        if (!userId || !streamType || state !== "stopped") return
        if (streamType === TRTC.TYPE.STREAM_TYPE_SUB) {
          setRemoteScreenAvailable(false)
          setRemoteScreenUserId(null)
          setRemoteScreenStreamType(null)
          if (isMobile) {
            setRemoteVideoAvailable(false)
            setRemoteVideoUserId(null)
            setRemoteVideoStreamType(null)
          }
          return
        }
        setRemoteVideoAvailable(false)
        setRemoteVideoUserId(null)
        setRemoteVideoStreamType(null)
      })

      await trtc.enterRoom({
        roomId: safeRoomId,
        scene: TRTC.TYPE.SCENE_RTC,
        sdkAppId,
        userId: trtcUserId,
        userSig,
      })

      await trtc.startLocalAudio()

      // 设置最大通话时长限制：30分钟后自动断开
      const MAX_CALL_DURATION_MS = 30 * 60 * 1000 // 30分钟
      setTimeout(() => {
        if (trtcRef.current === trtc) {
          console.log("[TRTC] Maximum call duration reached (30min), disconnecting")
          void cleanupTrtc()
          toast({
            title: "通话已结束",
            description: "已达到最大通话时长限制（30分钟）",
            variant: "default"
          })
        }
      }, MAX_CALL_DURATION_MS)

      let startedTranscriber = false
      if (callLiveEnabled && trtcEnabled) {
        const sourceCode = sourceLanguage.code === "auto" ? uiLocaleToLanguageCode() : sourceLanguage.code
        startedTranscriber = await startTrtcRealtimeTranscriber({
          sourceLanguage: sourceCode,
          targetLanguage: targetLanguage.code,
          roomId: safeRoomId,
          userId: trtcUserId,
        })
      }
      if (callLiveEnabled && !startedTranscriber) {
        if (callLiveEnabled && !trtcEnabled) {
          toast({
            title: "通话已连接",
            description: "已切换为标准实时字幕翻译",
            variant: "default",
          })
        }
        try {
          await startCallFallbackAsr()
        } catch (asrError) {
          console.error("[CallLive] Failed to start fallback ASR", asrError)
          toast({
            title: "实时翻译启动失败",
            description: "通话已连接，但实时字幕暂不可用",
            variant: "destructive",
          })
        }
      }

      setIsCallStreaming(startedTranscriber || Boolean(tencentAsrRef.current))

    } catch (e: any) {
      console.error("Enter TRTC Room failed", e)
      toast({ title: "语音通话连接失败", description: e.message || String(e), variant: "destructive" })
      resetCallState()
    }
  }, [appendFinalText, bindTrtcRealtimeTranscriberEvents, callLiveEnabled, cleanupTrtc, isMobile, mergeLiveDisplay, refreshTrtcSetting, resetCallState, shouldAcceptFinalCaption, sourceLanguage.code, startCallFallbackAsr, startTrtcRealtimeTranscriber, targetLanguage.code, toast, uiLocaleToLanguageCode])

  const startOutgoingCall = useCallback(
    async (target: { id: string; name: string }) => {
      if (!target?.id) return
      if (callStatusRef.current !== "idle") {
        toast({ title: t("call.busySelfTitle"), description: t("call.busySelfDesc") })
        return
      }
      const newId = randomId()
      setCallStatus("outgoing")
      setCallPeer({ id: target.id, name: target.name })
      setCallId(newId)
      try {
        await sendSignal(target.id, {
          type: "call_invite",
          callId: newId,
          fromUserId: roomUserId,
          fromUserName: userName || t("call.unknownUser"),
          toUserId: target.id,
        } as CallSignalPayload)
        toast({ title: t("call.outgoingTitle"), description: t("call.outgoingDesc", { name: target.name }) })
      } catch (e) {
        resetCallState()
        toast({ title: t("call.failedTitle"), description: t("call.failedDesc"), variant: "destructive" })
      }
    },
    [randomId, resetCallState, roomUserId, sendSignal, t, toast, userName],
  )

  const handleAcceptCall = useCallback(async () => {
    const peer = callPeerRef.current
    const id = callIdRef.current
    if (!peer || !id) return
    try {
      await sendSignal(peer.id, {
        type: "call_accept",
        callId: id,
        fromUserId: roomUserId,
        fromUserName: userName || t("call.unknownUser"),
        toUserId: peer.id,
      } as CallSignalPayload)
      setIncomingCallOpen(false)
      setCallStatus("active")
      callActiveRef.current = true
      await enterTRTCRoom(id, roomUserId)
      toast({ title: t("call.acceptedTitle"), description: t("call.acceptedDesc", { name: peer.name }) })
    } catch (e) {
      console.error("Failed to accept call", e)
      toast({ title: t("call.failedTitle"), description: t("call.failedDesc"), variant: "destructive" })
      resetCallState()
    }
  }, [callIdRef, callPeerRef, enterTRTCRoom, roomUserId, sendSignal, t, toast, userName, resetCallState])

  const handleRejectCall = useCallback(async () => {
    const peer = callPeerRef.current
    const id = callIdRef.current
    if (!peer || !id) {
      resetCallState()
      return
    }
    try {
      await sendSignal(peer.id, {
        type: "call_reject",
        callId: id,
        fromUserId: roomUserId,
        fromUserName: userName || t("call.unknownUser"),
        toUserId: peer.id,
      } as CallSignalPayload)
      resetCallState()
      toast({ title: t("call.rejectedTitle"), description: t("call.rejectedDesc", { name: peer.name }) })
    } catch {
      resetCallState()
    }
  }, [resetCallState, roomUserId, sendSignal, t, toast, userName])

  const handleEndCall = useCallback(async () => {
    const peer = callPeerRef.current
    const id = callIdRef.current
    if (peer && id) {
      try {
        await sendSignal(peer.id, {
          type: "call_end",
          callId: id,
          fromUserId: roomUserId,
          fromUserName: userName || t("call.unknownUser"),
          toUserId: peer.id,
        } as CallSignalPayload)
      } catch { }
    }
    resetCallState()
    toast({ title: t("call.endedTitle"), description: t("call.endedDesc") })
  }, [resetCallState, roomUserId, sendSignal, t, toast, userName])

  const sendEmptyLiveCaption = useCallback(() => {
    if (callStatusRef.current !== "active") return
    const peer = callPeerRef.current
    const id = callIdRef.current
    if (!peer?.id || !id) return
    const seq = liveCaptionSeqRef.current + 1
    liveCaptionSeqRef.current = seq
    void sendSignal(peer.id, {
      type: "call_caption",
      callId: id,
      fromUserId: roomUserId,
      fromUserName: userName || t("call.unknownUser"),
      toUserId: peer.id,
      transcript: "",
      confirmedTranscript: "",
      translation: "",
      sourceLanguage: sourceLanguage.code,
      targetLanguage: targetLanguage.code,
      timestamp: Date.now(),
      seq,
    } as CallSignalPayload).catch(() => { })
  }, [roomUserId, sendSignal, sourceLanguage.code, t, targetLanguage.code, userName])

  const restartCallLivePipeline = useCallback(async (nextSourceCode: string, nextTargetCode: string) => {
    if (isCallMuted) {
      await stopTrtcRealtimeTranscriber()
      stopCallFallbackAsr()
      setIsCallStreaming(false)
      return
    }

    const resolvedSourceCode = nextSourceCode === "auto" ? uiLocaleToLanguageCode() : nextSourceCode
    const trtcEnabled = await refreshTrtcSetting({ force: true })
    const canUseTrtcTranscriber =
      trtcEnabled && Boolean(trtcUserIdRef.current && trtcRoomIdRef.current)

    setLiveTranscript("")
    setConfirmedTranscript("")
    setLiveTranslation("")
    setLiveTranscriptLines([])
    setLiveTranslationLines([])
    liveCommittedTranscriptRef.current = ""
    liveCommittedTranslationRef.current = ""
    sessionTranscriptRef.current = ""

    await stopTrtcRealtimeTranscriber()
    stopCallFallbackAsr()

    if (canUseTrtcTranscriber) {
      const currentRoomId = trtcRoomIdRef.current
      const currentUserId = trtcUserIdRef.current
      if (currentRoomId && currentUserId) {
        const started = await startTrtcRealtimeTranscriber({
          sourceLanguage: resolvedSourceCode,
          targetLanguage: nextTargetCode,
          roomId: currentRoomId,
          userId: currentUserId,
        })
        if (started) {
          setIsCallStreaming(true)
          return
        }
      }
    }

    await startCallFallbackAsr({ sourceLanguageCode: resolvedSourceCode })
    setIsCallStreaming(Boolean(tencentAsrRef.current))
  }, [isCallMuted, refreshTrtcSetting, startCallFallbackAsr, startTrtcRealtimeTranscriber, stopCallFallbackAsr, stopTrtcRealtimeTranscriber, uiLocaleToLanguageCode])

  const handleToggleCallLive = useCallback(async () => {
    const next = !callLiveEnabled
    setCallLiveEnabled(next)

    if (!next) {
      setLiveTranscript("")
      setConfirmedTranscript("")
      setLiveTranslation("")
      setLiveTranscriptLines([])
      setLiveTranslationLines([])
      liveCommittedTranscriptRef.current = ""
      liveCommittedTranslationRef.current = ""
      lastLiveCaptionSentRef.current = null
      if (liveAutoBreakTimerRef.current) {
        clearTimeout(liveAutoBreakTimerRef.current)
        liveAutoBreakTimerRef.current = null
      }
      sendEmptyLiveCaption()
      await stopTrtcRealtimeTranscriber()
      stopCallFallbackAsr()
      return
    }

    if (callStatusRef.current !== "active") return

    if (isCallMuted) {
      setIsCallStreaming(false)
      toast({
        title: "麦克风已静音",
        description: "解除静音后将自动恢复实时翻译",
      })
      return
    }

    try {
      await restartCallLivePipeline(sourceLanguage.code, targetLanguage.code)
    } catch (error) {
      console.error("[CallLive] Failed to enable realtime translation", error)
      toast({
        title: "实时翻译启动失败",
        description: "请检查麦克风权限或稍后重试",
        variant: "destructive",
      })
    }
  }, [callLiveEnabled, isCallMuted, restartCallLivePipeline, sendEmptyLiveCaption, sourceLanguage.code, stopCallFallbackAsr, stopTrtcRealtimeTranscriber, targetLanguage.code, toast])

  const handleToggleLocalVideo = useCallback(async () => {
    if (callStatusRef.current !== "active") return
    const trtc = trtcRef.current
    if (!trtc) return
    if (isVideoEnabled) {
      await safeStopLocalVideo(trtc)
      setIsVideoEnabled(false)
      return
    }
    if (!localVideoRef.current) return
    try {
      await trtc.startLocalVideo({ view: localVideoRef.current })
      setIsVideoEnabled(true)
    } catch (err) {
      setIsVideoEnabled(false)
      const message = err instanceof Error ? err.message : String(err ?? "")
      toast({ title: t("call.videoFailed"), description: message, variant: "destructive" })
    }
  }, [isVideoEnabled, safeStopLocalVideo, t, toast])

  const handleToggleScreenShare = useCallback(async () => {
    if (callStatusRef.current !== "active") return
    const trtc = trtcRef.current
    if (!trtc) return
    if (isScreenSharing) {
      await safeStopScreenShare(trtc)
      setIsScreenSharing(false)
      return
    }
    const startFn = trtc.startScreenShare || trtc.startScreenCapture || trtc.startLocalScreen
    if (typeof startFn !== "function") {
      toast({ title: t("call.screenShareFailed"), description: t("call.screenShareUnsupported"), variant: "destructive" })
      return
    }
    const screenView = isMobile ? localVideoRef.current : localScreenRef.current
    try {
      await startFn.call(trtc, { view: screenView ?? null })
      setIsScreenSharing(true)
    } catch (err) {
      setIsScreenSharing(false)
      const message = err instanceof Error ? err.message : String(err ?? "")
      toast({ title: t("call.screenShareFailed"), description: message, variant: "destructive" })
    }
  }, [isMobile, isScreenSharing, safeStopScreenShare, t, toast])

  useEffect(() => {
    const trtc = trtcRef.current
    if (!trtc || typeof trtc.startRemoteVideo !== "function") return
    if (isMobile && remoteScreenAvailable) {
      remoteVideoStartedRef.current = null
      if (remoteVideoUserId && typeof trtc.stopRemoteVideo === "function") {
        void trtc.stopRemoteVideo({ userId: remoteVideoUserId, streamType: TRTC.TYPE.STREAM_TYPE_MAIN })
      }
      return
    }
    if (!remoteVideoAvailable || !remoteVideoUserId || !remoteVideoRef.current) {
      remoteVideoStartedRef.current = null
      return
    }
    const streamType = remoteVideoStreamType ?? TRTC.TYPE.STREAM_TYPE_MAIN
    const key = `${remoteVideoUserId}:${String(streamType)}`
    if (remoteVideoStartedRef.current === key) return
    remoteVideoStartedRef.current = key
    void trtc.startRemoteVideo({ userId: remoteVideoUserId, streamType, view: remoteVideoRef.current })
  }, [isMobile, remoteScreenAvailable, remoteVideoAvailable, remoteVideoStreamType, remoteVideoUserId])

  useEffect(() => {
    const trtc = trtcRef.current
    if (!trtc || typeof trtc.startRemoteVideo !== "function") return
    const screenView = isMobile ? remoteVideoRef.current : remoteScreenRef.current
    if (!remoteScreenAvailable || !remoteScreenUserId || !screenView) {
      remoteScreenStartedRef.current = null
      return
    }
    const streamType = remoteScreenStreamType ?? TRTC.TYPE.STREAM_TYPE_SUB
    const key = `${remoteScreenUserId}:${String(streamType)}`
    if (remoteScreenStartedRef.current === key) return
    remoteScreenStartedRef.current = key
    void trtc.startRemoteVideo({ userId: remoteScreenUserId, streamType, view: screenView })
  }, [isMobile, remoteScreenAvailable, remoteScreenStreamType, remoteScreenUserId])

  const resolveLanguageCode = useCallback((value: string): string => {
    const byCode = SUPPORTED_LANGUAGES.find((l) => l.code === value)
    if (byCode) return byCode.code
    const byName = SUPPORTED_LANGUAGES.find((l) => l.name === value)
    if (byName) return byName.code
    return value
  }, [])

  const splitIntoSentences = useCallback((text: string) => {
    const input = typeof text === "string" ? text : ""
    const normalized = input.replace(/\s+/g, " ").trim()
    if (!normalized) return [] as string[]
    const matches = normalized.match(/[^。！？.!?]+[。！？.!?]+|[^。！？.!?]+$/g)
    return (matches ?? []).map((s) => s.trim()).filter(Boolean)
  }, [])

  const getDeltaText = useCallback((full: string, committed: string) => {
    const base = typeof full === "string" ? full : ""
    const committedText = typeof committed === "string" ? committed : ""
    if (committedText && base.startsWith(committedText)) {
      return base.slice(committedText.length).trimStart()
    }
    return base.trim()
  }, [])


  const commitLiveCaption = useCallback(
    (fullTranscript: string, fullTranslation: string) => {
      const deltaTranscript = getDeltaText(fullTranscript, liveCommittedTranscriptRef.current)
      const deltaTranslation = typeof fullTranslation === "string" ? fullTranslation.trim() : ""
      if (!deltaTranscript && !deltaTranslation) return

      const transcriptLines = splitIntoSentences(deltaTranscript)
      const translationLines = splitIntoSentences(deltaTranslation)

      setLiveTranscriptLines((prev) => {
        const next = [...prev, ...transcriptLines]
        return next.slice(-20)
      })
      setLiveTranslationLines((prev) => {
        const next = [...prev, ...translationLines]
        return next.slice(-20)
      })

      liveCommittedTranscriptRef.current = fullTranscript.trim()
      if (deltaTranslation) {
        const prev = liveCommittedTranslationRef.current
        liveCommittedTranslationRef.current = prev ? `${prev} ${deltaTranslation}`.trim() : deltaTranslation
      }
    },
    [getDeltaText, splitIntoSentences],
  )

  // Moved definition to top

  useEffect(() => {
    if (callStatus !== "active") return
    const startAt = Date.now()
    setCallDurationSec(0)
    const timer = setInterval(() => {
      setCallDurationSec(Math.floor((Date.now() - startAt) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [callStatus])

  useEffect(() => {
    if (callStatus !== "active") return

    let cancelled = false

    const syncLocalAudioState = async () => {
      const trtc = trtcRef.current
      if (trtc) {
        try {
          const muteFn = typeof trtc.muteLocalAudio === "function" ? trtc.muteLocalAudio.bind(trtc) : null
          const unmuteFn = typeof trtc.unmuteLocalAudio === "function" ? trtc.unmuteLocalAudio.bind(trtc) : null

          if (isCallMuted) {
            await safeStopLocalAudio(trtc)
            if (muteFn) {
              await Promise.resolve(muteFn())
            } else if (typeof trtc.updateLocalAudio === "function") {
              await Promise.resolve(trtc.updateLocalAudio({ mute: true }))
            }
          } else {
            if (typeof trtc.startLocalAudio === "function") {
              await Promise.resolve(trtc.startLocalAudio())
            }
            if (unmuteFn) {
              await Promise.resolve(unmuteFn())
            } else if (typeof trtc.updateLocalAudio === "function") {
              await Promise.resolve(trtc.updateLocalAudio({ mute: false }))
            }
          }

          if (typeof trtc.getAudioTrack === "function") {
            const track = trtc.getAudioTrack()
            if (track) {
              track.enabled = !isCallMuted
            }
          }
        } catch (e) {
          if (!cancelled) {
            console.error("[v0] Failed to sync TRTC local audio state:", e)
          }
        }
      }

      const stream = callStreamRef.current
      if (stream) {
        for (const track of stream.getAudioTracks()) {
          track.enabled = !isCallMuted
        }
      }
    }

    void syncLocalAudioState()

    return () => {
      cancelled = true
    }
  }, [callStatus, isCallMuted, safeStopLocalAudio])

  useEffect(() => {
    if (callStatus !== "active") {
      mutePipelineStateRef.current = null
      return
    }

    if (mutePipelineStateRef.current === null) {
      mutePipelineStateRef.current = isCallMuted
      return
    }

    if (mutePipelineStateRef.current === isCallMuted) return
    mutePipelineStateRef.current = isCallMuted

    let cancelled = false

    const syncLivePipelineWithMute = async () => {
      if (isCallMuted) {
        await stopTrtcRealtimeTranscriber()
        stopCallFallbackAsr()
        if (!cancelled) {
          setLiveTranscript("")
          setConfirmedTranscript("")
          setLiveTranslation("")
          setLiveTranscriptLines([])
          setLiveTranslationLines([])
          sessionTranscriptRef.current = ""
          liveCommittedTranscriptRef.current = ""
          liveCommittedTranslationRef.current = ""
          setIsInterim(false)
          setIsCallStreaming(false)
        }
        sendEmptyLiveCaption()
        return
      }

      if (!callLiveEnabled) return

      try {
        await restartCallLivePipeline(sourceLanguage.code, targetLanguage.code)
      } catch (error) {
        console.error("[CallLive] Failed to resume pipeline after unmute", error)
        if (!cancelled) {
          toast({
            title: "实时翻译恢复失败",
            description: "请稍后重试或重新开启实时翻译",
            variant: "destructive",
          })
        }
      }
    }

    void syncLivePipelineWithMute()

    return () => {
      cancelled = true
    }
  }, [callLiveEnabled, callStatus, isCallMuted, restartCallLivePipeline, sendEmptyLiveCaption, sourceLanguage.code, stopCallFallbackAsr, stopTrtcRealtimeTranscriber, targetLanguage.code, toast])

  useEffect(() => {
    if (typeof window === "undefined") return
    if (!isInRoom) return

    if (!shouldLiveListen) {
      if (speechRecognitionRef.current) {
        try {
          speechRecognitionRef.current.onresult = null
          speechRecognitionRef.current.onerror = null
          speechRecognitionRef.current.onend = null
          speechRecognitionRef.current.stop()
        } catch { }
        speechRecognitionRef.current = null
      }
      stopFallbackLive()
      return
    }

    // Priority: Tencent Cloud Streaming ASR > Browser Native ASR
    // Since the user explicitly configured Tencent Cloud ASR, we prioritize the WebSocket implementation (startFallbackLive)
    // over the browser's native SpeechRecognition.
    // This ensures we use the high-quality, continuous streaming recognition from Tencent.

    // Check if we should use native SpeechRecognition (only if NOT using Tencent)
    // For now, we force fallback (Tencent/HTTP) to ensure Tencent ASR is used if available.
    // If you want to use browser native ASR when Tencent is not configured, we would need a flag.
    // Given the user's request, we skip SpeechRecognition.

    /*
    const w = window as unknown as {
      SpeechRecognition?: SpeechRecognitionConstructor
      webkitSpeechRecognition?: SpeechRecognitionConstructor
      mozSpeechRecognition?: SpeechRecognitionConstructor
    }
    const SpeechRecognition = w.SpeechRecognition ?? w.webkitSpeechRecognition ?? w.mozSpeechRecognition
    if (!SpeechRecognition) {
      void startFallbackLive()
      return
    }
    setLiveSpeechSupported(true)
    stopFallbackLive()

    const recognition = new SpeechRecognition()
    // ... (rest of SpeechRecognition setup)
    return () => { ... }
    */

    // Force use of our custom streaming implementation (Tencent ASR)
    void startFallbackLive()
    setLiveSpeechSupported(true) // We support it via fallback

    return () => {
      stopFallbackLive()
    }

  }, [isInRoom, shouldLiveListen, sourceLanguage.code, startFallbackLive, stopFallbackLive, uiLocaleToLanguageCode])

  useEffect(() => {
    if (!isInRoom) return
    if (trtcTranscriberTranslationActive) return
    const detected = detectLanguageFromText(liveTranscript)
    // Prefer selected source language; only fallback to text detection in auto mode.
    const sourceCode = sourceLanguage.code === "auto" ? detected : sourceLanguage.code

    const targetCode = targetLanguage.code
    const sourcePrimary = primaryOf(sourceCode)
    const targetPrimary = primaryOf(targetCode)
    if (liveTranslateTimerRef.current) {
      clearTimeout(liveTranslateTimerRef.current)
      liveTranslateTimerRef.current = null
    }

    const fullTranscript = typeof liveTranscript === "string" ? liveTranscript.trim() : ""

    if (!fullTranscript) {
      setLiveTranslation("")
      return
    }

    // If source and target languages are effectively the same (e.g. both English),
    // and the detected language is ALSO the same, we skip translation and show original text.
    // BUT if the detected language is different (e.g. speaking Chinese while set to English),
    // we MUST translate, even if the user manually selected English as source.
    if (sourcePrimary === targetPrimary && primaryOf(detected) === sourcePrimary) {
      setLiveTranslation(fullTranscript)
      return
    }

    liveTranslateTimerRef.current = setTimeout(() => {
      if (liveTranslateAbortRef.current) liveTranslateAbortRef.current.abort()
      const controller = new AbortController()
      liveTranslateAbortRef.current = controller

      void translateText(fullTranscript, sourceCode, targetCode, controller.signal)
        .then((translated) => {
          if (!controller.signal.aborted) setLiveTranslation(translated)
        })
        .catch(() => { })
        .finally(() => {
          if (liveTranslateAbortRef.current === controller) liveTranslateAbortRef.current = null
        })
    }, 800)

    return () => {
      if (liveTranslateTimerRef.current) {
        clearTimeout(liveTranslateTimerRef.current)
        liveTranslateTimerRef.current = null
      }
      if (liveTranslateAbortRef.current) {
        liveTranslateAbortRef.current.abort()
        liveTranslateAbortRef.current = null
      }
    }
  }, [isInRoom, liveTranscript, primaryOf, sourceLanguage.code, targetLanguage.code, trtcTranscriberTranslationActive])

  useEffect(() => {
    if (!shouldLiveListen) return
    if (!liveTranscript.trim() && !liveTranslation.trim()) return
    if (liveAutoBreakTimerRef.current) {
      clearTimeout(liveAutoBreakTimerRef.current)
      liveAutoBreakTimerRef.current = null
    }
    liveAutoBreakTimerRef.current = setTimeout(() => {
      commitLiveCaption(liveTranscript, liveTranslation)
    }, 2500)
    return () => {
      if (liveAutoBreakTimerRef.current) {
        clearTimeout(liveAutoBreakTimerRef.current)
        liveAutoBreakTimerRef.current = null
      }
    }
  }, [commitLiveCaption, liveTranscript, liveTranslation, shouldLiveListen])

  const normalizeLiveDisplay = (text: string, languageHint: string) => {
    const raw = typeof text === "string" ? text : ""
    const trimmed = raw.replace(/\s+/g, " ").trim()
    if (!trimmed) return ""
    const sample = trimmed
    const primary = primaryOf(languageHint)
    const isCjk = ["zh", "ja", "ko"].includes(primary ?? "") || /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(sample)
    if (isCjk) {
      return trimmed
        .replace(/([\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af])\s+([\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af])/g, "$1$2")
        .replace(/\s*([。！？!?，、；：])\s*/g, "$1")
        .trim()
    }
    return trimmed.replace(/\s+([,.!?;:])/g, "$1")
  }

  const formattedLiveTranscript = (() => {
    return normalizeLiveDisplay(liveTranscript, sourceLanguage.code)
  })()

  const formattedLiveTranslation = (() => {
    return normalizeLiveDisplay(liveTranslation, targetLanguage.code)
  })()

  const formattedConfirmedTranscript = (() => {
    return normalizeLiveDisplay(confirmedTranscript, sourceLanguage.code)
  })()

  useEffect(() => {
    if (callStatus !== "active") return
    const transcript = remoteLiveTranscript.trim()
    if (!transcript) {
      setRemoteLiveTranslation("")
      if (remoteTranslateTimerRef.current) {
        clearTimeout(remoteTranslateTimerRef.current)
        remoteTranslateTimerRef.current = null
      }
      if (remoteTranslateAbortRef.current) {
        remoteTranslateAbortRef.current.abort()
        remoteTranslateAbortRef.current = null
      }
      return
    }
    const detectedSource = detectLanguageFromText(transcript)
    const rawSource = remoteLiveSourceLanguage.trim()
    const normalizedSource = rawSource.toLowerCase()
    // Prefer source language from peer signal; only fallback to detection when source is missing/auto.
    const sourceCode =
      !rawSource || normalizedSource === "auto" || normalizedSource === "自动识别"
        ? detectedSource
        : rawSource
    const targetCode = targetLanguage.code
    const sourcePrimary = primaryOf(sourceCode)
    const detectedPrimary = primaryOf(detectedSource)
    const targetPrimary = primaryOf(targetCode)
    const currentRemoteTranslation = remoteLiveTranslation.trim()

    if (currentRemoteTranslation && Date.now() - remoteTranslationSignalAtRef.current < 1500) {
      const translationPrimary = primaryOf(detectLanguageFromText(currentRemoteTranslation))
      if (translationPrimary && translationPrimary === targetPrimary) {
        return
      }
    }

    remoteTranslateLatestRef.current = transcript
    remoteTranslateSourceRef.current = sourceCode
    remoteTranslateTargetRef.current = targetCode

    if ((!rawSource || normalizedSource === "auto" || normalizedSource === "自动识别") && detectedPrimary && sourcePrimary && detectedPrimary !== sourcePrimary) {
      setRemoteLiveSourceLanguage(detectedSource)
    }

    if (sourcePrimary === targetPrimary && (!detectedPrimary || detectedPrimary === sourcePrimary)) {
      setRemoteLiveTranslation(transcript)
      return
    }

    // Force local translation if remote translation seems incorrect (e.g. language mismatch)
    // This handles the case where sender sent a translation but it's in the wrong language (e.g. Sender Target=ZH, Receiver Target=EN)
    const currentRemoteTrans = remoteLiveTranslation.trim()
    if (currentRemoteTrans) {
      const currentTransLang = detectLanguageFromText(currentRemoteTrans)
      const currentTransPrimary = primaryOf(currentTransLang)
      // If we have a translation, but it's not in our target language, and detected source IS different from target
      // Then we must re-translate.
      if (currentTransPrimary !== targetPrimary && detectedPrimary !== targetPrimary) {
        // Fall through to translation
      } else {
        // Trust the remote translation if language matches
        // But wait, what if remote translation hasn't updated yet? 
        // The effect dependency includes remoteLiveTranscript.
      }
    }

    // Force update remote translation if we have a direct translation from the sender
    // This happens when the sender (desktop) has already translated the text and sent it via call_caption
    // We should trust the sender's translation if available, as they have the original audio context
    // However, the current signal handling logic might be overwriting this with local re-translation
    // Let's check how 'transcript' is populated. It comes from 'remoteLiveTranscript' state.
    // The 'call_caption' handler updates 'remoteLiveTranscript' with the sender's transcript.
    // It also updates 'remoteLiveTranslation' with the sender's translation directly.
    // BUT this effect runs whenever 'remoteLiveTranscript' changes, and triggers a LOCAL translation
    // which might overwrite the sender's translation with an empty or pending state.

    // Fix: If the remote transcript hasn't changed significantly, or if we just received a caption signal,
    // we should debouce or skip local re-translation to avoid flickering/interruption.
    // For now, let's just ensure we don't clear the translation unnecessarily.
    // IMPORTANT: If we already have a translation from the peer (which is updated via signal), 
    // we should prefer it. But how do we know if 'remoteLiveTranslation' was set by signal or by this effect?
    // We can check if 'remoteLiveTranslation' is already consistent with 'transcript' via some heuristic,
    // but simpler is to just let this effect run but with a check: 
    // If the current 'remoteLiveTranslation' is NOT empty and seems to match the transcript length roughly, maybe delay overwriting?

    // Actually, the issue is likely that when 'remoteLiveTranscript' updates via signal, 
    // 'remoteLiveTranslation' also updates via signal IMMEDIATELY.
    // THEN this effect runs because 'remoteLiveTranscript' changed.
    // This effect then calls 'translateText', which is async. 
    // While it waits, it might NOT clear the state, but if it does, or if the translation result comes back differently/later, it overwrites.

    // If the signal provides translation, we should arguably SKIP this local translation entirely for that specific update.
    // But we don't know if the signal provided translation here easily without extra state.
    // HOWEVER, we can observe that 'call_caption' signals are the ONLY source of 'remoteLiveTranscript' updates in this MVP.
    // And 'call_caption' ALWAYS includes 'translation' field (even if empty).
    // So if the peer sent a translation, we should use it.
    // If the peer sent empty translation (e.g. same language), we might need to translate locally? 
    // No, if peer is same language, they send text as translation.

    // So: why do we translate locally at all? 
    // Answer: We translate locally only if the peer DID NOT send a translation OR if we want to support receiver-side language settings overriding sender side.
    // But currently the system design seems to rely on SENDER doing the translation (based on sender's target setting? No, sender sends THEIR target setting).
    // Wait, 'call_caption' payload has 'targetLanguage'.
    // If receiver has different target language, receiver MUST re-translate.
    // If receiver has SAME target language as sender, receiver SHOULD use sender's translation.

    const receiverTarget = targetLanguage.code
    // We don't have sender's target language readily available in this effect scope easily unless we store it.
    // But we can check if we should trust the current state.

    // Let's optimize: only translate if the current remoteLiveTranslation is empty OR if enough time passed?
    // No, that's flaky.

    // Better fix: rely on the fact that `setRemoteLiveTranslation` in the signal handler happens BEFORE this effect.
    // If this effect runs, it schedules a translation.
    // If we want to prevent overwriting the valid translation from signal, we should check if we really need to translate.
    // But we don't know if the signal translation is valid for OUR target language.

    // Let's assume for now we ALWAYS translate locally to ensure it matches RECEIVER's target language preference.
    // The issue described by user is "interruption" or "not showing".
    // This suggests a race condition or UI hiding logic.
    // The user says "displayed these info then stopped showing".
    // This implies it showed PARTIAL results then disappeared? Or showed previous sentence then stopped?
    // "Stopped showing" could mean the `formattedRemote` logic filters it out?
    // Or `remoteLiveTranslation` becomes empty?

    // In lines 954-956: if (!transcript) setRemoteLiveTranslation("")
    // This clears translation if transcript is empty. Correct.

    // In lines 987+: We start a timeout to translate.
    // If we receive a stream of characters: "H", "He", "Hel", "Hell", "Hello".
    // Each update triggers this effect.
    // "H" -> schedule translate 150ms.
    // "He" -> clear "H" timer, schedule "He" 150ms.
    // ...
    // "Hello" -> clear "Hell" timer, schedule "Hello" 150ms.
    // If signal comes every 100ms, the timer never fires! 
    // So we NEVER translate locally while typing/speaking continuously!
    // AND if the signal does NOT contain a translation (or contains partial), we see nothing.
    // BUT the signal from sender SHOULD contain translation if sender is translating.

    // If sender is desktop, it translates locally and sends `translation` field.
    // The signal handler (line 1100+) does:
    // setRemoteLiveTranscript(payload.transcript)
    // setRemoteLiveTranslation(payload.translation)

    // So we get "Hello" + "你好" from signal.
    // UI updates.
    // Effect runs for "Hello".
    // Clears timer. Schedules local translate.
    // If new signal comes "Hello world" + "你好世界" before 150ms:
    // UI updates to "Hello world" + "你好世界".
    // Effect runs. Clears timer. Schedules new translate.
    // This seems fine? We just keep displaying the sender's translation.

    // Wait, why did the user say "display stopped"?
    // Maybe `remoteLiveTranslation` is getting CLEARED somewhere?
    // Only line 955 clears it.

    // Or maybe the UI logic for `formattedRemote...` is hiding it?
    // Let's look at `formattedRemoteLiveTranscript` and `formattedRemoteLiveTranslation`.
    // We need to see that code.

    const scheduleTranslate = () => {
      if (remoteTranslateTimerRef.current) return
      remoteTranslateTimerRef.current = setTimeout(() => {
        const latestTranscript = remoteTranslateLatestRef.current.trim()
        if (!latestTranscript) {
          remoteTranslateTimerRef.current = null
          return
        }
        if (remoteTranslateAbortRef.current) remoteTranslateAbortRef.current.abort()
        const controller = new AbortController()
        remoteTranslateAbortRef.current = controller
        const source = remoteTranslateSourceRef.current
        const target = remoteTranslateTargetRef.current
        void translateText(latestTranscript, source, target, controller.signal)
          .then((translated) => {
            if (!controller.signal.aborted) setRemoteLiveTranslation(translated)
          })
          .catch(() => { })
          .finally(() => {
            if (remoteTranslateAbortRef.current === controller) remoteTranslateAbortRef.current = null
            remoteTranslateTimerRef.current = null
            if (remoteTranslateLatestRef.current.trim() !== latestTranscript) {
              scheduleTranslate()
            }
          })
      }, 150)
    }
    scheduleTranslate()

    return () => {
      if (remoteTranslateAbortRef.current) {
        remoteTranslateAbortRef.current.abort()
        remoteTranslateAbortRef.current = null
      }
    }
  }, [callStatus, primaryOf, remoteLiveSourceLanguage, remoteLiveTranscript, remoteLiveTranslation, targetLanguage.code])

  useEffect(() => {
    return () => {
      if (remoteTranslateTimerRef.current) {
        clearTimeout(remoteTranslateTimerRef.current)
        remoteTranslateTimerRef.current = null
      }
      if (remoteTranslateAbortRef.current) {
        remoteTranslateAbortRef.current.abort()
        remoteTranslateAbortRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (callStatus !== "active") return
    if (!settings.autoPlayTranslations) return
    const full = remoteLiveTranslation.trim()
    if (!full) {
      remoteSpokenTranslationRef.current = ""
      remoteLastSpokenTextRef.current = ""
      if (ttsDeferredTimerRef.current) {
        clearTimeout(ttsDeferredTimerRef.current)
        ttsDeferredTimerRef.current = null
      }
      ttsDeferredTextRef.current = ""
      ttsDeferredFullRef.current = ""
      return
    }
    const lastFull = remoteSpokenTranslationRef.current
    const delta = lastFull && full.startsWith(lastFull)
      ? full.slice(lastFull.length)
      : splitIntoSentences(full).slice(-1)[0] ?? ""
    const text = delta.trim()
    if (!text) return
    if (text === remoteLastSpokenTextRef.current) return
    if (ttsSupported && !ttsUnlockedRef.current) {
      pendingTtsRef.current = { text, lang: targetLanguage.code }
      return
    }
    const shouldSpeak = /[。！？.!?]$/.test(text) || text.length >= 20
    if (!shouldSpeak) {
      if (ttsDeferredTimerRef.current) {
        clearTimeout(ttsDeferredTimerRef.current)
      }
      ttsDeferredTextRef.current = text
      ttsDeferredFullRef.current = full
      ttsDeferredTimerRef.current = setTimeout(() => {
        if (ttsDeferredTextRef.current !== text) return
        if (remoteLastSpokenTextRef.current === text) return
        if (ttsSupported && !ttsUnlockedRef.current) {
          pendingTtsRef.current = { text, lang: targetLanguage.code }
          return
        }
        speak(text, targetLanguage.code)
        remoteSpokenTranslationRef.current = ttsDeferredFullRef.current
        remoteLastSpokenTextRef.current = text
      }, 1000)
      return
    }
    if (ttsDeferredTimerRef.current) {
      clearTimeout(ttsDeferredTimerRef.current)
      ttsDeferredTimerRef.current = null
    }
    speak(text, targetLanguage.code)
    remoteSpokenTranslationRef.current = full
    remoteLastSpokenTextRef.current = text
  }, [
    callStatus,
    isMobile,
    remoteLiveTranslation,
    settings.autoPlayTranslations,
    speak,
    splitIntoSentences,
    targetLanguage.code,
    toast,
    ttsSupported,
  ])

  useEffect(() => {
    if (!ttsSupported) return
    const tryUnlock = () => {
      if (ttsUnlockedRef.current || ttsUnlockingRef.current) return
      ttsUnlockingRef.current = true
      void unlockTts().then((ok) => {
        ttsUnlockingRef.current = false
        if (!ok) return
        ttsUnlockedRef.current = true
        const pending = pendingTtsRef.current
        if (pending) {
          pendingTtsRef.current = null
          speak(pending.text, pending.lang)
        }
      })
    }
    const events = ["pointerdown", "touchstart", "click", "keydown"] as const
    events.forEach((e) => window.addEventListener(e, tryUnlock, { passive: true }))
    return () => events.forEach((e) => window.removeEventListener(e, tryUnlock))
  }, [speak, ttsSupported, unlockTts])

  useEffect(() => {
    if (!settings.autoPlayTranslations) return
    if (ttsSupported) return
    if (ttsUnsupportedNotifiedRef.current) return
    ttsUnsupportedNotifiedRef.current = true
    toast({
      title: "当前浏览器不支持语音播放",
      description: "请使用系统浏览器或关闭静音模式后再试。",
      variant: "destructive",
    })
  }, [settings.autoPlayTranslations, toast, ttsSupported])

  const handleUnlockTts = useCallback(async () => {
    if (!ttsSupported) {
      toast({
        title: "当前浏览器不支持语音播放",
        description: "请使用系统浏览器或关闭静音模式后再试。",
        variant: "destructive",
      })
      return
    }
    if (ttsUnlockingRef.current || ttsUnlockedRef.current) return
    ttsUnlockingRef.current = true
    const ok = await unlockTts()
    ttsUnlockingRef.current = false
    if (!ok) {
      toast({
        title: "语音播放未解锁",
        description: "请点击页面后再尝试启用语音播放。",
        variant: "destructive",
      })
      return
    }
    const pending = pendingTtsRef.current
    if (pending) {
      pendingTtsRef.current = null
      speak(pending.text, pending.lang)
    }
  }, [speak, toast, ttsSupported, unlockTts])

  const playBeep = useCallback(async () => {
    try {
      if (typeof window === "undefined") return { ok: false, state: "no-window" }
      const AudioContextImpl = window.AudioContext || (window as any).webkitAudioContext
      if (!AudioContextImpl) return { ok: false, state: "no-audio-context" }
      const ctx = new AudioContextImpl()
      const initialState = ctx.state
      if (ctx.state === "suspended") {
        await ctx.resume()
      }
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.frequency.value = 880
      gain.gain.value = 0.2
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.25)
      setTimeout(() => {
        ctx.close()
      }, 400)
      return { ok: true, state: initialState }
    } catch {
      return { ok: false, state: "error" }
    }
  }, [])

  // Keep a ref to the test audio to prevent GC
  const testAudioRef = useRef<HTMLAudioElement | null>(null)

  const handleTestTts = useCallback(async () => {
    // 1. Try standard TTS
    speakWithOptions("语音测试", targetLanguage.code, { volume: 1.0, rate: 1.0, immediate: true })

    // 2. Synchronously create and play Online TTS as backup
    try {
      const text = "语音测试"
      const proxyUrl = `/api/tts?text=${encodeURIComponent(text)}&lang=${targetLanguage.code}`

      // Stop previous test audio if playing
      if (testAudioRef.current) {
        testAudioRef.current.pause()
        testAudioRef.current = null
      }

      const audio = new Audio(proxyUrl)
      testAudioRef.current = audio
      audio.volume = 1.0

      let hasPlayed = false
      audio.onplay = () => { hasPlayed = true }
      audio.onerror = (e) => {
        console.error("Direct Audio error:", e)
        // If online audio fails, try beep as last resort
        playBeep().then(res => {
          if (!res.ok) {
            toast({
              title: "音频系统故障",
              description: "无法播放网络语音，且无法启动蜂鸣器，请检查系统音频。",
              variant: "destructive"
            })
          } else {
            toast({
              title: "网络语音失败",
              description: "已播放蜂鸣提示音。可能是服务端代理无法连接语音服务器。",
              variant: "destructive"
            })
          }
        })
      }

      const p = audio.play()
      if (p !== undefined) {
        p.catch(error => {
          console.error("Direct Audio play failed:", error)
          // If play blocked or failed
          playBeep().then(() => {
            toast({
              title: "语音播放被拦截",
              description: `错误: ${error.message || "未知错误"}。已尝试蜂鸣。`,
              variant: "destructive"
            })
          })
        })
      }

    } catch (e) {
      console.error("Direct Audio setup failed:", e)
      playBeep()
    }

  }, [playBeep, speakWithOptions, targetLanguage.code, toast])

  useEffect(() => {
    const el = remoteAudioRef.current
    if (!el) return
    if (callStatus !== "active") return
    const hasStream = Boolean(el.srcObject)
    if (!hasStream) return
    el.muted = settings.onlyHearTranslatedVoice
    if (!settings.onlyHearTranslatedVoice) {
      void el.play().catch(() => { })
    }
  }, [callStatus, settings.onlyHearTranslatedVoice])

  const sendLiveCaption = useCallback((immediate: boolean) => {
    if (callStatusRef.current !== "active") return
    const peer = callPeerRef.current
    const activeCallId = callIdRef.current
    if (!peer?.id || !activeCallId) return
    if (!callLiveEnabled) return
    if (isCallMuted) return

    const nextTranscript = trimCaptionPayloadText(formattedLiveTranscript)
    const nextConfirmedTranscript = trimCaptionPayloadText(formattedConfirmedTranscript)
    const nextTranslation = trimCaptionPayloadText(formattedLiveTranslation)
    if (!nextTranscript && !nextTranslation) return

    const previous = lastLiveCaptionSentRef.current
    if (
      previous &&
      previous.callId === activeCallId &&
      previous.toUserId === peer.id &&
      previous.transcript === nextTranscript &&
      previous.confirmedTranscript === nextConfirmedTranscript &&
      previous.translation === nextTranslation
    ) {
      return
    }

    const emit = () => {
      const textToDetect = nextTranscript || liveTranscript
      const detected = detectLanguageFromText(textToDetect)
      const outgoingSource = sourceLanguage.code === "auto" ? detected : sourceLanguage.code
      const seq = liveCaptionSeqRef.current + 1
      liveCaptionSeqRef.current = seq
      const outgoingPayload = {
        type: "call_caption",
        callId: activeCallId,
        fromUserId: roomUserId,
        fromUserName: userName || t("call.unknownUser"),
        toUserId: peer.id,
        transcript: nextTranscript,
        confirmedTranscript: nextConfirmedTranscript,
        translation: nextTranslation,
        sourceLanguage: outgoingSource,
        targetLanguage: targetLanguage.code,
        timestamp: Date.now(),
        seq,
      } as CallSignalPayload
      lastLiveCaptionSentRef.current = {
        callId: activeCallId,
        toUserId: peer.id,
        transcript: nextTranscript,
        confirmedTranscript: nextConfirmedTranscript,
        translation: nextTranslation,
      }
      void sendSignal(peer.id, outgoingPayload).catch(() => {
        lastLiveCaptionSentRef.current = null
      })
    }

    if (liveCaptionSendTimerRef.current) {
      clearTimeout(liveCaptionSendTimerRef.current)
      liveCaptionSendTimerRef.current = null
    }

    if (immediate) {
      emit()
      return
    }

    liveCaptionSendTimerRef.current = setTimeout(() => {
      emit()
      liveCaptionSendTimerRef.current = null
    }, LIVE_CAPTION_SEND_DEBOUNCE_MS)
  }, [callLiveEnabled, formattedConfirmedTranscript, formattedLiveTranscript, formattedLiveTranslation, isCallMuted, liveTranscript, roomUserId, sendSignal, sourceLanguage.code, t, targetLanguage.code, trimCaptionPayloadText, userName])

  useEffect(() => {
    sendLiveCaption(false)
    return () => {
      if (liveCaptionSendTimerRef.current) {
        clearTimeout(liveCaptionSendTimerRef.current)
        liveCaptionSendTimerRef.current = null
      }
    }
  }, [sendLiveCaption])

  useEffect(() => {
    if (!formattedConfirmedTranscript.trim()) return
    sendLiveCaption(true)
  }, [formattedConfirmedTranscript, sendLiveCaption])

  const sourceLanguageOptions = useMemo<Language[]>(() => {
    const autoLabel = locale === "zh" ? "自动识别" : "Auto Detect"
    return [{ code: "auto", name: autoLabel, flag: "🌐" }, ...SUPPORTED_LANGUAGES]
  }, [locale])

  const handleSourceLanguageChange = useCallback((code: string) => {
    const next = sourceLanguageOptions.find((item) => item.code === code)
    if (!next) return
    setSourceLanguage(next)
    if (callStatusRef.current !== "active" || !callLiveEnabled || isCallMuted) return
    void restartCallLivePipeline(next.code, targetLanguage.code)
      .then(() => {
        toast({
          title: "语言切换成功",
          description: `实时翻译已切换为 ${next.name} -> ${targetLanguage.name}`,
        })
      })
      .catch((error) => {
        console.error("[CallLive] Failed to switch source language", error)
        toast({
          title: "源语言切换失败",
          description: "实时翻译语言更新失败，请稍后重试",
          variant: "destructive",
        })
      })
  }, [callLiveEnabled, isCallMuted, restartCallLivePipeline, sourceLanguageOptions, targetLanguage.code, targetLanguage.name, toast])

  const handleTargetLanguageChange = useCallback((code: string) => {
    const next = SUPPORTED_LANGUAGES.find((item) => item.code === code)
    if (!next) return
    setTargetLanguage(next)
    if (callStatusRef.current !== "active" || !callLiveEnabled || isCallMuted) return
    void restartCallLivePipeline(sourceLanguage.code, next.code)
      .then(() => {
        toast({
          title: "语言切换成功",
          description: `实时翻译已切换为 ${sourceLanguage.name} -> ${next.name}`,
        })
      })
      .catch((error) => {
        console.error("[CallLive] Failed to switch target language", error)
        toast({
          title: "目标语言切换失败",
          description: "实时翻译语言更新失败，请稍后重试",
          variant: "destructive",
        })
      })
  }, [callLiveEnabled, isCallMuted, restartCallLivePipeline, sourceLanguage.code, sourceLanguage.name, toast])

  useEffect(() => {
    const userKey = user?.id ?? "anon"
    if (languagePrefsInitKeyRef.current === userKey) return
    languagePrefsInitKeyRef.current = userKey

    const meta = (user?.user_metadata ?? {}) as Record<string, unknown>
    const rawSource =
      (meta.sourceLanguageCode as unknown) ??
      (meta.source_language_code as unknown) ??
      (meta.sourceLanguage as unknown) ??
      (meta.source_language as unknown)
    const rawTarget =
      (meta.targetLanguageCode as unknown) ??
      (meta.target_language_code as unknown) ??
      (meta.targetLanguage as unknown) ??
      (meta.target_language as unknown)

    const readLocal = (key: string) => {
      if (typeof window === "undefined") return null
      const value = window.localStorage.getItem(key)
      if (typeof value !== "string") return null
      const trimmed = value.trim()
      return trimmed ? trimmed : null
    }

    const localSource =
      readLocal(`voicelink_source_language:${userKey}`) ??
      (userKey !== "anon" ? readLocal("voicelink_source_language") : null) ??
      readLocal("voicelink_source_language:anon")
    const localTarget =
      readLocal(`voicelink_target_language:${userKey}`) ??
      (userKey !== "anon" ? readLocal("voicelink_target_language") : null) ??
      readLocal("voicelink_target_language:anon")

    const resolvedSource =
      typeof rawSource === "string" ? resolveLanguageCode(rawSource) : localSource ? resolveLanguageCode(localSource) : null
    const resolvedTarget =
      typeof rawTarget === "string" ? resolveLanguageCode(rawTarget) : localTarget ? resolveLanguageCode(localTarget) : null

    const nextSource = resolvedSource
      ? sourceLanguageOptions.find((l) => l.code === resolvedSource) ?? sourceLanguageOptions[0]
      : null
    const nextTarget = resolvedTarget ? SUPPORTED_LANGUAGES.find((l) => l.code === resolvedTarget) : null
    if (nextSource) setSourceLanguage(nextSource)
    if (nextTarget) setTargetLanguage(nextTarget)
    if (!nextSource && !nextTarget) {
      const fallbackCode = uiLocaleToLanguageCode()
      const fallbackLanguage = SUPPORTED_LANGUAGES.find((l) => l.code === fallbackCode) ?? SUPPORTED_LANGUAGES[0]
      setSourceLanguage(fallbackLanguage)
      setTargetLanguage(fallbackLanguage)
    }
  }, [resolveLanguageCode, sourceLanguageOptions, uiLocaleToLanguageCode, user?.id, user?.user_metadata])

  useEffect(() => {
    const userKey = user?.id ?? "anon"

    if (typeof window !== "undefined") {
      window.localStorage.setItem(`voicelink_source_language:${userKey}`, sourceLanguage.code)
      window.localStorage.setItem(`voicelink_target_language:${userKey}`, targetLanguage.code)
      if (userKey === "anon") {
        window.localStorage.setItem("voicelink_source_language", sourceLanguage.code)
        window.localStorage.setItem("voicelink_target_language", targetLanguage.code)
      }
    }

    if (!user) return
    const last = lastSavedLanguagePrefsRef.current
    if (last && last.userKey === userKey && last.source === sourceLanguage.code && last.target === targetLanguage.code) return
    lastSavedLanguagePrefsRef.current = { userKey, source: sourceLanguage.code, target: targetLanguage.code }
    void updateUserMetadata({ sourceLanguageCode: sourceLanguage.code, targetLanguageCode: targetLanguage.code }).catch((error) => {
      console.error("[v0] Save language prefs failed:", error)
    })
  }, [sourceLanguage.code, targetLanguage.code, updateUserMetadata, user])

  useEffect(() => {
    if (!isInRoom || !roomId || !roomUserId) return
    const source = sourceLanguage.code
    const target = targetLanguage.code
    const last = lastRoomLanguageUpdateRef.current
    if (last && last.roomId === roomId && last.userId === roomUserId && last.source === source && last.target === target) return
    lastRoomLanguageUpdateRef.current = { roomId, userId: roomUserId, source, target }

    const controller = new AbortController()
    fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_language",
        roomId,
        userId: roomUserId,
        sourceLanguage: source,
        targetLanguage: target,
      }),
      cache: "no-store",
      signal: controller.signal,
    }).catch(() => { })

    return () => {
      controller.abort()
    }
  }, [isInRoom, roomId, roomUserId, sourceLanguage.code, targetLanguage.code])

  const ensureClientInstanceId = useCallback(() => {
    if (clientInstanceIdRef.current) return clientInstanceIdRef.current
    if (typeof window === "undefined") {
      const fallback = `ci-${Math.random().toString(36).substring(2, 11)}`
      clientInstanceIdRef.current = fallback
      return fallback
    }

    const storageKey = "voicelink_client_instance_id"
    let storage: Storage | null = null
    try {
      storage = window.sessionStorage
    } catch {
      storage = null
    }
    const existing = storage?.getItem(storageKey)
    if (existing) {
      clientInstanceIdRef.current = existing
      return existing
    }

    const created =
      typeof window.crypto?.randomUUID === "function"
        ? window.crypto.randomUUID()
        : `ci-${Math.random().toString(36).substring(2, 11)}`
    try {
      storage?.setItem(storageKey, created)
    } catch { }
    clientInstanceIdRef.current = created
    return created
  }, [])

  const exitRoom = useCallback(
    (title: string, description: string) => {
      setIsInRoom(false)
      setRoomId("")
      setMessages([])
      setUsers([])
      setRoomUserId("")
      setJoinedAuthUserId(null)
      setRoomSettings(null)
      lastSyncedMessageAtRef.current = null
      roomVersionRef.current = 0
      pollSyncRoomRef.current = null
      resetCallState()
      leaveInitiatedRef.current = false
      if (pollIntervalRef.current) {
        clearTimeout(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
      if (pollAbortRef.current) {
        pollAbortRef.current.abort()
        pollAbortRef.current = null
      }
      pollInFlightRef.current = false
      pollFailureCountRef.current = 0
      pollLastCaptionActivityAtRef.current = 0
      translationCacheRef.current.clear()
      toast({ title, description })
    },
    [toast],
  )

  useEffect(() => {
    if (!isInRoom || !roomId || !roomUserId) return

    const sendLeave = () => {
      if (leaveInitiatedRef.current) return
      leaveInitiatedRef.current = true
      const payload = JSON.stringify({ action: "leave", roomId, userId: roomUserId })
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        const blob = new Blob([payload], { type: "application/json" })
        navigator.sendBeacon("/api/rooms", blob)
      } else {
        void fetch("/api/rooms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true,
        })
      }
    }

    // 页面关闭时清理 TRTC 连接，防止语音时长泄漏
    const handleBeforeUnload = () => {
      sendLeave()
      // 同步清理 TRTC，防止页面关闭后连接仍然保持
      const trtc = trtcRef.current
      if (trtc) {
        void safeStopScreenShare(trtc)
        void safeStopLocalVideo(trtc)
        void safeStopLocalAudio(trtc)
        void safeExitTrtcRoom(trtc)
        void safeDestroyTrtc(trtc)
        trtcRef.current = null
      }
    }

    window.addEventListener("pagehide", handleBeforeUnload)
    window.addEventListener("beforeunload", handleBeforeUnload)

    // 处理页面可见性变化：后台运行超过30秒自动断开TRTC
    let hiddenTimer: NodeJS.Timeout | null = null
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // 页面切换到后台，启动计时器
        hiddenTimer = setTimeout(() => {
          // 30秒后如果还在后台，断开TRTC连接
          const trtc = trtcRef.current
          if (trtc) {
            console.log("[TRTC] Page hidden for 30s, disconnecting to save resources")
            void safeStopScreenShare(trtc)
            void safeStopLocalVideo(trtc)
            void safeStopLocalAudio(trtc)
            void safeExitTrtcRoom(trtc)
            void safeDestroyTrtc(trtc)
            trtcRef.current = null
          }
        }, 30000) // 30秒
      } else {
        // 页面回到前台，清除计时器
        if (hiddenTimer) {
          clearTimeout(hiddenTimer)
          hiddenTimer = null
        }
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      window.removeEventListener("pagehide", handleBeforeUnload)
      window.removeEventListener("beforeunload", handleBeforeUnload)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      if (hiddenTimer) {
        clearTimeout(hiddenTimer)
      }
    }
  }, [isInRoom, roomId, roomUserId, safeDestroyTrtc, safeExitTrtcRoom, safeStopLocalAudio, safeStopLocalVideo, safeStopScreenShare])

  useEffect(() => {
    if (!isInRoom || !roomId || !roomUserId) return
    const cache = translationCacheRef.current
    let cancelled = false
    const syncRoomKey = `${roomId}:${roomUserId}`
    if (pollSyncRoomRef.current !== syncRoomKey) {
      pollSyncRoomRef.current = syncRoomKey
      lastSyncedMessageAtRef.current = null
      roomVersionRef.current = 0
    }

    const clearPolling = () => {
      if (pollIntervalRef.current) {
        clearTimeout(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
      if (pollAbortRef.current) {
        pollAbortRef.current.abort()
        pollAbortRef.current = null
      }
      pollInFlightRef.current = false
    }

    const getAdaptivePollDelay = (activeCall: boolean) => {
      if (!activeCall) return IDLE_POLL_INTERVAL_MS
      const lastActivityAt = pollLastCaptionActivityAtRef.current
      const silentMs = lastActivityAt > 0 ? Date.now() - lastActivityAt : Number.POSITIVE_INFINITY
      if (silentMs < 1200) return ACTIVE_CALL_POLL_FAST_INTERVAL_MS
      if (silentMs < 5000) return ACTIVE_CALL_POLL_INTERVAL_MS
      return ACTIVE_CALL_POLL_IDLE_INTERVAL_MS
    }

    const schedulePoll = (delayMs: number) => {
      if (cancelled) return
      if (pollIntervalRef.current) clearTimeout(pollIntervalRef.current)
      pollIntervalRef.current = setTimeout(() => {
        void pollRoom()
      }, delayMs)
    }

    const pollRoom = async () => {
      if (cancelled) return
      if (pollInFlightRef.current) {
        schedulePoll(getAdaptivePollDelay(callStatusRef.current === "active"))
        return
      }
      pollInFlightRef.current = true
      let shouldSchedule = true
      let nextDelayMs = getAdaptivePollDelay(callStatusRef.current === "active")
      try {
        const controller = new AbortController()
        if (pollAbortRef.current) pollAbortRef.current.abort()
        pollAbortRef.current = controller

        const response = await fetch("/api/rooms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "poll",
            roomId,
            userId: roomUserId,
            since: lastSyncedMessageAtRef.current ?? undefined,
            callActive: callStatusRef.current === "active",
            roomVersion: roomVersionRef.current || undefined,
            longPoll: true,
          }),
          cache: "no-store",
          signal: controller.signal,
        })

        if (response.status === 410) {
          shouldSchedule = false
          exitRoom(t("toast.expiredTitle"), t("toast.expiredDesc"))
          return
        }
        if (response.status === 404) {
          shouldSchedule = false
          exitRoom(t("toast.roomUnavailableTitle"), t("toast.roomUnavailableDesc"))
          return
        }
        if (response.status === 429) {
          const throttleData = (await response.json().catch(() => null)) as { retryAfter?: unknown } | null
          const retryAfterRaw = Number(throttleData?.retryAfter ?? Number.NaN)
          const adaptiveDelay = getAdaptivePollDelay(callStatusRef.current === "active")
          if (Number.isFinite(retryAfterRaw) && retryAfterRaw > 0) {
            nextDelayMs = Math.max(adaptiveDelay, Math.min(10000, Math.ceil(retryAfterRaw)))
          } else {
            nextDelayMs = Math.max(adaptiveDelay, 4000)
          }
          console.warn("[Poll] 429 Too Many Requests, slowing down poll interval")
          return
        }

        if (!response.ok) {
          throw new Error(`Poll failed with status ${response.status}`)
        }

        const data = (await response.json().catch(() => null)) as
          | {
            success?: boolean
            timeout?: boolean
            roomVersion?: number
            room?: {
              users: User[]
              messages: Array<{
                id: string
                userId: string
                userName: string
                originalText: string
                originalLanguage: string
                translatedText?: string
                targetLanguage?: string
                timestamp: string
                audioUrl?: string
              }>
            }
            settings?: { adminUserId?: string; joinMode?: "public" | "password" } | null
            signals?: Array<{ from?: string; payload?: unknown }>
          }
          | null
        if (typeof data?.roomVersion === "number" && Number.isFinite(data.roomVersion) && data.roomVersion > 0) {
          roomVersionRef.current = data.roomVersion
        }
        if (data?.success && data?.timeout) {
          pollFailureCountRef.current = 0
          nextDelayMs = 120
          return
        }
        if (!data?.success || !data.room) {
          throw new Error("Invalid poll response")
        }

        const room = data.room
        let latestMessageMs = Number.NaN
        if (Array.isArray(room.messages)) {
          for (const msg of room.messages) {
            const ts = Date.parse(msg.timestamp)
            if (Number.isFinite(ts) && (!Number.isFinite(latestMessageMs) || ts > latestMessageMs)) {
              latestMessageMs = ts
            }
          }
          if (Number.isFinite(latestMessageMs)) {
            lastSyncedMessageAtRef.current = new Date(latestMessageMs).toISOString()
          }
        }
        const nextSettings =
          data.settings && typeof data.settings.adminUserId === "string"
            ? ({ adminUserId: data.settings.adminUserId, joinMode: data.settings.joinMode === "password" ? "password" : "public" } as const)
            : null
        if (nextSettings) setRoomSettings(nextSettings)
        if (!leaveInitiatedRef.current && !room.users.some((u) => u.id === roomUserId)) {
          shouldSchedule = false
          exitRoom(t("toast.kickedTitle"), t("toast.kickedDesc"))
          return
        }

        const nextUsers = room.users.map((user) =>
          user.id === roomUserId
            ? { ...user, sourceLanguage: sourceLanguage.code, targetLanguage: targetLanguage.code }
            : user,
        )
        setUsers(nextUsers)

        const signals = Array.isArray(data.signals) ? data.signals : []
        let hasCaptionSignal = false
        if (signals.length > 0) {
          for (const evt of signals) {
            const fromId = typeof evt?.from === "string" ? evt.from : ""
            const payload = (evt?.payload ?? {}) as Partial<CallSignalPayload> & Record<string, unknown>
            const type = String(payload?.type ?? "")
            if (!fromId || !type) continue
            const fromUser = nextUsers.find((u) => u.id === fromId)
            const fromName = String(payload.fromUserName || fromUser?.name || t("call.unknownUser"))
            if (type === "call_invite") {
              const incomingId = String(payload.callId || "")

              // Fix for "single call limitation":
              // If we receive an invite from the same user we are currently in a "call" with (or trying to call),
              // it means the previous session is likely dead/stuck on their end.
              // We should force reset our state to accept the new call.
              if (callStatusRef.current !== "idle" && callPeerRef.current?.id === fromId) {
                console.log("[v0] Received invite from current peer, resetting stuck state")
                resetCallState()
              }

              if (callStatusRef.current !== "idle") {
                try {
                  await sendSignal(fromId, {
                    type: "call_busy",
                    callId: incomingId || randomId(),
                    fromUserId: roomUserId,
                    fromUserName: userName || t("call.unknownUser"),
                    toUserId: fromId,
                  } as CallSignalPayload)
                } catch { }
                continue
              }
              setCallPeer({ id: fromId, name: fromName })
              setCallId(incomingId || randomId())
              setCallStatus("incoming")
              setIncomingCallOpen(true)
              toast({ title: t("call.incomingTitle"), description: t("call.incomingDesc", { name: fromName }) })
              continue
            }
            if (type === "call_accept") {
              if (callStatusRef.current === "outgoing" && callPeerRef.current?.id === fromId) {
                const acceptId = String(payload.callId || "")
                if (!callIdRef.current || !acceptId || callIdRef.current === acceptId) {
                  setCallStatus("active")
                  callActiveRef.current = true
                  void enterTRTCRoom(callIdRef.current || acceptId, roomUserId).catch(() => { })
                  toast({ title: t("call.acceptedTitle"), description: t("call.acceptedDesc", { name: fromName }) })
                }
              }
              continue
            }

            if (type === "call_caption") {
              hasCaptionSignal = true
              const incomingId = String(payload.callId || "")
              if (callStatusRef.current !== "active" || (incomingId && callIdRef.current && incomingId !== callIdRef.current)) {
                continue
              }
              if (trtcCustomCaptionActiveRef.current) {
                continue
              }
              const seqRaw = payload.seq
              const seq =
                typeof seqRaw === "number"
                  ? seqRaw
                  : Number.parseInt(typeof seqRaw === "string" ? seqRaw : "", 10)
              const seqKey = `${fromId}:${incomingId || callIdRef.current || ""}`
              if (Number.isFinite(seq) && seq > 0) {
                const previousSeq = remoteCaptionSeqRef.current.get(seqKey) ?? 0
                if (seq <= previousSeq) {
                  continue
                }
                remoteCaptionSeqRef.current.set(seqKey, seq)
              }
              const transcript = typeof payload.transcript === "string" ? payload.transcript : ""
              const confirmedTranscript = typeof payload.confirmedTranscript === "string" ? payload.confirmedTranscript : ""
              const translation = typeof payload.translation === "string" ? payload.translation : ""
              const sourceLang = typeof payload.sourceLanguage === "string" ? payload.sourceLanguage : ""

              setRemoteLiveTranscript(transcript)
              setRemoteConfirmedTranscript(confirmedTranscript)

              // Only update translation from signal if it's valid and matches our target language preference
              // Heuristic: If translation language is significantly different from our target, ignore it.
              // e.g. We want EN, but got ZH translation (or no translation, i.e. same as source).
              const targetPrimary = targetLanguage.code.split("-")[0]
              const translationLang = detectLanguageFromText(translation)
              const translationPrimary = translationLang.split("-")[0]

              // If translation is provided
              if (translation) {
                // If we strictly expect EN, but got ZH, and translation equals transcript (meaning no translation), ignore it.
                // Or if translation is just totally different from target.
                // But sometimes "你好" -> "Hello" is correct.
                // If translation is "你好" (ZH) and target is EN, then it's wrong.
                if (targetPrimary !== translationPrimary && targetPrimary === "en" && translationPrimary === "zh") {
                  // Ignore remote translation, let local translation handle it
                } else {
                  setRemoteLiveTranslation(translation)
                  remoteTranslationSignalAtRef.current = Date.now()
                }
              } else if (!transcript) {
                setRemoteLiveTranslation("")
              }

              const resolvedSourceLang = resolveLanguageCode(sourceLang)
              const normalizedSourceLang = resolvedSourceLang.trim().toLowerCase()
              setRemoteLiveSourceLanguage(!normalizedSourceLang || normalizedSourceLang === "auto" || normalizedSourceLang === "自动识别" ? "" : resolvedSourceLang)
              setRemoteLiveUserName(fromName)
              continue
            }
            if (type === "call_reject" || type === "call_busy") {
              if (callStatusRef.current === "outgoing" && callPeerRef.current?.id === fromId) {
                resetCallState()
                toast({
                  title: type === "call_busy" ? t("call.busyTitle") : t("call.rejectedByPeerTitle"),
                  description: type === "call_busy" ? t("call.busyDesc", { name: fromName }) : t("call.rejectedByPeerDesc", { name: fromName }),
                })
              }
              continue
            }
            if (type === "call_end") {
              const endId = String(payload.callId || "")
              if (callStatusRef.current !== "idle" && (!endId || endId === callIdRef.current)) {
                resetCallState()
                toast({ title: t("call.endedByPeerTitle"), description: t("call.endedByPeerDesc") })
              }
              continue
            }
          }
        }

        if (hasCaptionSignal) {
          pollLastCaptionActivityAtRef.current = Date.now()
        }

        const avatarById = new Map(room.users.map((u) => [u.id, u.avatar]))
        const newMessages = await Promise.all(
          room.messages.map(async (msg) => {
            const declaredSourceLanguageCode = resolveLanguageCode(msg.originalLanguage)
            const detectedSourceLanguageCode = resolveLanguageCode(detectLanguageFromText(msg.originalText))
            const sourceLanguageCode =
              primaryOf(declaredSourceLanguageCode) === primaryOf(detectedSourceLanguageCode)
                ? declaredSourceLanguageCode
                : detectedSourceLanguageCode
            const targetLanguageCode = targetLanguage.code
            const cacheKey = `${msg.id}:${targetLanguageCode}`
            const cached = cache.get(cacheKey)

            const isCurrentUser = msg.userId === roomUserId
            let translatedText = msg.originalText

            if (typeof cached === "string" && cached.length > 0) {
              translatedText = cached
            } else if (sourceLanguageCode !== targetLanguageCode) {
              try {
                translatedText = await translateText(msg.originalText, sourceLanguageCode, targetLanguageCode)
                cache.set(cacheKey, translatedText)
              } catch (error) {
                console.error("[v0] Translation error:", error)
              }
            }

            return {
              id: msg.id,
              userId: msg.userId,
              userName: msg.userName,
              originalText: msg.originalText,
              translatedText,
              originalLanguage: sourceLanguageCode,
              targetLanguage: targetLanguageCode,
              timestamp: new Date(msg.timestamp),
              isUser: isCurrentUser,
              audioUrl: msg.audioUrl,
              userAvatar: avatarById.get(msg.userId),
            }
          }),
        )

        setMessages((prev) => {
          if (newMessages.length === 0) return prev
          const byId = new Map<string, Message>()
          for (const msg of prev) {
            byId.set(msg.id, msg)
          }
          for (const msg of newMessages) {
            byId.set(msg.id, msg)
          }
          const merged = Array.from(byId.values()).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
          return merged.length > 240 ? merged.slice(-240) : merged
        })
        if (newMessages.length > 0) {
          pollLastCaptionActivityAtRef.current = Date.now()
        }
        nextDelayMs = 120
        pollFailureCountRef.current = 0
      } catch (error) {
        if (cancelled) return
        if (error instanceof DOMException && error.name === "AbortError") {
          shouldSchedule = false
          return
        }
        const nextFailures = pollFailureCountRef.current + 1
        pollFailureCountRef.current = nextFailures
        const exp = Math.min(4, Math.max(0, nextFailures - 1))
        nextDelayMs = Math.min(30_000, Math.max(getAdaptivePollDelay(callStatusRef.current === "active"), 1200 * 2 ** exp))
      } finally {
        pollInFlightRef.current = false
        if (shouldSchedule) schedulePoll(nextDelayMs)
      }
    }

    void pollRoom()

    return () => {
      cancelled = true
      clearPolling()
      cache.clear()
      if (pollSyncRoomRef.current === syncRoomKey) {
        pollSyncRoomRef.current = null
      }
    }
  }, [exitRoom, isInRoom, primaryOf, resolveLanguageCode, roomId, roomUserId, t, sourceLanguage.code, targetLanguage.code, uiLocaleToLanguageCode])

  const handleJoinRoom = async (
    newRoomId: string,
    newUserName: string,
    options?: { joinPassword?: string; createJoinMode?: "public" | "password"; createPassword?: string },
  ): Promise<{ success: boolean; needsPassword?: boolean }> => {
    try {
      const participantId = user?.id ? `${user.id}:${ensureClientInstanceId()}` : anonUserId
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "join",
          roomId: newRoomId,
          userId: participantId,
          userName: newUserName,
          sourceLanguage: sourceLanguage.code,
          targetLanguage: targetLanguage.code,
          avatarUrl: profile?.avatar_url ?? undefined,
          joinPassword: options?.joinPassword,
          createJoinMode: options?.createJoinMode,
          createPassword: options?.createPassword,
        }),
      })

      const data = (await response.json().catch(() => null)) as
        | { success?: boolean; room?: { users: User[] }; settings?: { adminUserId?: string; joinMode?: "public" | "password" } | null; error?: string }
        | null
      if (!response.ok || !data?.success || !data.room) {
        if (response.status === 401) {
          toast({
            title: t("toast.errorTitle"),
            description: options?.joinPassword ? t("toast.passwordInvalid") : t("toast.passwordRequired"),
            variant: "destructive",
          })
          return { success: false, needsPassword: true }
        }
        toast({
          title: t("toast.errorTitle"),
          description: data?.error ? String(data.error) : t("toast.joinFailed"),
          variant: "destructive",
        })
        return { success: false }
      }
      if (data.success) {
        leaveInitiatedRef.current = false
        setRoomId(newRoomId)
        setUserName(newUserName)
        setRoomUserId(participantId)
        setJoinedAuthUserId(user?.id ?? null)
        setIsInRoom(true)
        setUsers(
          data.room.users.map((entry) =>
            entry.id === participantId
              ? { ...entry, sourceLanguage: sourceLanguage.code, targetLanguage: targetLanguage.code }
              : entry,
          ),
        )
        const nextSettings =
          data.settings && typeof data.settings.adminUserId === "string"
            ? ({ adminUserId: data.settings.adminUserId, joinMode: data.settings.joinMode === "password" ? "password" : "public" } as const)
            : null
        setRoomSettings(nextSettings)
        toast({
          title: t("toast.joinedTitle"),
          description: t("toast.joinedDesc", { roomId: newRoomId }),
        })
        return { success: true }
      }
      return { success: false }
    } catch (error) {
      console.error("[v0] Join room error:", error)
      toast({
        title: t("toast.errorTitle"),
        description: t("toast.joinFailed"),
        variant: "destructive",
      })
      return { success: false }
    }
  }

  const handleKickUser = useCallback(
    async (targetUserId: string) => {
      try {
        const res = await fetch("/api/rooms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "kick", roomId, userId: roomUserId, targetUserId }),
        })
        if (res.status === 410) {
          exitRoom(t("toast.expiredTitle"), t("toast.expiredDesc"))
          return
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null
          toast({
            title: t("toast.errorTitle"),
            description: data?.error ? String(data.error) : t("toast.kickFailed"),
            variant: "destructive",
          })
          return
        }
        toast({ title: t("toast.kickSuccessTitle"), description: t("toast.kickSuccessDesc") })
      } catch {
        toast({ title: t("toast.errorTitle"), description: t("toast.kickFailed"), variant: "destructive" })
      }
    },
    [exitRoom, roomId, roomUserId, t, toast],
  )

  const isAdmin = Boolean(roomSettings && roomSettings.adminUserId === roomUserId)

  const openRoomSettings = () => {
    const nextMode = roomSettings?.joinMode ?? "public"
    setRoomSettingsJoinMode(nextMode)
    setRoomSettingsPassword("")
    setRoomSettingsOpen(true)
  }

  const saveRoomSettings = async () => {
    if (!roomId || !roomUserId) return
    setRoomSettingsSaving(true)
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_settings",
          roomId,
          userId: roomUserId,
          joinMode: roomSettingsJoinMode,
          password: roomSettingsPassword,
        }),
      })
      if (res.status === 410) {
        exitRoom(t("toast.expiredTitle"), t("toast.expiredDesc"))
        return
      }
      const data = (await res.json().catch(() => null)) as
        | { success?: boolean; settings?: { adminUserId?: string; joinMode?: "public" | "password" } | null; error?: string }
        | null
      if (!res.ok || !data?.success || !data.settings?.adminUserId) {
        toast({
          title: t("toast.errorTitle"),
          description: data?.error ? String(data.error) : t("toast.roomSettingsSaveFailed"),
          variant: "destructive",
        })
        return
      }
      setRoomSettings({
        adminUserId: data.settings.adminUserId,
        joinMode: data.settings.joinMode === "password" ? "password" : "public",
      })
      setRoomSettingsOpen(false)
      toast({ title: t("toast.roomSettingsSavedTitle"), description: t("toast.roomSettingsSavedDesc") })
    } finally {
      setRoomSettingsSaving(false)
    }
  }

  const handleLeaveRoom = useCallback(async () => {
    try {
      leaveInitiatedRef.current = true
      const peer = callPeerRef.current
      const id = callIdRef.current
      if (peer && id) {
        try {
          await sendSignal(peer.id, {
            type: "call_end",
            callId: id,
            fromUserId: roomUserId,
            fromUserName: userName || t("call.unknownUser"),
            toUserId: peer.id,
          } as CallSignalPayload)
        } catch { }
      }
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "leave",
          roomId,
          userId: roomUserId,
        }),
      })
      if (res.status === 410) {
        exitRoom(t("toast.expiredTitle"), t("toast.expiredDesc"))
        return
      }
      exitRoom(t("toast.leftTitle"), t("toast.leftDesc"))
    } catch (error) {
      console.error("[v0] Leave room error:", error)
    }
  }, [exitRoom, roomId, roomUserId, sendSignal, t, userName])

  useEffect(() => {
    if (!isInRoom) return
    if (!joinedAuthUserId) return
    if (!user?.id) return
    if (user.id === joinedAuthUserId) return
    void handleLeaveRoom()
  }, [handleLeaveRoom, isInRoom, joinedAuthUserId, user?.id])

  // 组件卸载时清理 TRTC 连接，防止内存泄漏和资源浪费
  useEffect(() => {
    return () => {
      // 组件卸载时同步清理 TRTC
      const trtc = trtcRef.current
      if (trtc) {
        void safeStopScreenShare(trtc)
        void safeStopLocalVideo(trtc)
        void safeStopLocalAudio(trtc)
        void safeExitTrtcRoom(trtc)
        void safeDestroyTrtc(trtc)
        trtcRef.current = null
      }
    }
  }, [safeDestroyTrtc, safeExitTrtcRoom, safeStopLocalAudio, safeStopLocalVideo, safeStopScreenShare])

  const handleCopyRoomId = async () => {
    try {
      await navigator.clipboard.writeText(roomId)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      toast({
        title: t("toast.copiedTitle"),
        description: t("toast.copiedDesc"),
      })
    } catch (error) {
      console.error("[v0] Copy error:", error)
    }
  }

  const handleClearChat = useCallback(() => {
    setMessages([])
    lastSyncedMessageAtRef.current = null
    toast({
      title: t("toast.chatClearedTitle"),
      description: t("toast.chatClearedDesc"),
    })
  }, [t, toast])

  const handleProfileSaved = useCallback(
    ({ displayName, avatarUrl }: { displayName: string; avatarUrl: string }) => {
      if (!roomUserId) return
      setUserName(displayName)
      setUsers((prev) =>
        prev.map((item) =>
          item.id === roomUserId
            ? { ...item, name: displayName, avatar: avatarUrl || item.avatar }
            : item,
        ),
      )
      setMessages((prev) =>
        prev.map((msg) => (msg.userId === roomUserId ? { ...msg, userName: displayName, userAvatar: avatarUrl || msg.userAvatar } : msg)),
      )
    },
    [roomUserId],
  )
  const handleSendMessage = useCallback(async () => {
    if (!inputText.trim() || isProcessing) return
    setIsProcessing(true)
    const textToSend = inputText.trim()
    const detectedLanguage = resolveLanguageCode(detectLanguageFromText(textToSend))
    setInputText("")
    const messageId = randomId()
    const timestampIso = new Date().toISOString()
    const optimisticMessage: Message = {
      id: messageId,
      userId: roomUserId,
      userName,
      originalText: textToSend,
      translatedText: textToSend,
      originalLanguage: detectedLanguage,
      targetLanguage: targetLanguage.code,
      timestamp: new Date(timestampIso),
      isUser: true,
      userAvatar: users.find((u) => u.id === roomUserId)?.avatar,
    }

    setMessages((prev) => {
      const merged = [...prev, optimisticMessage].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
      return merged.length > 240 ? merged.slice(-240) : merged
    })
    lastSyncedMessageAtRef.current = timestampIso

    try {
      const message = {
        id: messageId,
        userId: roomUserId,
        userName,
        originalText: textToSend,
        originalLanguage: detectedLanguage,
        timestamp: timestampIso,
      }

      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "message",
          roomId,
          message,
        }),
      })

      if (res.status === 410) {
        exitRoom(t("toast.expiredTitle"), t("toast.expiredDesc"))
        return
      }
      if (!res.ok) {
        throw new Error("Send message failed")
      }
    } catch (error) {
      console.error("[v0] Send message error:", error)
      setMessages((prev) => prev.filter((item) => item.id !== messageId))
      toast({
        title: t("toast.errorTitle"),
        description: t("toast.processFailed"),
        variant: "destructive",
      })
      setInputText(textToSend)
    } finally {
      setIsProcessing(false)
    }
  }, [exitRoom, inputText, isProcessing, randomId, resolveLanguageCode, roomId, roomUserId, t, targetLanguage.code, toast, userName, users])

  const handleRecordingComplete = useCallback(
    async (audioBlob: Blob) => {
      console.log("[v0] Recording complete, blob size:", audioBlob.size)
      setIsProcessing(true)

      try {
        let uploadPromise: Promise<string | undefined> | null = null
        if (isTencentDeploy) {
          uploadPromise = (async () => {
            try {
              const uploadForm = new FormData()
              uploadForm.set("audio", new File([audioBlob], `voice-${Date.now()}.webm`, { type: audioBlob.type || "audio/webm" }))
              const uploadRes = await fetch("/api/audio/upload", {
                method: "POST",
                body: uploadForm,
              })
              const uploadData = (await uploadRes.json().catch(() => null)) as { success?: boolean; audioUrl?: string } | null
              if (uploadRes.ok && uploadData?.success && typeof uploadData.audioUrl === "string") {
                return uploadData.audioUrl
              }
            } catch (uploadError) {
              console.warn("[v0] Audio upload skipped:", uploadError)
            }
            return undefined
          })()
        }

        const selectedLanguageCode = sourceLanguage.code
        const transcribedText = await transcribeAudio(audioBlob, selectedLanguageCode)
        if (!transcribedText.trim()) {
          toast({ title: t("toast.errorTitle"), description: "未识别到有效语音，请重试。", variant: "destructive" })
          return
        }
        console.log("[v0] Transcribed text:", transcribedText)
        const detectedLanguage = resolveLanguageCode(detectLanguageFromText(transcribedText))
        const detectedLanguageName =
          SUPPORTED_LANGUAGES.find((lang) => lang.code === detectedLanguage)?.name ?? detectedLanguage

        let uploadedAudioUrl: string | undefined
        if (uploadPromise) {
          uploadedAudioUrl = await Promise.race([
            uploadPromise,
            new Promise<undefined>((resolve) => {
              setTimeout(() => resolve(undefined), 1200)
            }),
          ])
        }

        const messageId = randomId()
        const timestampIso = new Date().toISOString()
        const optimisticMessage: Message = {
          id: messageId,
          userId: roomUserId,
          userName,
          originalText: transcribedText,
          translatedText: transcribedText,
          originalLanguage: detectedLanguage,
          targetLanguage: targetLanguage.code,
          timestamp: new Date(timestampIso),
          isUser: true,
          audioUrl: uploadedAudioUrl,
          userAvatar: users.find((u) => u.id === roomUserId)?.avatar,
        }
        setMessages((prev) => {
          const merged = [...prev, optimisticMessage].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
          return merged.length > 240 ? merged.slice(-240) : merged
        })
        lastSyncedMessageAtRef.current = timestampIso

        const message = {
          id: messageId,
          userId: roomUserId,
          userName,
          originalText: transcribedText,
          originalLanguage: detectedLanguage,
          timestamp: timestampIso,
          audioUrl: uploadedAudioUrl,
        }

        const res = await fetch("/api/rooms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "message",
            roomId,
            message,
          }),
        })

        if (res.status === 410) {
          setMessages((prev) => prev.filter((item) => item.id !== messageId))
          exitRoom(t("toast.expiredTitle"), t("toast.expiredDesc"))
          return
        }
        if (!res.ok) {
          setMessages((prev) => prev.filter((item) => item.id !== messageId))
          throw new Error("Send message failed")
        }

        toast({
          title: t("toast.sentTitle"),
          description: t("toast.sentDesc", { language: detectedLanguageName }),
        })
      } catch (error) {
        console.error("[v0] Processing error:", error)
        toast({
          title: t("toast.errorTitle"),
          description: t("toast.processFailed"),
          variant: "destructive",
        })
      } finally {
        setIsProcessing(false)
        setLiveTranscript("")
        setConfirmedTranscript("")
        setLiveTranslation("")
        setLiveTranscriptLines([])
        setLiveTranslationLines([])
        liveCommittedTranscriptRef.current = ""
        liveCommittedTranslationRef.current = ""
        if (liveAutoBreakTimerRef.current) {
          clearTimeout(liveAutoBreakTimerRef.current)
          liveAutoBreakTimerRef.current = null
        }
      }
    },
    [exitRoom, isTencentDeploy, randomId, resolveLanguageCode, roomId, roomUserId, sourceLanguage.code, t, toast, targetLanguage.code, userName, users],
  )

  useEffect(() => {
    if (!isMobile) return
    const isRemoteSub = remoteVideoStreamType === TRTC.TYPE.STREAM_TYPE_SUB
    if (!remoteScreenAvailable && (isRemoteSub || !remoteVideoAvailable)) {
      setRemoteVideoAvailable(false)
      setRemoteVideoUserId(null)
      setRemoteVideoStreamType(null)
    }
  }, [isMobile, remoteScreenAvailable, remoteVideoAvailable, remoteVideoStreamType])

  if (!isInRoom) {
    return <RoomJoin onJoin={handleJoinRoom} initialRoomId={urlRoomId} autoJoin={autoJoin || Boolean(urlRoomId)} />
  }

  const showLocalVideo = isVideoEnabled || (isMobile && isScreenSharing)
  const showRemoteVideo = isMobile
    ? remoteScreenAvailable || (remoteVideoAvailable && (remoteVideoStreamType ?? TRTC.TYPE.STREAM_TYPE_MAIN) === TRTC.TYPE.STREAM_TYPE_MAIN)
    : remoteVideoAvailable
  const showVideoSection = showLocalVideo || showRemoteVideo
  const showLocalScreen = !isMobile && isScreenSharing
  const showRemoteScreen = !isMobile && remoteScreenAvailable
  const showScreenSection = showLocalScreen || showRemoteScreen

  // Determine if the Stage (Video/Screen area) should be visible
  // We show it if there is an active call AND (video is on OR screen share is on OR remote has video/screen)
  // Or if we are just in a "Call" state (audio only), we might want to show avatars?
  // For now, let's show it if we have an active peer connection, to allow access to controls.
  const isStageVisible = (callStatus === "active" && callPeer) || isScreenSharing || showVideoSection || showScreenSection

  return (
    <div className="flex flex-col h-[100dvh] w-full bg-background overflow-x-hidden md:fixed md:inset-0">
      <audio ref={remoteAudioRef} className="hidden" />

      {/* 1. Global Header */}
      <div className="shrink-0 z-50 bg-card border-b shadow-sm pt-[env(safe-area-inset-top)]">
        <Header
          onClearChat={handleClearChat}
          messageCount={messages.length}
          onSettingsChange={setSettings}
          roomId={isInRoom ? roomId : undefined}
          roomUserId={roomUserId}
          onProfileSaved={handleProfileSaved}
          userCount={users.length}
          onShowUsers={() => setIsUsersSheetOpen(true)}
          onLeaveRoom={handleLeaveRoom}
          onCopyRoomId={handleCopyRoomId}
        />
      </div>

      <div className="flex-1 flex min-h-0 relative overflow-hidden">
        {/* 2. Desktop Sidebar (User List) */}
        <div className="hidden lg:flex w-64 border-r border-border bg-muted/10 flex-col shrink-0">
          <div className="flex-1 overflow-y-auto p-4">
            <UserList
              users={users}
              currentUserId={roomUserId}
              adminUserId={roomSettings?.adminUserId ?? null}
              canKick={isAdmin}
              onKick={handleKickUser}
              roomId={roomId}
              onCall={(targetUserId) => {
                const target = users.find((u) => u.id === targetUserId)
                if (target) void startOutgoingCall({ id: target.id, name: target.name })
              }}
            />
          </div>
          <div className="p-4 border-t border-border">
            <AdSlot slotKey="room_sidebar" variant="sidebar" limit={2} fetchLimit={6} rotateMs={7000} />
          </div>
        </div>

        {/* 3. Main Content Area */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-background relative">

          {/* Split View Container */}
          <div className="flex flex-col lg:flex-row flex-1 min-h-0">

            {/* 3a. Video/Screen Stage */}
            {/* Always rendered to keep refs alive, but hidden via CSS when inactive */}
            <div className={`
              relative flex flex-col bg-zinc-950 transition-all duration-300 ease-in-out
              ${isStageVisible
                ? 'lg:flex-[2] basis-[40vh] shrink-0 lg:basis-auto border-b lg:border-b-0 lg:border-r border-border'
                : 'hidden'}
            `}>
              {/* Stage Content */}
              <div className="flex-1 p-2 md:p-4 flex items-center justify-center overflow-hidden">
                <div className={`
                  grid gap-2 w-full max-w-5xl max-h-full transition-all
                  ${(showScreenSection || (showLocalVideo && showRemoteVideo)) ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'}
                `}>

                  {/* Local Screen */}
                  <div className={`relative rounded-xl overflow-hidden bg-muted/10 border border-white/10 aspect-video ${showLocalScreen ? '' : 'hidden'}`}>
                    <div className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded-md bg-black/60 text-white text-[10px] font-medium backdrop-blur-sm">
                      {t("call.localScreen")}
                    </div>
                    <div ref={localScreenRef} className="w-full h-full bg-black/20" />
                  </div>

                  {/* Remote Screen */}
                  <div className={`relative rounded-xl overflow-hidden bg-muted/10 border border-white/10 aspect-video ${showRemoteScreen ? '' : 'hidden'}`}>
                    <div className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded-md bg-black/60 text-white text-[10px] font-medium backdrop-blur-sm">
                      {t("call.remoteScreen")}
                    </div>
                    <div className="relative w-full h-full">
                      <div ref={remoteScreenRef} className="w-full h-full bg-black/20" />
                      {!remoteScreenAvailable && (
                        <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-400">
                          {t("call.noRemoteScreen")}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Local Video */}
                  <div className={`relative rounded-xl overflow-hidden bg-muted/10 border border-white/10 aspect-video ${showLocalVideo ? '' : 'hidden'}`}>
                    <div className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded-md bg-black/60 text-white text-[10px] font-medium backdrop-blur-sm">
                      {isMobile && isScreenSharing ? t("call.localScreen") : t("call.localVideo")}
                    </div>
                    <div ref={localVideoRef} className="w-full h-full bg-black/20" />
                  </div>

                  {/* Remote Video */}
                  <div className={`relative rounded-xl overflow-hidden bg-muted/10 border border-white/10 aspect-video ${showRemoteVideo ? '' : 'hidden'}`}>
                    <div className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded-md bg-black/60 text-white text-[10px] font-medium backdrop-blur-sm">
                      {isMobile && remoteScreenAvailable ? t("call.remoteScreen") : t("call.remoteVideo")}
                    </div>
                    <div className="relative w-full h-full">
                      <div ref={remoteVideoRef} className="w-full h-full bg-black/20" />
                      {!remoteVideoAvailable && !(isMobile && remoteScreenAvailable) && (
                        <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-400">
                          {t("call.noRemoteVideo")}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Audio Only Placeholder */}
                  {!showVideoSection && !showScreenSection && callPeer && (
                    <div className="col-span-full flex flex-col items-center justify-center gap-4 text-zinc-400">
                      <Avatar className="h-20 w-20 border-4 border-white/10">
                        <AvatarImage src={callPeerUser?.avatar || ""} />
                        <AvatarFallback className="text-2xl">{callPeer.name?.slice(0, 1) || "?"}</AvatarFallback>
                      </Avatar>
                      <div className="text-center">
                        <div className="font-semibold text-white">{callPeer.name}</div>
                        <div className="text-xs opacity-70">{t("call.acceptedDesc", { name: callPeer.name })}</div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Stage Controls (Floating) */}
              <div className="p-4 flex items-center justify-center gap-3 bg-gradient-to-t from-black/90 to-transparent">
                <div className="absolute top-4 right-4 px-2 py-1 rounded-md bg-black/40 text-xs text-white/70 font-mono backdrop-blur-sm border border-white/10">
                  {formatCallDuration(callDurationSec)}
                </div>

                <Button
                  variant={isCallMuted ? "destructive" : "secondary"}
                  size="icon"
                  className="h-10 w-10 rounded-full shadow-lg border border-white/5"
                  onClick={() => setIsCallMuted((prev) => !prev)}
                >
                  {isCallMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                </Button>
                <Button
                  variant={isVideoEnabled ? "secondary" : "outline"}
                  size="icon"
                  className="h-10 w-10 rounded-full shadow-lg bg-white/10 border-white/10 text-white hover:bg-white/20"
                  onClick={handleToggleLocalVideo}
                >
                  {isVideoEnabled ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
                </Button>
                <Button
                  variant={isScreenSharing ? "secondary" : "outline"}
                  size="icon"
                  className="h-10 w-10 rounded-full shadow-lg bg-white/10 border-white/10 text-white hover:bg-white/20"
                  onClick={handleToggleScreenShare}
                >
                  {isScreenSharing ? <ScreenShareOff className="w-4 h-4" /> : <ScreenShare className="w-4 h-4" />}
                </Button>
                <Button
                  variant={callLiveEnabled ? "secondary" : "outline"}
                  size="sm"
                  className="h-10 rounded-full shadow-lg bg-white/10 border-white/10 text-white hover:bg-white/20 px-4"
                  onClick={handleToggleCallLive}
                >
                  {t("voice.liveTranslationTitle")}
                </Button>
                <Button
                  variant="destructive"
                  size="icon"
                  className="h-10 w-10 rounded-full shadow-lg"
                  onClick={handleEndCall}
                >
                  <PhoneOff className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {/* 3b. Chat & Transcript Area */}
            <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-muted/5 relative">
              {/* Mobile Top Bar */}
              <div className="lg:hidden shrink-0 px-3 py-2 flex items-center justify-between border-b bg-background/80 backdrop-blur z-10">
                <div className="flex items-center gap-2 max-w-[60%]">
                  <div className="flex flex-col">
                    <div className="text-xs font-medium truncate">ID: {roomId}</div>
                    <div className="text-[10px] text-muted-foreground">{users.length} {t("users.title", { count: users.length })}</div>
                  </div>
                  <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={handleCopyRoomId}>
                    <Copy className="w-3 h-3" />
                  </Button>
                </div>
                <div className="flex items-center gap-1">
                  {!isStageVisible && (
                    <Button variant="secondary" size="sm" className="h-7 text-xs" onClick={() => setIsUsersSheetOpen(true)}>
                      <Phone className="w-3 h-3 mr-1.5" />
                      通话
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setIsUsersSheetOpen(true)}>
                    <Users className="w-4 h-4" />
                  </Button>
                  {isAdmin && (
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={openRoomSettings}>
                      <Settings className="w-4 h-4" />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleLeaveRoom}>
                    <LogOut className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {/* Chat Content */}
              <div className="flex-1 min-h-0 relative flex flex-col overflow-hidden">
                <ChatArea
                  variant="embedded"
                  messages={messages}
                  speechRate={settings.speechRate}
                  speechVolume={settings.speechVolume}
                  autoPlay={settings.autoPlayTranslations && callStatus !== "active"}
                  isMobile={isMobile}
                />

                {/* Live Translation Overlay (Floating) */}
                {(isRecording || isProcessing || callStatus === "active") && (
                  (formattedLiveTranslation.trim() || remoteLiveTranslation.trim() || (callStatus === "active" && callLiveEnabled && formattedLiveTranscript.trim()) || (callStatus === "active" && remoteLiveTranscript.trim()) || !liveSpeechSupported)
                ) && (
                    <div className="absolute bottom-32 lg:bottom-4 left-0 right-0 p-4 bg-gradient-to-t from-background via-background/95 to-transparent z-10 pointer-events-none">
                      <div className="w-full max-w-3xl mx-auto bg-card/95 border shadow-lg rounded-xl p-4 pointer-events-auto backdrop-blur animate-in fade-in slide-in-from-bottom-2">
                        {/* Content copied from original logic */}
                        {!liveSpeechSupported ? (
                          <div className="text-xs text-muted-foreground">{t("voice.liveUnsupported")}</div>
                        ) : null}
                        {(callStatus === "active" && callLiveEnabled && liveTranscript.trim()) ? (
                          <div className="mb-4">
                            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                              {userName || "我"}
                            </div>
                            <div className="text-base leading-relaxed whitespace-pre-wrap break-all">
                              <span className="text-foreground font-bold">{confirmedTranscript}</span>
                              <span className={isInterim ? "text-muted-foreground text-sm" : "text-foreground font-bold"}>
                                {liveTranscript.slice(confirmedTranscript.length)}
                              </span>
                            </div>
                          </div>
                        ) : null}
                        {remoteLiveTranslation.trim() ? (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="order-2 md:order-1">
                              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                                {remoteLiveUserName ? `${remoteLiveUserName} · ${t("voice.liveTranslationTitle")}` : t("voice.liveTranslationTitle")}
                              </div>
                              <div className="text-base font-medium leading-relaxed text-primary whitespace-pre-wrap">{remoteLiveTranslation}</div>
                            </div>
                            {remoteLiveTranscript.trim() && (
                              <div className="order-1 md:order-2 opacity-60">
                                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                                  {t("voice.originalTranscript")}
                                </div>
                                <div className="text-sm leading-relaxed text-muted-foreground whitespace-pre-wrap">
                                  <span className="text-foreground font-medium">{remoteConfirmedTranscript}</span>
                                  <span className="opacity-70">{remoteLiveTranscript.slice(remoteConfirmedTranscript.length)}</span>
                                </div>
                              </div>
                            )}
                          </div>
                        ) : callStatus === "active" && remoteLiveTranscript.trim() ? (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="order-2 md:order-1">
                              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                                {remoteLiveUserName ? `${remoteLiveUserName} · ${t("voice.liveTranslationTitle")}` : t("voice.liveTranslationTitle")}
                              </div>
                              <div className="text-sm text-muted-foreground animate-pulse">正在翻译…</div>
                            </div>
                            <div className="order-1 md:order-2 opacity-60">
                              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                                {t("voice.originalTranscript")}
                              </div>
                              <div className="text-sm leading-relaxed text-muted-foreground whitespace-pre-wrap">
                                <span className="text-foreground font-medium">{remoteConfirmedTranscript}</span>
                                <span className="opacity-70">{remoteLiveTranscript.slice(remoteConfirmedTranscript.length)}</span>
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )}
              </div>

              {/* Bottom Controls (Unified Left-Right) */}
              <div className="shrink-0 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,32px))] bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-t z-[100] shadow-[0_-1px_10px_rgba(0,0,0,0.03)] transition-all duration-300 lg:bg-background lg:pb-3 lg:z-auto">
                <div className="max-w-4xl mx-auto flex items-end gap-2">

                  {/* 1. Language Controls (Left) */}
                  <div className="shrink-0 flex items-center bg-secondary/30 rounded-2xl p-1 border border-border/40 h-10 sm:h-12">
                    <Select value={sourceLanguage.code} onValueChange={handleSourceLanguageChange}>
                      <SelectTrigger className="h-full border-0 bg-transparent shadow-none focus:ring-0 px-2 gap-1.5 min-w-[3.5rem] justify-center">
                        <span className="text-base sm:text-lg leading-none">{sourceLanguage.flag}</span>
                        <span className="text-xs font-medium text-muted-foreground hidden sm:inline-block max-w-[4rem] truncate text-left">
                          {sourceLanguage.name}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        {sourceLanguageOptions.map(l => <SelectItem key={l.code} value={l.code}>{l.flag} {l.name}</SelectItem>)}
                      </SelectContent>
                    </Select>

                    <ArrowRightLeft className="w-3 h-3 text-muted-foreground/40 mx-0.5" />

                    <Select value={targetLanguage.code} onValueChange={handleTargetLanguageChange}>
                      <SelectTrigger className="h-full border-0 bg-transparent shadow-none focus:ring-0 px-2 gap-1.5 min-w-[3.5rem] justify-center">
                        <span className="text-base sm:text-lg leading-none">{targetLanguage.flag}</span>
                        <span className="text-xs font-medium text-muted-foreground hidden sm:inline-block max-w-[4rem] truncate text-left">
                          {targetLanguage.name}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        {SUPPORTED_LANGUAGES.map(l => <SelectItem key={l.code} value={l.code}>{l.flag} {l.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* 2. Input Field (Middle - Flex Grow) */}
                  <div className="flex-1 min-w-0 relative group">
                    <Input
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      placeholder={isRecording ? t("voice.listening") : (t("chat.inputPlaceholder") || "Send a message...")}
                      className="h-10 sm:h-12 rounded-2xl pl-4 pr-10 bg-secondary/30 border-transparent focus:bg-background focus:border-primary/20 transition-all shadow-sm text-base"
                      disabled={isRecording}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault()
                          handleSendMessage()
                        }
                      }}
                    />
                    <div className="absolute right-1 top-1 bottom-1 flex items-center">
                      {inputText.trim() && (
                        <Button
                          size="icon"
                          className="h-8 w-8 rounded-xl bg-primary text-primary-foreground shadow-sm hover:scale-105 transition-all"
                          onClick={handleSendMessage}
                          disabled={isProcessing}
                        >
                          <Send className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* 3. Voice Button (Right) */}
                  <div className="shrink-0">
                    <VoiceControls
                      variant="stacked"
                      showHint={false}
                      showStatus={false}
                      buttonSize="w-full h-full"
                      isProcessing={isProcessing}
                      onRecordingComplete={handleRecordingComplete}
                      onRecordingChange={setIsRecording}
                      className="h-10 w-10 sm:h-12 sm:w-12 p-0"
                    />
                  </div>
                </div>

                {/* Optional Hint Overlay */}
                {isRecording && (
                  <div className="absolute -top-10 left-0 right-0 flex justify-center pointer-events-none">
                    <div className="bg-primary/90 backdrop-blur text-primary-foreground text-xs font-medium px-4 py-1.5 rounded-full shadow-lg animate-in slide-in-from-bottom-2 fade-in">
                      {t("voice.hintRelease")}
                    </div>
                  </div>
                )}
              </div>
            </div>

          </div>
        </div>

        {/* Dialogs */}
        <Dialog open={roomSettingsOpen} onOpenChange={setRoomSettingsOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>{t("roomSettings.title")}</DialogTitle></DialogHeader>
            {/* ... settings content ... */}
            <div className="space-y-4 py-4">
              <RadioGroup value={roomSettingsJoinMode} onValueChange={v => setRoomSettingsJoinMode(v as any)}>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="public" id="public" />
                  <Label htmlFor="public">{t("roomSettings.joinModePublic")}</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="password" id="password" />
                  <Label htmlFor="password">{t("roomSettings.joinModePassword")}</Label>
                </div>
              </RadioGroup>
              {roomSettingsJoinMode === "password" && (
                <Input value={roomSettingsPassword} onChange={e => setRoomSettingsPassword(e.target.value)} placeholder="Password" />
              )}
            </div>
            <DialogFooter>
              <Button onClick={saveRoomSettings} disabled={roomSettingsSaving}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Sheet open={isUsersSheetOpen} onOpenChange={setIsUsersSheetOpen}>
          <SheetContent side="left" className="w-[85%] sm:w-[380px] p-0">
            <div className="pt-10 h-full">
              <UserList
                users={users}
                currentUserId={roomUserId}
                adminUserId={roomSettings?.adminUserId ?? null}
                canKick={isAdmin}
                onKick={handleKickUser}
                roomId={roomId}
                onCall={(targetUserId) => {
                  const target = users.find((u) => u.id === targetUserId)
                  if (target) void startOutgoingCall({ id: target.id, name: target.name })
                }}
              />
            </div>
          </SheetContent>
        </Sheet>

        <Dialog open={incomingCallOpen} onOpenChange={(open) => {
          setIncomingCallOpen(open);
          if (!open && callStatusRef.current === "incoming") void handleRejectCall();
        }}>
          <DialogContent className="sm:max-w-[380px] p-6">
            <div className="flex flex-col items-center gap-6 py-4">
              {/* Avatar with Ripple Effect */}
              <div className="relative">
                <div className="absolute -inset-4 rounded-full bg-primary/20 animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite]" />
                <div className="absolute -inset-8 rounded-full bg-primary/10 animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite_200ms]" />
                <Avatar className="w-24 h-24 border-4 border-background relative z-10 shadow-xl">
                  <AvatarImage src={users.find(u => u.id === callPeer?.id)?.avatar} />
                  <AvatarFallback className="text-2xl bg-primary/10 text-primary">
                    {users.find(u => u.id === callPeer?.id)?.name?.slice(0, 1) || "?"}
                  </AvatarFallback>
                </Avatar>
              </div>

              <div className="text-center space-y-1">
                <h3 className="text-xl font-semibold tracking-tight">{t("call.incomingTitle")}</h3>
                <p className="text-base text-muted-foreground font-medium">{callPeer?.name}</p>
              </div>

              <div className="flex gap-4 w-full justify-center mt-2">
                <Button
                  variant="outline"
                  size="lg"
                  className="flex-1 border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive h-12 rounded-full transition-all"
                  onClick={handleRejectCall}
                >
                  {t("call.reject")}
                </Button>
                <Button
                  size="lg"
                  className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground h-12 rounded-full shadow-lg hover:shadow-xl transition-all animate-pulse"
                  onClick={handleAcceptCall}
                >
                  {t("call.accept")}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

      </div>
    </div>
  )
}
