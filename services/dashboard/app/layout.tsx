import type { Metadata } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import ThemeProvider from '@/components/shared/ThemeProvider'
import SiteHeader from '@/components/shared/SiteHeader'
import ScrollToTop from '@/components/shared/ScrollToTop'
import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' })

export const metadata: Metadata = {
  title: 'AZ-Lab Home',
  description: 'Home dashboard',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} ${jetbrainsMono.variable} font-sans text-zinc-100 antialiased min-h-screen`}>
        <ThemeProvider>
          <SiteHeader />
          {children}
          <ScrollToTop />
        </ThemeProvider>
      </body>
    </html>
  )
}
