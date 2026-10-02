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
  // 开合由脚本判断，不靠 CSS :hover：鼠标进入文件夹（或用键盘聚焦）时展开，离开整个舞台区域 180ms 后才收起。
  // 舞台是固定不动的大区域，盖住整个扇形；卡片自己怎么移动都不会让开合状态来回翻转（之前外侧卡片会在展开/收回间抖动）
  const [open, setOpen] = useState(false);
  const closeTimer = useRef(0);
  const show = () => { clearTimeout(closeTimer.current); setOpen(true); };
  const hide = () => { clearTimeout(closeTimer.current); closeTimer.current = window.setTimeout(() => setOpen(false), 180); };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  return <div ref={stageRef} className={styles.stage} data-open={open || undefined} onPointerLeave={hide}
    onFocus={show} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) hide(); }}>
    <span className={styles.puff} data-written={written || undefined} aria-hidden="true">{word}</span>
    <div className={styles.folder} onPointerEnter={show}>
      <span className={styles.back} aria-hidden="true" />
      {cards.map((card, i) => {
        const k = i - mid, edge = Math.abs(k);
        // data-own-motion：卡片自己管位移，不吃全局“按钮悬停上浮 3px”——那条规则会盖掉展开位置，让卡片在展开与原位之间来回跳
        return <button key={card.key} type="button" data-own-motion className={styles.card} onClick={() => onOpenCard(card.key)} aria-label={"打开 " + card.title}
          style={{
            "--rest-x": `${k * 10}px`, "--rest-r": `${k * 3}deg`,
            // 展开：越靠外越低、越斜
            "--open-x": `${k * 118}px`, "--open-y": `${-158 + edge * edge * 15}px`, "--open-r": `${k * 13}deg`,
            "--delay": `${edge * 70}ms`, zIndex: 10 - Math.round(edge),
          } as React.CSSProperties}>
          <span className={styles.face}>
            <span className={styles.photo}>{card.thumb}</span>
            {card.tag && <span className={styles.tag}>{card.tag}</span>}
          </span>
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
