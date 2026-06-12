import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "入画 · 一张照片显影成三维场景",
  description:
    "上传一张照片，用 Apple SHARP 高斯泼溅生成 3D 场景，并渲染电影感运镜动画。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
