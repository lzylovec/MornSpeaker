interface ASROptions {
  audioTrack?: MediaStreamTrack
  engineModelType?: string
  OnRecognitionStart?: (res: any) => void
  OnSentenceBegin?: (res: any) => void
  OnRecognitionResultChange?: (res: any) => void
  OnSentenceEnd?: (res: any) => void
  OnRecognitionComplete?: (res: any) => void
  OnError?: (error: any) => void
}

export class TencentASR {
  private audioTrack?: MediaStreamTrack
  private callbacks: Omit<ASROptions, "audioTrack">
  private ws: WebSocket | null = null
  private audioContext: AudioContext | null = null
  private processor: ScriptProcessorNode | null = null
  private mediaStreamSource: MediaStreamAudioSourceNode | null = null
  private isRunning = false
  private isConnecting = false
  private shouldReconnect = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private readonly maxReconnectAttempts = 5
  private readonly targetSampleRate = 16000
  private inputSampleRate = 16000
  private readonly engineModelType: string
  private audioBuffer: Int16Array[] = []
  private audioBufferLen = 0
  private readonly maxBufferedSamples = 16000 * 8

  constructor(options: ASROptions) {
    this.audioTrack = options.audioTrack
    this.engineModelType = (options.engineModelType || "16k_zh").trim() || "16k_zh"
    this.callbacks = {
      OnRecognitionStart: options.OnRecognitionStart,
      OnSentenceBegin: options.OnSentenceBegin,
      OnRecognitionResultChange: options.OnRecognitionResultChange,
      OnSentenceEnd: options.OnSentenceEnd,
      OnRecognitionComplete: options.OnRecognitionComplete,
      OnError: options.OnError,
    }
  }

  async start() {
    if (this.isRunning || this.isConnecting) return
    this.isRunning = true
    this.shouldReconnect = true
    this.reconnectAttempts = 0
    await this.connect()
  }

