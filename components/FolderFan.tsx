'use client';

// 首页「走过的地方」里的文件夹：展示场景的照片卡插在里面只露出顶边。
// 鼠标进入文件夹，卡片带回弹地向上扇形展开；指到哪张，哪张再抬起来、换白边、阴影加深。
// 前袋是磨砂玻璃，卡片下半截在玻璃后面若隐若现。背后是一行充气质感的大字。
// 每张卡的展开位置只由序号 k（-2…2）算出，写进 CSS 变量，动画全部交给 CSS transition。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { prefersReduced } from "@/lib/motion";
import styles from "./FolderFan.module.css";

export type FolderCard = { key: string; title: string; tag?: string; thumb: ReactNode };

export default function FolderFan({ cards, label, note, word = "welcome", onOpen, onOpenCard }: { cards: FolderCard[]; label: string; note: string; word?: string; onOpen: () => void; onOpenCard: (key: string) => void }) {
  const n = cards.length, mid = (n - 1) / 2;
  // 背景大字第一次进入视口时，从左到右顺着书写方向写出来（只写一次）
  const stageRef = useRef<HTMLDivElement>(null);
  const [written, setWritten] = useState(false);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    if (prefersReduced()) { setWritten(true); return; }
    const io = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { setWritten(true); io.disconnect(); } }, { threshold: .35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={stageRef} className={styles.stage}>
    <span className={styles.puff} data-written={written || undefined} aria-hidden="true">{word}</span>
    <div className={styles.folder}>
      <span className={styles.back} aria-hidden="true" />
      {cards.map((card, i) => {
        const k = i - mid, edge = Math.abs(k);
        return <button key={card.key} type="button" className={styles.card} onClick={() => onOpenCard(card.key)} aria-label={"打开 " + card.title}
          style={{
            "--rest-x": `${k * 10}px`, "--rest-r": `${k * 3}deg`,
            // 展开：越靠外越低、越斜
            "--open-x": `${k * 118}px`, "--open-y": `${-158 + edge * edge * 15}px`, "--open-r": `${k * 13}deg`,
            "--delay": `${edge * 35}ms`, zIndex: 10 - Math.round(edge),
          } as React.CSSProperties}>
          <span className={styles.photo}>{card.thumb}</span>
          {card.tag && <span className={styles.tag}>{card.tag}</span>}
        </button>;
      })}
      <button type="button" className={styles.pocket} onClick={onOpen} aria-label={label}>
        <span className={styles.badge} aria-hidden="true"><i /><i /></span>
        <span className={styles.sticker} aria-hidden="true">3D</span>
        <span className={styles.label}>{label}<small>{note}</small></span>
        <span className={styles.arrow} aria-hidden="true">→</span>
      </button>
    </div>
  </div>;
}
