"use client"

import { ScrollArea } from "@/components/ui/scroll-area"
import { SUPPORTED_LANGUAGES, type Message } from "@/components/voice-chat-interface"
import { ArrowUp, Volume2, VolumeX } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { useTextToSpeech } from "@/hooks/use-text-to-speech"
import { useState, useEffect, useRef } from "react"
import { useI18n } from "@/components/i18n-provider"
import { getHtmlLang } from "@/lib/i18n"

type ChatAreaProps = {
  messages: Message[]
  speechRate?: number
  speechVolume?: number
  autoPlay?: boolean
  variant?: "panel" | "embedded"
  isMobile?: boolean
}

export function ChatArea({
  messages,
  speechRate = 0.9,
  speechVolume = 1.0,
  autoPlay = false,
  variant = "panel",
  isMobile = false,
}: ChatAreaProps) {
  const { speak, stop, isSpeaking } = useTextToSpeech({ rate: speechRate, volume: speechVolume })
  const { locale, t } = useI18n()
  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null)
  const [hasAudio, setHasAudio] = useState(false)
  const [showScrollToTop, setShowScrollToTop] = useState(false)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const lastMessageIdRef = useRef<string | null>(null)
  const shouldAutoScrollRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const autoScrollLockedRef = useRef(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const lastMessage = messages[messages.length - 1]
  const lastMessageId = lastMessage?.id
  const lastMessageIsUser = lastMessage?.isUser === true
  const isEmbedded = variant === "embedded"
  const useNativeScroll = isMobile || isEmbedded

  const getLanguageLabel = (value: string): string => {
    const byCode = SUPPORTED_LANGUAGES.find((l) => l.code === value)
    if (byCode) return byCode.name
    const byName = SUPPORTED_LANGUAGES.find((l) => l.name === value)
    if (byName) return byName.name
    return value
  }

  const getSpeechLanguageCode = (value: string): string => {
    const byCode = SUPPORTED_LANGUAGES.find((l) => l.code === value)
    if (byCode) return byCode.code
    const byName = SUPPORTED_LANGUAGES.find((l) => l.name === value)
    if (byName) return byName.code
    return "en-US"
  }

  const getPrimaryPlayId = (message: Message) => {
    if (message.isUser && message.audioUrl) return `${message.id}-original`
    return `${message.id}-translated`
  }

  const isMessagePlaying = (message: Message) => {
    const targetId = getPrimaryPlayId(message)
    if (playingMessageId !== targetId) return false
    if (message.isUser && message.audioUrl) return hasAudio
    return isSpeaking
  }

  const playAudioUrl = (targetId: string, url: string) => {
    stop()
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      setHasAudio(false)
    }
    const audio = new Audio(url)
    audioRef.current = audio
    setHasAudio(true)
    setPlayingMessageId(targetId)
    audio.onended = () => {
      if (audioRef.current === audio) {
        audioRef.current = null
        setHasAudio(false)
        setPlayingMessageId(null)
      }
    }
    audio.onerror = () => {
      if (audioRef.current === audio) {
        audioRef.current = null
        setHasAudio(false)
        setPlayingMessageId(null)
      }
    }
    audio.play().catch(() => {
      if (audioRef.current === audio) {
        audioRef.current = null
        setHasAudio(false)
        setPlayingMessageId(null)
      }
    })
  }

  useEffect(() => {
    const root = scrollAreaRef.current
    if (!root) return
    const viewport = useNativeScroll
      ? root
      : root.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]')
    if (!viewport) return

    const update = () => {
      const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      const goingUp = viewport.scrollTop < lastScrollTopRef.current
      lastScrollTopRef.current = viewport.scrollTop
      if (goingUp) {
        autoScrollLockedRef.current = true
        shouldAutoScrollRef.current = false
      } else if (distanceToBottom < 150) {
        autoScrollLockedRef.current = false
        shouldAutoScrollRef.current = true
      }
      const nextShow = viewport.scrollTop > 200
      setShowScrollToTop((prev) => (prev === nextShow ? prev : nextShow))
    }

    update()
    viewport.addEventListener("scroll", update, { passive: true })
    return () => viewport.removeEventListener("scroll", update)
  }, [useNativeScroll])

  const handleScrollToTop = () => {
    const root = scrollAreaRef.current
    if (!root) return
    const viewport = useNativeScroll
      ? root
      : root.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]')
    if (!viewport) return
    viewport.scrollTo({ top: 0, behavior: "smooth" })
  }

  const lastMessageContent = lastMessage ? lastMessage.originalText + lastMessage.translatedText : ""

  useEffect(() => {
    if (autoScrollLockedRef.current) return
    if (!shouldAutoScrollRef.current && !lastMessageIsUser) return

    const scrollToBottom = () => {
      const root = scrollAreaRef.current
      if (!root) return
      const viewport = useNativeScroll
        ? root
        : root.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]')
      if (!viewport) return

      // Use requestAnimationFrame to ensure layout is ready
      requestAnimationFrame(() => {
        try {
          viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" })
        } catch {
          viewport.scrollTop = viewport.scrollHeight
        }
      })
    }

    scrollToBottom()
    // Double scroll to ensure layout updates are caught (common fix for mobile/dynamic content)
    const timer = setTimeout(scrollToBottom, 100)
    return () => clearTimeout(timer)
  }, [messages.length, lastMessageId, lastMessageIsUser, lastMessageContent, useNativeScroll])

  // 自动播放已禁用：只有用户点击时才播放，进入房间时不会自动播放
  // 保留此 effect 用于跟踪最后一条消息 ID，但不触发自动播放
  useEffect(() => {
    if (messages.length > 0) {
      lastMessageIdRef.current = messages[messages.length - 1].id
    }
  }, [messages])

  const handlePlayTranslated = (message: Message) => {
    const targetId = getPrimaryPlayId(message)
    if (message.isUser && message.audioUrl) {
      if (playingMessageId === targetId && audioRef.current) {
        audioRef.current.pause()
        audioRef.current.currentTime = 0
        audioRef.current = null
        setPlayingMessageId(null)
        return
      }
      playAudioUrl(targetId, message.audioUrl)
      return
    }
    if (playingMessageId === targetId && isSpeaking) {
      stop()
      setPlayingMessageId(null)
    } else {
      stop()
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.currentTime = 0
        audioRef.current = null
        setHasAudio(false)
      }
      const languageCode = getSpeechLanguageCode(message.targetLanguage)
      speak(message.translatedText, languageCode)
      setPlayingMessageId(targetId)
    }
  }

  const handlePlayOriginal = (message: Message) => {
    if (!message.audioUrl) return
    const targetId = `${message.id}-original`
    if (playingMessageId === targetId && audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      audioRef.current = null
      setHasAudio(false)
      setPlayingMessageId(null)
      return
      return
    }
    playAudioUrl(targetId, message.audioUrl)
  }

  const formatTime = (date: Date) => {
    return new Intl.DateTimeFormat(getHtmlLang(locale), {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(date)
  }

  if (messages.length === 0) {
    return (
      <div
        className={
          isEmbedded
            ? "flex-1 flex items-center justify-center px-4 py-8"
            : "flex-1 flex items-center justify-center bg-card rounded-xl border border-border"
        }
      >
        <div className="text-center max-w-md px-4">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3">
            <Volume2 className="w-8 h-8 text-primary" />
          </div>
          <h2 className="text-xl font-semibold text-foreground mb-2">{t("chat.empty.title")}</h2>
          <p className="text-muted-foreground leading-relaxed">{t("chat.empty.desc")}</p>
        </div>
      </div>
    )
  }

  if (useNativeScroll) {
    return (
      <div
        className={isEmbedded ? "flex-1 min-h-0 h-full px-3 py-2 overflow-y-auto overscroll-y-auto touch-pan-y" : "flex-1 min-h-0 h-full bg-card rounded-xl border border-border p-4 overflow-y-auto overscroll-y-auto touch-pan-y"}
        ref={scrollAreaRef}
        style={{ WebkitOverflowScrolling: "touch", overscrollBehaviorY: "auto" }}
      >
        {renderContent()}
      </div>
    )
  }

  return (
    <ScrollArea
      className={isEmbedded ? "flex-1 min-h-0 px-3 py-2" : "flex-1 min-h-0 bg-card rounded-xl border border-border p-4"}
      ref={scrollAreaRef}
    >
      {renderContent()}
    </ScrollArea>
  )

  function renderContent() {
    return (
      <>
        {showScrollToTop && (
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="absolute top-2 right-2 z-10 h-9 w-9 shadow-sm"
            onClick={handleScrollToTop}
            aria-label={t("common.backToTop")}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        )}
        <div className={isEmbedded ? "space-y-3 pb-6" : "space-y-4"}>
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.isUser ? "justify-end" : "justify-start"} animate-in fade-in slide-in-from-bottom-2 duration-300`}
            >
              {!message.isUser && (
                <Avatar className="w-8 h-8 mr-2 mt-1">
                  <AvatarImage src={message.userAvatar || "/placeholder.svg"} alt={message.userName} />
                  <AvatarFallback>{message.userName[0]?.toUpperCase()}</AvatarFallback>
                </Avatar>
              )}

              <div
              className={`max-w-[88%] md:max-w-[85%] lg:max-w-[82%] rounded-xl transition-all ${isEmbedded ? "p-3" : "p-4"
                  } ${message.isUser ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"} ${isMessagePlaying(message) ? "ring-2 ring-primary/50 animate-pulse" : ""
                  } cursor-pointer`}
              onClick={() => {
                handlePlayTranslated(message)
              }}
              role="button"
              tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    handlePlayTranslated(message)
                  }
                }}
              >
                {!message.isUser && <p className="text-xs font-semibold mb-2 opacity-70">{message.userName}</p>}

                <div className="flex items-start justify-between gap-2 mb-2">
                  <p className="text-sm font-medium opacity-80">
                    {getLanguageLabel(message.originalLanguage)} → {getLanguageLabel(message.targetLanguage)}
                  </p>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 -mt-1 hover:bg-background/20"
                    onClick={(event) => {
                      event.stopPropagation()
                      handlePlayTranslated(message)
                    }}
                  >
                    {isMessagePlaying(message) ? (
                      <VolumeX className="w-4 h-4" />
                    ) : (
                      <Volume2 className="w-4 h-4" />
                    )}
                  </Button>
                </div>
                <p className="text-base leading-relaxed">{message.translatedText}</p>
                {!message.isUser && (
                  <div
                    className="mt-3 rounded-lg border border-border/40 bg-background/40 px-3 py-2 cursor-pointer"
                    role={message.audioUrl ? "button" : undefined}
                    tabIndex={message.audioUrl ? 0 : -1}
                    onClick={(event) => {
                      event.stopPropagation()
                      handlePlayOriginal(message)
                    }}
                    onKeyDown={(event) => {
                      if (!message.audioUrl) return
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        handlePlayOriginal(message)
                      }
                    }}
                  >
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <p className="text-xs font-medium opacity-80">{getLanguageLabel(message.originalLanguage)}</p>
                      {message.audioUrl ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 -mt-1 hover:bg-background/20"
                          onClick={(event) => {
                            event.stopPropagation()
                            handlePlayOriginal(message)
                          }}
                        >
                          {playingMessageId === `${message.id}-original` ? (
                            <VolumeX className="w-4 h-4" />
                          ) : (
                            <Volume2 className="w-4 h-4" />
                          )}
                        </Button>
                      ) : null}
                    </div>
                    <p className="text-sm leading-relaxed opacity-90">{message.originalText}</p>
                  </div>
                )}
                <div className="mt-2 text-xs opacity-60 text-right">{formatTime(message.timestamp)}</div>
              </div>

              {message.isUser && (
                <Avatar className="w-8 h-8 ml-2 mt-1">
                  <AvatarImage src={message.userAvatar || "/placeholder.svg"} alt={message.userName} />
                  <AvatarFallback>{message.userName[0]?.toUpperCase()}</AvatarFallback>
                </Avatar>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </>
    )
  }
}