  feedAudio(pcm16: Int16Array) {
    if (!(pcm16 instanceof Int16Array) || pcm16.length === 0) return
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(pcm16.buffer.slice(0))
      return
    }
    this.enqueueAudio(pcm16)
  }

  private async connect() {
    if (!this.isRunning || this.isConnecting) return
    this.isConnecting = true

    try {
      const params = new URLSearchParams({
        engineModelType: this.engineModelType,
        voiceFormat: "1",
        needVad: "1",
      })
      const res = await fetch(`/api/asr/realtime?${params.toString()}`)
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null

      if (!res.ok) {
        console.error("ASR Signature Error:", data)
        throw new Error("Failed to get ASR signature")
      }

      const wsUrlRaw = data?.url ?? data?.wsUrl
      const wsUrl = typeof wsUrlRaw === "string" ? wsUrlRaw.trim() : ""
      if (!wsUrl) {
        throw new Error("Missing ASR websocket URL")
      }

      console.log("Connecting to ASR URL:", wsUrl)
      this.ws = new WebSocket(wsUrl)

      this.ws.onopen = () => {
        this.isConnecting = false
        this.reconnectAttempts = 0
        this.callbacks.OnRecognitionStart?.({ code: 0, message: "Connected" })
        this.flushAudioBuffer()
      }

      this.ws.onerror = (event) => {
        this.callbacks.OnError?.(event)
      }

      this.ws.onclose = () => {
        this.ws = null
        this.isConnecting = false
        if (!this.isRunning || !this.shouldReconnect) return
        this.scheduleReconnect()
      }

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string)
          if (message.code !== 0) {
            this.callbacks.OnError?.(message)
            return
          }
          const result = (message.result ?? {}) as Record<string, unknown>
          const hasText = typeof result.voice_text_str === "string" || typeof message.voice_text_str === "string"
          if (!hasText) return
          if (message.final === 1 || result.final === 1) {
            this.callbacks.OnSentenceEnd?.({ result: message.result })
            return
          }
          this.callbacks.OnRecognitionResultChange?.({ result: message.result })
        } catch (err) {
          console.error("Failed to parse ASR message", err)
        }
      }

      this.initAudioProcessing()
    } catch (err) {
      this.isConnecting = false
      this.callbacks.OnError?.(err)
      if (!this.isRunning || !this.shouldReconnect) {
        this.isRunning = false
        return
      }
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || !this.isRunning || !this.shouldReconnect) return
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.callbacks.OnError?.(new Error("ASR disconnected after max reconnect attempts"))
      this.stop()
      return
    }
    this.reconnectAttempts += 1
    const delayMs = Math.min(6000, 500 * 2 ** (this.reconnectAttempts - 1))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delayMs)
  }

  private initAudioProcessing() {
    if (!this.audioTrack) return
    if (this.audioContext && this.processor && this.mediaStreamSource) return

    try {
      const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
      try {
        this.audioContext = new AudioContextCtor({ sampleRate: this.targetSampleRate })
      } catch {
        this.audioContext = new AudioContextCtor()
      }
      this.inputSampleRate = this.audioContext.sampleRate || this.targetSampleRate
      this.mediaStreamSource = this.audioContext.createMediaStreamSource(new MediaStream([this.audioTrack]))
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1)

      this.processor.onaudioprocess = (event) => {
        if (!this.isRunning) return
        const inputData = event.inputBuffer.getChannelData(0)
        const intData = this.resampleFloat32ToInt16(inputData, this.inputSampleRate, this.targetSampleRate)
        this.feedAudio(intData)
      }

      this.mediaStreamSource.connect(this.processor)
      this.processor.connect(this.audioContext.destination)
    } catch (err) {
      this.callbacks.OnError?.(err)
    }
  }

  private resampleFloat32ToInt16(input: Float32Array, inputRate: number, outputRate: number) {
    if (!(input instanceof Float32Array) || input.length === 0) {
      return new Int16Array(0)
    }

    if (!Number.isFinite(inputRate) || inputRate <= 0 || !Number.isFinite(outputRate) || outputRate <= 0) {
      const direct = new Int16Array(input.length)
      for (let i = 0; i < input.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, input[i] ?? 0))
        direct[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      }
      return direct
    }

    if (Math.abs(inputRate - outputRate) < 1) {
      const direct = new Int16Array(input.length)
      for (let i = 0; i < input.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, input[i] ?? 0))
        direct[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      }
      return direct
    }

    const ratio = inputRate / outputRate
    const newLength = Math.max(1, Math.floor(input.length / ratio))
    const output = new Int16Array(newLength)
    let offsetResult = 0
    let offsetBuffer = 0

    while (offsetResult < newLength) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio)
      let accum = 0
      let count = 0
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i += 1) {
        accum += input[i] ?? 0
        count += 1
      }
      const sample = count > 0 ? accum / count : input[Math.min(offsetBuffer, input.length - 1)] ?? 0
      const clamped = Math.max(-1, Math.min(1, sample))
      output[offsetResult] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
      offsetResult += 1
      offsetBuffer = nextOffsetBuffer
    }

    return output
  }

  private enqueueAudio(chunk: Int16Array) {
    this.audioBuffer.push(chunk)
    this.audioBufferLen += chunk.length
    if (this.audioBufferLen <= this.maxBufferedSamples) return

    while (this.audioBuffer.length > 0 && this.audioBufferLen > this.maxBufferedSamples) {
      const dropped = this.audioBuffer.shift()
      if (!dropped) break
      this.audioBufferLen -= dropped.length
    }
  }

  private flushAudioBuffer() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    while (this.audioBuffer.length > 0) {
      const chunk = this.audioBuffer.shift()
      if (!chunk) break
      this.audioBufferLen -= chunk.length
      this.ws.send(chunk.buffer.slice(0))
    }
    this.audioBufferLen = Math.max(0, this.audioBufferLen)
  }

  stop() {
    this.isRunning = false
    this.shouldReconnect = false
    this.isConnecting = false
    this.reconnectAttempts = 0
    this.audioBuffer = []
    this.audioBufferLen = 0

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.processor) {
      this.processor.disconnect()
      this.processor.onaudioprocess = null
      this.processor = null
    }

    if (this.mediaStreamSource) {
      this.mediaStreamSource.disconnect()
      this.mediaStreamSource = null
    }

    if (this.audioContext) {
      void this.audioContext.close().catch(() => null)
      this.audioContext = null
    }

    if (this.ws) {
      this.ws.onopen = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.onmessage = null
      this.ws.close()
      this.ws = null
    }
  }
}
