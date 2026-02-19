'use client'

import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"
import { Switch } from "@/components/ui/switch"
import { setTrtcEnabled } from "@/app/admin/actions"

export function TrtcToggle({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    setEnabled(initialEnabled)
  }, [initialEnabled])

  return (
    <div className="flex items-center justify-between gap-4 rounded-md border bg-white px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">TRTC 字幕增强引擎</div>
        <div className="text-xs text-muted-foreground">
          仅控制字幕翻译引擎：开启时使用 TRTC 转写翻译（成本较高），关闭时使用标准转写翻译方案。语音通话和视频能力始终可用。
        </div>
      </div>
      <Switch
        checked={enabled}
        disabled={isPending}
        onCheckedChange={(next) => {
          setEnabled(next)
          startTransition(async () => {
            const res = await setTrtcEnabled(next)
            if (res.success) {
              toast.success(next ? "已启用 TRTC 字幕增强引擎" : "已切换为标准字幕翻译引擎")
              return
            }
            setEnabled(!next)
            toast.error(res.error ? `设置失败：${res.error}` : "设置失败")
          })
        }}
      />
    </div>
  )
}
