import type { UiLocale } from "@/lib/i18n"
import { getHtmlLang } from "@/lib/i18n"

const FALLBACK_LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  zh: "Chinese",
  ja: "Japanese",
  es: "Spanish",
  fr: "French",
  de: "German",
  ko: "Korean",
  pt: "Portuguese",
}

const AUTO_DETECT_LABELS: Record<UiLocale, string> = {
  zh: "自动识别",
  en: "Auto Detect",
  ja: "自動検出",
  es: "Deteccion automatica",
  fr: "Detection auto",
  de: "Automatische Erkennung",
  ko: "자동 감지",
  pt: "Deteccao automatica",
}

const LANGUAGE_NAME_ALIASES: Record<string, string> = {
  english: "en",
  chinese: "zh",
  japanese: "ja",
  spanish: "es",
  french: "fr",
  german: "de",
  korean: "ko",
  portuguese: "pt",
  "英语": "en",
  "中文": "zh",
  "日语": "ja",
  "西班牙语": "es",
  "法语": "fr",
  "德语": "de",
  "韩语": "ko",
  "葡萄牙语": "pt",
  "自动识别": "auto",
}

const displayNamesCache = new Map<UiLocale, Intl.DisplayNames | null>()

function getDisplayNames(locale: UiLocale): Intl.DisplayNames | null {
  if (displayNamesCache.has(locale)) {
    return displayNamesCache.get(locale) ?? null
  }

  try {
    const displayNames = new Intl.DisplayNames([getHtmlLang(locale)], { type: "language" })
    displayNamesCache.set(locale, displayNames)
    return displayNames
  } catch {
    displayNamesCache.set(locale, null)
    return null
  }
}

export function getAutoDetectLabel(locale: UiLocale): string {
  return AUTO_DETECT_LABELS[locale] ?? AUTO_DETECT_LABELS.en
}

export function resolveLanguageAlias(value: string): string {
  const trimmed = String(value || "").trim()
  if (!trimmed) return ""

  const lower = trimmed.toLowerCase()
  const directAlias = LANGUAGE_NAME_ALIASES[lower]
  if (directAlias) return directAlias

  const exactAlias = LANGUAGE_NAME_ALIASES[trimmed]
  if (exactAlias) return exactAlias

  return trimmed
}

function toPrimaryLanguageCode(value: string): string {
  const resolved = resolveLanguageAlias(value)
  if (!resolved) return ""
  const normalized = resolved.replace(/_/g, "-").trim().toLowerCase()
  if (normalized === "auto") return "auto"
  return normalized.split("-")[0]
}

export function getLocalizedLanguageName(value: string, locale: UiLocale): string {
  const original = String(value || "").trim()
  if (!original) return ""

  const primaryCode = toPrimaryLanguageCode(original)
  if (!primaryCode) return original
  if (primaryCode === "auto") return getAutoDetectLabel(locale)

  const displayNames = getDisplayNames(locale)
  const localized = displayNames?.of(primaryCode)
  if (typeof localized === "string" && localized.trim() && localized.toLowerCase() !== primaryCode) {
    return localized
  }

  return FALLBACK_LANGUAGE_NAMES[primaryCode] ?? original
}
