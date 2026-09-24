import type { Metadata } from "next";
import "./globals.css";
import { HEAD_CLEAN, INTRO_BOOT } from "@/lib/intro";

export const metadata: Metadata = {
  icons: { icon: '/brand/mark.svg', apple: '/brand/apple-touch-icon.png' },
  title: "Pixel Reconstruction",
  description:
    "Pixel Reconstruction：上传一张照片，用 Apple SHARP 高斯泼溅生成三维场景，并渲染电影感运镜动画。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // The boot script marks <html> before first paint, so it is expected to differ from the server markup.
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* Arms the opening title before first paint (once per tab session). */}
        <script dangerouslySetInnerHTML={{ __html: HEAD_CLEAN }} />
        <script dangerouslySetInnerHTML={{ __html: INTRO_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

