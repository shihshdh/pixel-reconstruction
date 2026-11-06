import type { Metadata, Viewport } from "next";
import "./globals.css";
import { HEAD_CLEAN, INTRO_BOOT } from "@/lib/intro";

export const metadata: Metadata = {
  icons: { icon: '/brand/mark.svg', apple: '/brand/apple-touch-icon.png' },
  title: "Pixel Reconstruction",
  description:
    "Pixel Reconstruction：上传一张照片，用 Apple SHARP 高斯泼溅生成三维场景，并渲染电影感运镜动画。",
};

// Safari（iOS）的状态栏和底部工具栏颜色：不声明时它取页面顶部的颜色，深色主题下会被光追背景染成橙色。
// 站内切换主题时 app/page.tsx 会把它改成当前主题的底色。
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
};

const beamBase = (process.env.NEXT_PUBLIC_BEAM_API || process.env.NEXT_PUBLIC_API_URL || "").trim();
const beamOrigin = (() => { try { return new URL(beamBase).origin; } catch { return null; } })();

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // The boot script marks <html> before first paint, so it is expected to differ from the server markup.
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {beamOrigin && <link rel="preconnect" href={beamOrigin} />}
        {/* Arms the opening title before first paint (each full page load). */}
        <script dangerouslySetInnerHTML={{ __html: HEAD_CLEAN }} />
        <script dangerouslySetInnerHTML={{ __html: INTRO_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

