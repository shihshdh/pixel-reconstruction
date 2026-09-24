"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./AuthorContact.module.css";
import { MorphIcon } from "morphicons/react";
import { ICON } from "@/lib/icons";
import { SPRING } from "@/lib/motion";

const WECHAT = "x13307341565";
const EASE = "cubic-bezier(.16,1,.3,1)";

export default function AuthorContact({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "selected">("idle");
  const trigger = useRef<HTMLButtonElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const wechatField = useRef<HTMLInputElement>(null);
  const animations = useRef<Animation[]>([]);
  const closing = useRef(false);
  const cycle = useRef(0);
  const tiltFrame = useRef(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = useRef(false);
  const savedFocus = useRef<HTMLElement | null>(null);

  const originTransform = () => {
    const from = trigger.current?.getBoundingClientRect();
    const to = card.current?.getBoundingClientRect();
    if (!from || !to || !to.width || !to.height) return "translateY(-12px) scale(.96)";
    return `translate(${from.left + from.width / 2 - to.left - to.width / 2}px, ${from.top + from.height / 2 - to.top - to.height / 2}px) scale(${Math.max(.035, from.width / to.width)}, ${Math.max(.035, from.height / to.height)})`;
  };
  const close = () => {
    if (!card.current || !overlay.current || closing.current) return;
    closing.current = true;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const current = getComputedStyle(card.current);
    const fromTransform = current.transform, fromOpacity = current.opacity;
    const backdropOpacity = getComputedStyle(overlay.current).opacity;
    // Measure at its resting position so a close during entry does not use a
    // transformed rectangle as the FLIP destination.
    animations.current.forEach(animation => animation.cancel());
    const target = originTransform();
    const closeCycle = ++cycle.current;
    const finish = () => { if (cycle.current === closeCycle && active.current) setOpen(false); };
    if (!card.current.animate) { finish(); return; }
    const shrink = card.current.animate([
      { transform: reduced ? "none" : fromTransform, opacity: fromOpacity },
      { transform: reduced ? "none" : target, opacity: 0 },
    ], { duration: reduced ? 130 : 330, easing: "cubic-bezier(.4,0,.7,1)", fill: "both" });
    const fade = overlay.current.animate([{ opacity: backdropOpacity }, { opacity: 0 }], { duration: reduced ? 130 : 300, easing: "ease", fill: "both" });
    animations.current = [shrink, fade];
    shrink.finished.then(finish).catch(() => {});
  };

  useLayoutEffect(() => {
    if (!open || !card.current || !overlay.current) return;
    const currentOverlay = overlay.current;
    const currentCard = card.current;
    const openCycle = ++cycle.current;
    active.current = true;
    closing.current = false;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const bodyOverflow = document.body.style.overflow;
    const bodyPadding = document.body.style.paddingRight;
    const scrollbar = Math.max(0, innerWidth - document.documentElement.clientWidth);
    const siblings = Array.from(document.body.children).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== currentOverlay);
    const previousInert = siblings.map(element => element.inert);
    document.body.style.overflow = "hidden";
    if (scrollbar) document.body.style.paddingRight = `${parseFloat(getComputedStyle(document.body).paddingRight) + scrollbar}px`;
    siblings.forEach(element => { element.inert = true; });

    const startingTransform = originTransform();
    if (currentCard.animate) {
      const expand = currentCard.animate([
        { transform: reduced ? "none" : startingTransform, opacity: 0 },
        { transform: "none", opacity: 1 },
      ], { duration: reduced ? 150 : 620, easing: EASE, fill: "both" });
      const fade = currentOverlay.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduced ? 150 : 330, easing: "ease", fill: "both" });
      const details = Array.from(currentCard.querySelectorAll<HTMLElement>("[data-author-reveal]"));
      animations.current = [expand, fade, ...details.map((element, index) => element.animate([
        { opacity: 0, transform: reduced ? "none" : "translateY(10px)" },
        { opacity: 1, transform: "none" },
      ], { duration: reduced ? 150 : 430, delay: reduced ? 0 : 120 + index * 55, easing: EASE, fill: "both" }))];
      Promise.all(animations.current.map(animation => animation.finished)).then(() => {
        if (cycle.current === openCycle && !closing.current) {
          animations.current.forEach(animation => animation.cancel());
          animations.current = [];
        }
      }).catch(() => {});
    }
    closeButton.current?.focus({ preventScroll: true });
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "Tab") return;
      const controls = Array.from(currentCard.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'));
      const first = controls[0], last = controls[controls.length - 1];
      if (!first || !last) { event.preventDefault(); currentCard.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !currentCard.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !currentCard.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keyboard, true);
    return () => {
      active.current = false;
      ++cycle.current;
      closing.current = false;
      cancelAnimationFrame(tiltFrame.current);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      animations.current.forEach(animation => animation.cancel());
      animations.current = [];
      document.removeEventListener("keydown", keyboard, true);
      siblings.forEach((element, index) => { if (element.isConnected) element.inert = previousInert[index]; });
      document.body.style.overflow = bodyOverflow;
      document.body.style.paddingRight = bodyPadding;
      const focusTarget = trigger.current?.isConnected ? trigger.current : savedFocus.current;
      if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
    };
    // This effect owns one complete portal lifetime; callbacks use refs so copy
    // feedback cannot restart its animation or scroll/focus lock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const copy = async () => {
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(WECHAT);
        copied = true;
      }
    } catch { /* A denied clipboard falls back to actual selection below. */ }
    if (!active.current) return;
    if (!copied) {
      wechatField.current?.focus({ preventScroll: true });
      wechatField.current?.select();
      wechatField.current?.setSelectionRange(0, WECHAT.length);
      try { copied = document.execCommand("copy"); } catch { copied = false; }
    }
    setCopyState(copied ? "copied" : "selected");
    if (copyTimer.current) clearTimeout(copyTimer.current);
    if (copied) copyTimer.current = setTimeout(() => { if (active.current) setCopyState("idle"); }, 3000);
  };
  const resetTilt = () => {
    cancelAnimationFrame(tiltFrame.current);
    if (!surface.current) return;
    surface.current.style.transform = "none";
    surface.current.style.setProperty("--glint-x", "28%");
    surface.current.style.setProperty("--glint-y", "0%");
  };

  return <>
    <button ref={trigger} type="button" className={`${styles.trigger} ${className}`} aria-label="联系作者" title="联系作者" aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { savedFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setCopyState("idle"); setOpen(true); }}>
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="7" r="2.7" /><path d="M4.4 16.1c.5-2.9 2.4-4.5 5.6-4.5s5.1 1.6 5.6 4.5" /><path d="M15.7 3.4a8 8 0 1 1-11.4 0" /></svg>
      <span>联系作者</span>
    </button>
    {open && createPortal(<div ref={overlay} className={styles.overlay} data-author-contact onPointerDown={event => { if (event.target === event.currentTarget) close(); }}>
      <div ref={card} className={styles.card} role="dialog" aria-modal="true" aria-labelledby="author-contact-name" aria-describedby="author-contact-description" tabIndex={-1}
        onPointerMove={event => {
          if (event.pointerType !== "mouse" || closing.current || matchMedia("(prefers-reduced-motion: reduce)").matches || !matchMedia("(hover: hover) and (pointer: fine)").matches) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const x = (event.clientX - rect.left) / rect.width, y = (event.clientY - rect.top) / rect.height;
          cancelAnimationFrame(tiltFrame.current);
          tiltFrame.current = requestAnimationFrame(() => {
            if (!surface.current) return;
            surface.current.style.transform = `perspective(1000px) rotateX(${(0.5 - y) * 1.4}deg) rotateY(${(x - .5) * 1.8}deg)`;
            surface.current.style.setProperty("--glint-x", `${x * 100}%`);
            surface.current.style.setProperty("--glint-y", `${y * 100}%`);
          });
        }} onPointerLeave={resetTilt}>
        <div ref={surface} className={styles.surface}>
          <div className={styles.art}>
            <img src="/author/background.jpg" alt="纸张撕开的边缘下，香港城市建筑与手绘线条相映" loading="lazy" decoding="async" />
            <span className={styles.signature}>PIXEL RECONSTRUCTION <i /> AUTHOR</span>
          </div>
          <button ref={closeButton} type="button" className={styles.close} onClick={close} aria-label="关闭作者卡片"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg></button>
          <div className={styles.glass}>
            <div className={styles.identity} data-author-reveal>
              <img className={styles.avatar} src="/author/avatar.jpg" alt="适合刺猹的头像" width={88} height={88} loading="lazy" decoding="async" />
              <div><span className={styles.smallLabel}>很高兴，在这里遇见你。</span><h2 id="author-contact-name">适合刺猹</h2></div>
              <span className={styles.authorTag}>作者</span>
            </div>
            <p id="author-contact-description" className={styles.description} data-author-reveal>关于作品、想法，或只是打个招呼。</p>
            <div className={styles.contact} data-author-reveal>
              <label htmlFor="author-contact-wechat">微信<span>WECHAT</span></label>
              <input ref={wechatField} id="author-contact-wechat" value={WECHAT} readOnly aria-label="作者微信号" spellCheck={false} onClick={event => event.currentTarget.select()} />
              <button type="button" onClick={copy} className={styles.copy} aria-label="复制微信号" data-copied={copyState === "copied" ? "true" : "false"}>
                <MorphIcon icon={copyState === "copied" ? ICON.check : ICON.copy} strokeWidth={1.68} style={{ strokeWidth: 1.68 }} spring={SPRING} reducedMotion="user" />
                <span>{copyState === "copied" ? "已复制" : "复制"}</span>
              </button>
            </div>
            <p className={styles.feedback} role="status" aria-live="polite">{copyState === "copied" ? "微信号已复制，去微信打个招呼吧。" : copyState === "selected" ? "微信号已选中，请长按或按 Ctrl+C 复制。" : ""}</p>
          </div>
        </div>
      </div>
    </div>, document.body)}
  </>;
}
