"use client"

import { useState } from "react"
import { UserX, Phone, PhoneOff, VolumeX, Copy, Check, Loader2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { getAutoDetectLabel } from "@/lib/language-display"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"

export type User = {
  id: string
  name: string
  sourceLanguage: string
  targetLanguage: string
  avatar: string
}

type UserListProps = {
  users: User[]
  currentUserId: string
  adminUserId?: string | null
  canKick?: boolean
  onKick?: (targetUserId: string) => void | Promise<void>
  onCall?: (targetUserId: string) => void | Promise<void>
  roomId?: string
  voiceSession?: {
    active: boolean
    hostUserId: string | null
    participantUserIds: string[]
    queueUserIds: string[]
    mutedUserIds: string[]
    maxParticipants: number
  } | null
  voicePrimaryActionLabel?: string
  voicePrimaryActionDisabled?: boolean
  voicePrimaryActionLoading?: boolean
  onVoicePrimaryAction?: () => void | Promise<void>
  onVoiceLeave?: () => void | Promise<void>
  onVoiceEnd?: () => void | Promise<void>
  onVoiceMuteAll?: () => void | Promise<void>
  onVoiceRemoveParticipant?: (targetUserId: string) => void | Promise<void>
  showDirectCallFallback?: boolean
}

export function UserList({
  users,
  currentUserId,
  adminUserId = null,
  canKick = false,
  onKick,
  onCall,
  roomId,
  voiceSession = null,
  voicePrimaryActionLabel,
  voicePrimaryActionDisabled = false,
  voicePrimaryActionLoading = false,
  onVoicePrimaryAction,
  onVoiceLeave,
  onVoiceEnd,
  onVoiceMuteAll,
  onVoiceRemoveParticipant,
  showDirectCallFallback = true,
}: UserListProps) {
  const { t, locale } = useI18n()
  const [copied, setCopied] = useState(false)

  const participantIds = voiceSession?.participantUserIds ?? []
  const queueIds = voiceSession?.queueUserIds ?? []
  const mutedIds = voiceSession?.mutedUserIds ?? []
  const isVoiceActive = Boolean(voiceSession?.active)
  const isVoiceHost = Boolean(voiceSession?.hostUserId && voiceSession.hostUserId === currentUserId)
  const isCurrentUserInVoice = participantIds.includes(currentUserId)
  const isCurrentUserQueued = queueIds.includes(currentUserId)
  const hostName = users.find((u) => u.id === voiceSession?.hostUserId)?.name || null
  const activeParticipants = users.filter((u) => participantIds.includes(u.id))

  const handleCopyInvite = () => {
    if (!roomId) return
    // Assuming the URL structure, or just copy the Room ID
    const url = typeof window !== 'undefined' ? `${window.location.origin}/room/${roomId}` : roomId
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const getLangInfo = (code: string) => {
    if (!code || code === "auto" || code === "自动识别") return { flag: "🌐", label: getAutoDetectLabel(locale) }
    const c = code.toLowerCase()
    if (c.startsWith("zh")) return { flag: "🇨🇳", label: "ZH" }
    if (c.startsWith("en")) return { flag: "🇺🇸", label: "EN" }
    if (c.startsWith("ja")) return { flag: "🇯🇵", label: "JA" }
    if (c.startsWith("ko")) return { flag: "🇰🇷", label: "KO" }
    if (c.startsWith("fr")) return { flag: "🇫🇷", label: "FR" }
    if (c.startsWith("de")) return { flag: "🇩🇪", label: "DE" }
    if (c.startsWith("es")) return { flag: "🇪🇸", label: "ES" }
    if (c.startsWith("ru")) return { flag: "🇷🇺", label: "RU" }
    if (c.startsWith("pt")) return { flag: "🇵🇹", label: "PT" }
    if (c.startsWith("it")) return { flag: "🇮🇹", label: "IT" }
    if (c.startsWith("hi")) return { flag: "🇮🇳", label: "HI" }
    if (c.startsWith("id")) return { flag: "🇮🇩", label: "ID" }
    return { flag: "🌐", label: code.substring(0, 2).toUpperCase() }
  }

  return (
    <Card className="h-full flex flex-col overflow-hidden border-0 shadow-none bg-transparent">
      <CardHeader className="pb-2 px-4 shrink-0">
        <CardTitle className="text-sm font-semibold flex items-center gap-2 text-muted-foreground uppercase tracking-wider">
          {t("users.title", { count: users.length })}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 flex-1 overflow-y-auto min-h-0 px-2 py-3">
        {/* Voice Call Highlight Section */}
        <div className="bg-gradient-to-br from-primary/5 to-primary/0 rounded-xl p-3 border border-primary/10 shadow-sm">
           <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary shadow-sm ring-1 ring-primary/5">
                 <Phone className="w-4 h-4" />
              </div>
              <div>
                 <h3 className="text-sm font-bold text-foreground tracking-tight">{t("voice.sessionTitle")}</h3>
                 <p className="text-[10px] text-muted-foreground font-medium">{t("voice.liveTranslationTitle")}</p>
              </div>
           </div>

           <div className="space-y-2">
             <div className="flex items-center justify-between text-[11px] text-muted-foreground">
               <span>{t("voice.sessionParticipants", { count: participantIds.length, max: voiceSession?.maxParticipants ?? 8 })}</span>
               <span>{t("voice.sessionQueue", { count: queueIds.length })}</span>
             </div>
             {hostName && (
               <div className="text-[11px] text-muted-foreground">
                 {t("voice.sessionHost", { name: hostName })}
               </div>
             )}

             <Button
               variant="default"
               size="sm"
               className="w-full justify-center h-9 text-xs shadow-sm hover:shadow-md transition-all"
               disabled={voicePrimaryActionDisabled || voicePrimaryActionLoading}
               onClick={() => onVoicePrimaryAction && onVoicePrimaryAction()}
             >
               {voicePrimaryActionLoading ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Phone className="w-3.5 h-3.5 mr-1.5" />}
               {voicePrimaryActionLabel || t("voice.sessionStart")}
             </Button>

             {isCurrentUserInVoice && onVoiceLeave && (
               <Button variant="outline" size="sm" className="w-full justify-center h-9 text-xs" onClick={() => onVoiceLeave()}>
                 <PhoneOff className="w-3.5 h-3.5 mr-1.5" />
                 {t("voice.sessionLeave")}
               </Button>
             )}

             {isVoiceHost && isVoiceActive && (
               <div className="grid grid-cols-2 gap-2">
                 <Button variant="outline" size="sm" className="h-8 text-[11px]" onClick={() => onVoiceMuteAll && onVoiceMuteAll()}>
                   <VolumeX className="w-3.5 h-3.5 mr-1" />
                   {t("voice.sessionMuteAll")}
                 </Button>
                 <Button variant="destructive" size="sm" className="h-8 text-[11px]" onClick={() => onVoiceEnd && onVoiceEnd()}>
                   <PhoneOff className="w-3.5 h-3.5 mr-1" />
                   {t("voice.sessionEnd")}
                 </Button>
               </div>
             )}

             {isCurrentUserQueued && (
               <div className="text-[11px] text-amber-600 bg-amber-500/10 border border-amber-500/20 rounded-md px-2 py-1">
                 {t("voice.sessionQueued")}
               </div>
             )}

             {!isVoiceActive && users.length <= 1 && (
               <div className="text-center py-1">
                 <p className="text-xs text-muted-foreground/80 mb-2 font-medium">{t("roomJoin.roomIdHelp")}</p>
                 {roomId && (
                   <Button variant="outline" size="sm" className="w-full h-8 text-xs gap-2 bg-background/80 hover:bg-background border-dashed" onClick={handleCopyInvite}>
                     {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                     {copied ? t("common.copied") : t("common.copy")}
                   </Button>
                 )}
               </div>
             )}

             {isVoiceActive && activeParticipants.length > 0 && (
               <div className="space-y-1 rounded-lg border border-border/50 bg-background/70 p-2">
                 {activeParticipants.map((participant) => {
                   const isMuted = mutedIds.includes(participant.id)
                   const canRemove = isVoiceHost && participant.id !== currentUserId && onVoiceRemoveParticipant
                   return (
                     <div key={`voice-member-${participant.id}`} className="flex items-center justify-between gap-2 text-[11px]">
                       <span className="truncate">
                         {participant.name}
                         {participant.id === voiceSession?.hostUserId ? ` (${t("voice.sessionHostShort")})` : ""}
                         {isMuted ? ` · ${t("voice.sessionMuted")}` : ""}
                       </span>
                       {canRemove && (
                         <Button
                           variant="ghost"
                           size="icon"
                           className="h-6 w-6"
                           onClick={() => onVoiceRemoveParticipant(participant.id)}
                           aria-label={t("voice.sessionRemove")}
                         >
                           <PhoneOff className="w-3 h-3" />
                         </Button>
                       )}
                     </div>
                   )
                 })}
               </div>
             )}

             {showDirectCallFallback && users.length > 1 && onCall && (
               <div className="space-y-1 pt-1">
                 <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70">{t("voice.directFallback")}</div>
                 {users.filter((u) => u.id !== currentUserId).slice(0, 8).map((u) => (
                   <Button
                     key={`call-${u.id}`}
                     variant="secondary"
                     size="sm"
                     className="w-full justify-between h-8 text-[11px]"
                     disabled={isVoiceActive}
                     onClick={() => onCall(u.id)}
                   >
                     <span className="truncate max-w-[120px]">{u.name}</span>
                     <Phone className="w-3 h-3 ml-1" />
                   </Button>
                 ))}
               </div>
             )}
           </div>
        </div>

        <div className="space-y-2">
            <h4 className="text-[10px] font-bold text-muted-foreground/70 uppercase tracking-wider px-1">{t("users.title", { count: users.length })}</h4>
            <div className="space-y-1">
              {users.map((user) => {
                const source = getLangInfo(user.sourceLanguage)
                const target = user.targetLanguage ? getLangInfo(user.targetLanguage) : null
                
                return (
                  <div key={user.id} className="group flex items-center gap-3 p-2 rounded-xl hover:bg-muted/60 transition-all duration-200">
                    <div className="relative shrink-0">
                      <Avatar className="w-10 h-10 border-2 border-background shadow-sm">
                        <AvatarImage src={user.avatar || "/placeholder.svg"} alt={user.name} />
                        <AvatarFallback className="bg-primary/5 text-primary text-xs font-bold">
                          {user.name[0]?.toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      {/* Online Status Indicator */}
                      <span className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-background rounded-full shadow-sm ring-1 ring-background" />
                    </div>
                    
                    <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5">
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-semibold truncate text-foreground/90">
                          {user.name}
                        </p>
                        {user.id === currentUserId && (
                          <Badge variant="secondary" className="h-4 px-1 text-[10px] rounded-md font-medium text-muted-foreground/80 bg-muted">
                            {t("users.you")}
                          </Badge>
                        )}
                        {adminUserId && user.id === adminUserId && (
                          <Badge variant="secondary" className="h-4 px-1 text-[10px] rounded-md font-medium text-amber-600/80 bg-amber-500/10">
                            ADMIN
                          </Badge>
                        )}
                      </div>
                      
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground/80">
                        <span className="flex items-center gap-1 bg-muted/40 px-1.5 py-0.5 rounded-md border border-border/40">
                          <span className="text-[10px]">{source.flag}</span>
                          <span className="font-medium text-[10px]">{source.label}</span>
                        </span>
                        {target && (
                          <>
                            <span className="text-muted-foreground/40">→</span>
                            <span className="flex items-center gap-1 bg-muted/40 px-1.5 py-0.5 rounded-md border border-border/40">
                              <span className="text-[10px]">{target.flag}</span>
                              <span className="font-medium text-[10px]">{target.label}</span>
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {canKick && onKick && user.id !== currentUserId && (!adminUserId || user.id !== adminUserId) && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button 
                              variant="ghost" 
                              size="icon" 
                              className="h-8 w-8 rounded-full text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-all"
                              aria-label={t("users.kick")}
                            >
                              <UserX className="w-4 h-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>{t("users.kickConfirmTitle")}</AlertDialogTitle>
                              <AlertDialogDescription>{t("users.kickConfirmDesc")}</AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={(e) => {
                                  e.preventDefault()
                                  void onKick(user.id)
                                }}
                                className="bg-red-600 hover:bg-red-700"
                              >
                                {t("users.kick")}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
        </div>
      </CardContent>
    </Card>
  )
}
