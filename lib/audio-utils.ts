function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const id = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(new DOMException("Aborted", "AbortError"))
    }
    const cleanup = () => {
      clearTimeout(id)
      if (signal) signal.removeEventListener("abort", onAbort)
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true })
  })
}

async function parseErrorMessage(response: Response): Promise<string> {
  const data = (await response.json().catch(() => null)) as { error?: string; message?: string } | null
  return data?.error || data?.message || `请求失败（${response.status}）`
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  try {
    return JSON.parse(text) as T
  } catch {
    const snippet = text.replace(/\s+/g, " ").slice(0, 120).trim()
    const extra = snippet ? `，响应开头：${snippet}` : ""
    throw new Error(`接口返回非 JSON（${response.status}）${extra}`)
  }
}

type WhisperAsrResult = { text?: string }
type WhisperAsrPipeline = (input: Float32Array, options?: Record<string, unknown>) => Promise<WhisperAsrResult>

let whisperPipelinePromise: Promise<WhisperAsrPipeline> | null = null

function isTencentDeploy(): boolean {
  const raw = process.env.NEXT_PUBLIC_DEPLOY_TARGET ?? ""
  return raw.trim().toLowerCase() === "tencent"
}

function getWhisperLanguageHint(value: string): string | undefined {
  const raw = typeof value === "string" ? value.trim() : ""
  if (!raw) return undefined
  const normalized = raw.toLowerCase().replaceAll("_", "-")
  const primary = normalized.split("-")[0] ?? normalized

  if (primary === "zh") return "chinese"
  if (primary === "en") return "english"
  if (primary === "ja") return "japanese"
  if (primary === "ko") return "korean"
  if (primary === "fr") return "french"
  if (primary === "de") return "german"
  if (primary === "es") return "spanish"
  if (primary === "pt") return "portuguese"

  return undefined
}

async function decodeAudioBlobTo16kMonoFloat32(audioBlob: Blob): Promise<Float32Array> {
  const arrayBuffer = await audioBlob.arrayBuffer()
  const AudioContextCtor =
    (globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
    (globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) {
    throw new Error("AudioContext unavailable")
  }

  const audioContext = new AudioContextCtor()
  try {
    const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0))
    const targetSampleRate = 16000
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetSampleRate), targetSampleRate)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start(0)
    const rendered = await offline.startRendering()
    return rendered.getChannelData(0)
  } finally {
    try {
      await audioContext.close()
    } catch { }
  }
}

function writeWavString(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i))
  }
}

export async function resampleTo16k(audioData: Float32Array, originalSampleRate: number): Promise<Float32Array> {
  if (originalSampleRate === 16000) return audioData

  const targetSampleRate = 16000
  const duration = audioData.length / originalSampleRate
  const offlineCtx = new OfflineAudioContext(1, Math.ceil(duration * targetSampleRate), targetSampleRate)

  const buffer = offlineCtx.createBuffer(1, audioData.length, originalSampleRate)
  buffer.getChannelData(0).set(audioData)

  const source = offlineCtx.createBufferSource()
  source.buffer = buffer
  source.connect(offlineCtx.destination)
  source.start()

  const renderedBuffer = await offlineCtx.startRendering()
  return renderedBuffer.getChannelData(0)
}

export function encodeFloat32ToWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  writeWavString(view, 0, "RIFF")
  view.setUint32(4, 36 + samples.length * 2, true)
  writeWavString(view, 8, "WAVE")
  writeWavString(view, 12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeWavString(view, 36, "data")
  view.setUint32(40, samples.length * 2, true)
  let offset = 44
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true)
    offset += 2
  }
  return buffer
}

export function encodeFloat32ToPcm16le(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2)
  const view = new DataView(buffer)
  let offset = 0
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true)
    offset += 2
  }
  return buffer
}

async function convertAudioBlobToWav(audioBlob: Blob): Promise<Blob> {
  const audio = await decodeAudioBlobTo16kMonoFloat32(audioBlob)
  const wavBuffer = encodeFloat32ToWav(audio, 16000)
  return new Blob([wavBuffer], { type: "audio/wav" })
}

export async function convertAudioBlobToPcm16le(audioBlob: Blob): Promise<ArrayBuffer> {
  const audio = await decodeAudioBlobTo16kMonoFloat32(audioBlob)
  return encodeFloat32ToPcm16le(audio)
}

async function getWhisperPipeline(): Promise<WhisperAsrPipeline> {
  if (whisperPipelinePromise) return whisperPipelinePromise

  whisperPipelinePromise = (async () => {
    const { pipeline, env } = await import("@xenova/transformers")

    env.allowLocalModels = false
    env.useBrowserCache = true

    const modelId = process.env.NEXT_PUBLIC_WHISPER_MODEL?.trim() || "Xenova/whisper-tiny"
    const transcriber = (await pipeline("automatic-speech-recognition", modelId)) as unknown as WhisperAsrPipeline
    return transcriber
  })()

  return whisperPipelinePromise
}

