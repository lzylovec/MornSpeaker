import type { Metadata } from 'next'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import { Analytics } from '@vercel/analytics/next'
import './globals.css'
import Script from "next/script"
import { AuthProvider } from "@/components/auth-provider"
import { I18nProvider } from "@/components/i18n-provider"
import { Toaster as SonnerToaster } from "@/components/ui/sonner"
import { Toaster } from "@/components/ui/toaster"
import { WechatMiniProgramAuthHandler } from "@/components/wechat-mini-program-auth-handler"

export const metadata: Metadata = {
  title: 'MornSpeaker',
  description: 'MornSpeaker - AI 驱动的实时语音翻译应用',
  generator: 'v0.app',
  icons: {
    icon: '/icon.png',
    apple: '/icon.png',
  },
  viewport: {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 1,
    userScalable: false,
    viewportFit: 'cover',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`font-sans ${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
        <AuthProvider>
          <I18nProvider>{children}</I18nProvider>
          <WechatMiniProgramAuthHandler />
        </AuthProvider>
        <Toaster />
        <SonnerToaster />
        {process.env.NEXT_PUBLIC_DEPLOY_TARGET !== 'tencent' && <Analytics />}
        <Script src="https://res.wx.qq.com/open/js/jweixin-1.6.0.js" strategy="afterInteractive" />
      </body>
    </html>
  )
}
