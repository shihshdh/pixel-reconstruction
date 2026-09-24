import type { CSSProperties } from "react";
import s from "./PixelLoader.module.css";

/** The waiting state in the brand's own language: four logo pixels trading places clockwise,
 *  brightest first, like the mark's pixels gathering. Decorative unless given a label. */
export default function PixelLoader({ size = 12, label, className, style }: { size?: number; label?: string; className?: string; style?: CSSProperties }) {
  return <span className={className ? `${s.loader} ${className}` : s.loader} style={{ "--pl": `${size}px`, ...style } as CSSProperties}
    role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    <i /><i /><i /><i />
  </span>;
}
