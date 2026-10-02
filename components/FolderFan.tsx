'use client';

// 首页的作品库入口：一个青蓝色文件夹，最近的作品卡插在里面只露出顶边。
// 鼠标进入文件夹，卡片带回弹地向上扇形展开；指到哪张，哪张再抬起来、换白边、阴影加深。
// 前袋是磨砂玻璃，卡片下半截在玻璃后面若隐若现。背后是一行充气质感的大字。
// 每张卡的展开位置只由序号 k（-2…2）算出，写进 CSS 变量，动画全部交给 CSS transition。
import type { ReactNode } from "react";
import styles from "./FolderFan.module.css";

export type FolderCard = { key: string; title: string; tag?: string; thumb: ReactNode };

export default function FolderFan({ cards, count, onOpen, onOpenCard }: { cards: FolderCard[]; count: number; onOpen: () => void; onOpenCard: (key: string) => void }) {
  const n = cards.length, mid = (n - 1) / 2;
  return <div className={styles.stage}>
    <span className={styles.puff} aria-hidden="true">works</span>
    <div className={styles.folder}>
      <span className={styles.back} aria-hidden="true" />
      {cards.map((card, i) => {
        const k = i - mid, edge = Math.abs(k);
        return <button key={card.key} type="button" className={styles.card} onClick={() => onOpenCard(card.key)} aria-label={"打开 " + card.title}
          style={{
            "--rest-x": `${k * 9}px`, "--rest-r": `${k * 3}deg`,
            // 展开：越靠外越低、越斜
            "--open-x": `${k * 74}px`, "--open-y": `${-104 + edge * edge * 9}px`, "--open-r": `${k * 10.5}deg`,
            "--delay": `${edge * 35}ms`, zIndex: 10 - Math.round(edge),
          } as React.CSSProperties}>
          <span className={styles.photo}>{card.thumb}</span>
          {card.tag && <span className={styles.tag}>{card.tag}</span>}
        </button>;
      })}
      <button type="button" className={styles.pocket} onClick={onOpen} aria-label={`打开作品库，共 ${count} 件作品`}>
        <span className={styles.badge} aria-hidden="true"><i /><i /></span>
        <span className={styles.sticker} aria-hidden="true">3D</span>
        <span className={styles.label}>作品库<small>{count ? `${count} 件作品` : "示例"}</small></span>
        <span className={styles.arrow} aria-hidden="true">→</span>
      </button>
    </div>
  </div>;
}