export async function transcribeAudio(audioBlob: Blob, language: string): Promise<string> {
  if (audioBlob.size < 1024) {
    return ""
  }
  if (typeof window !== "undefined" && !isTencentDeploy()) {
    try {
      const transcriber = await getWhisperPipeline()
      const audio = await decodeAudioBlobTo16kMonoFloat32(audioBlob)
      const hint = language && language.toLowerCase() !== "auto" ? getWhisperLanguageHint(language) : undefined
      const output = await transcriber(audio, { ...(hint ? { language: hint } : {}), task: "transcribe" })
      const text = typeof output?.text === "string" ? output.text.trim() : ""
      return text
    } catch {
      // fall through to server-side transcription if whisper fails
    }
  }

  let uploadBlob = audioBlob
  let uploadName = "recording.webm"

  // 如果已经是 WAV 格式，则跳过转换，避免重复解码/编码带来的性能损耗和潜在错误
  const isWav = audioBlob.type === "audio/wav" || audioBlob.type === "audio/x-wav"

  if (typeof window !== "undefined" && !isWav) {
    try {
      uploadBlob = await convertAudioBlobToWav(audioBlob)
      uploadName = "recording.wav"
    } catch {
      const normalizedType = String(audioBlob.type || "").toLowerCase()
      if (normalizedType.includes("ogg")) {
        uploadName = "recording.ogg"
      } else if (normalizedType.includes("wav")) {
        uploadName = "recording.wav"
      } else if (normalizedType.includes("mp3") || normalizedType.includes("mpeg")) {
        uploadName = "recording.mp3"
      } else if (normalizedType.includes("m4a") || normalizedType.includes("mp4")) {
        uploadName = "recording.m4a"
      } else if (normalizedType.includes("aac")) {
        uploadName = "recording.aac"
      } else {
        return ""
      }
    }
  } else if (isWav) {
    uploadName = "recording.wav"
  }

  const formData = new FormData()
  formData.append("audio", uploadBlob, uploadName)
  formData.append("language", language)

  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch("/api/transcribe", {
      method: "POST",
      body: formData,
    })

    if (response.ok) {
      const data = await parseJsonResponse<{ text?: unknown }>(response)
      if (typeof data.text === "string") return data.text.trim()
      throw new Error("接口返回异常：缺少 text 字段")
    }

    if (response.status === 429 && attempt < maxAttempts) {
      const delayMs = Math.min(8000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250)
      await sleep(delayMs)
      continue
    }

    const message = await parseErrorMessage(response)
    const normalized = message.toLowerCase()
    if (
      normalized.includes("empty transcription result") ||
      normalized.includes("audio is empty") ||
      normalized.includes("audio data empty") ||
      normalized.includes("audio decoding failed")
    ) {
      return ""
    }
    throw new Error(message || "转写失败")
  }

  throw new Error("转写失败")
}

export async function translateText(
  text: string,
  sourceLanguage: string,
  targetLanguage: string,
  signal?: AbortSignal,
): Promise<string> {
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch("/api/translate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        sourceLanguage,
        targetLanguage,
      }),
      signal,
    })

    if (response.ok) {
      const data = await parseJsonResponse<{ translatedText?: unknown }>(response)
      if (typeof data.translatedText === "string") return data.translatedText
      throw new Error("接口返回异常：缺少 translatedText 字段")
    }

    if (response.status === 429 && attempt < maxAttempts) {
      const delayMs = Math.min(8000, 1200 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250)
      await sleep(delayMs, signal)
      continue
    }

    const message = await parseErrorMessage(response)
    type HttpError = Error & { status?: number }
    const error: HttpError = new Error(message || `翻译失败（${response.status}）`)
    error.status = response.status
    throw error
  }

  type HttpError = Error & { status?: number }
  const error: HttpError = new Error("翻译失败")
  error.status = 500
  throw error
}

export function detectLanguageFromText(text: string): string {
  const value = typeof text === "string" ? text : ""
  const trimmed = value.trim()
  if (!trimmed) return "en-US"
  if (/[\u3040-\u30FF]/.test(trimmed) || /[\u31F0-\u31FF]/.test(trimmed)) return "ja-JP"
  if (/[\p{Script=Han}]/u.test(trimmed)) return "zh-CN"
  if (/[\uAC00-\uD7AF]/.test(trimmed)) return "ko-KR"
  if (/[ñÑáéíóúÁÉÍÓÚ¡¿]/.test(trimmed)) return "es-ES"
  if (/[àâçéèêëîïôùûüÿÀÂÇÉÈÊËÎÏÔÙÛÜŸ]/.test(trimmed)) return "fr-FR"
  if (/[äöüÄÖÜß]/.test(trimmed)) return "de-DE"
  if (/[ãõÃÕáéíóúÁÉÍÓÚçÇ]/.test(trimmed)) return "pt-BR"
  return "en-US"
}
