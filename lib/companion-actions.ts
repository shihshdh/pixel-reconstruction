// Runs the page actions the companion proposes (the gateway has already validated their shape).
// She can switch pages, scroll, point at things and press ordinary buttons. Anything that deletes,
// uploads, spends generation quota, downloads or leaves the site is only prepared: the user confirms
// it in the chat first. She never types, never picks files and never touches her own panel.

export type PageAction =
  | { type: "navigate"; page: string; note?: string }
  | { type: "scroll"; ref?: string; direction?: "up" | "down" | "top" | "bottom"; note?: string }
  | { type: "highlight" | "click"; ref: string; note?: string };

export const PAGE_NAMES: Record<string, string> = { home: "概览", create: "创作", studio: "工作室", enhance: "修图", gallery: "作品库" };

const RISKY = /删|清空|移除|上传|选择(照片|图片|文件)|生成|显影|重建|提交|修图|重新|导出|下载|发送|支付|购买|退出|重置|覆盖|替换|停止|取消任务|扩图/;

export function findRef(ref: string): HTMLElement | null {
  if (!/^[a-z]\d{1,4}$/.test(ref)) return null;
  const el = document.querySelector<HTMLElement>(`[data-assist-ref="${ref}"]`);
  // Her own panel and anything private stay out of reach even if a stale number points there.
  return el && el.isConnected && !el.closest("[data-assist-private],input,textarea,select,[inert]") ? el : null;
}

export function labelOf(el: Element) {
  return ((el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.getAttribute("title") || "").replace(/\s+/g, " ").trim()).slice(0, 30) || "这个按钮";
}

export function isDisabled(el: HTMLElement) {
  return (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true";
}

/** Needs a yes from the user before it runs. */
export function isRisky(el: HTMLElement) {
  if (RISKY.test(labelOf(el))) return true;
  if (el.querySelector('input[type="file"]') || (el.matches("label[for]") && document.getElementById(el.getAttribute("for")!)?.matches('input[type="file"]'))) return true;
  if (el.matches('button[type="submit"],input[type="submit"]') || (el.matches("button") && !el.getAttribute("type") && el.closest("form"))) return true;
  if (el.matches("a[href]")) {
    const link = el as HTMLAnchorElement;
    try { if (new URL(link.href, location.href).origin !== location.origin || link.target === "_blank" || link.hasAttribute("download")) return true; }
    catch { return true; }
  }
  return false;
}

let clearHighlight: (() => void) | null = null;
export function highlight(el: HTMLElement, reduced: boolean) {
  clearHighlight?.();
  el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  el.setAttribute("data-assist-highlight", "");
  const timer = setTimeout(() => clearHighlight?.(), 2800);
  clearHighlight = () => { clearTimeout(timer); el.removeAttribute("data-assist-highlight"); clearHighlight = null; };
}

export function scrollPage(direction: "up" | "down" | "top" | "bottom", reduced: boolean) {
  const behavior: ScrollBehavior = reduced ? "auto" : "smooth";
  if (direction === "top") window.scrollTo({ top: 0, behavior });
  else if (direction === "bottom") window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
  else window.scrollBy({ top: (direction === "down" ? 1 : -1) * Math.round(innerHeight * 0.7), behavior });
}

export const SCROLL_WORDS = { up: "往上翻了一点", down: "往下翻了一点", top: "回到了顶部", bottom: "翻到了底部" } as const;
