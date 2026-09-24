import type { CSSProperties } from "react";

/** Discrete pixels become a continuous volume. A vector mark at every size.
 *  data-part hooks let motion styles address the pixels, shell and faces without changing the drawing. */
export default function BrandMark({ size = 32, className }: { size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 64 64" fill="none" className={className} aria-hidden="true" data-mark="">
    <rect data-part="px" x="4" y="12" width="9" height="9" rx="1.5" fill="currentColor" opacity=".36" style={{ "--i": 0 } as CSSProperties} />
    <rect data-part="px" x="17" y="5" width="9" height="9" rx="1.5" fill="currentColor" opacity=".64" style={{ "--i": 1 } as CSSProperties} />
    <rect data-part="px" x="4" y="27" width="9" height="9" rx="1.5" fill="currentColor" opacity=".64" style={{ "--i": 2 } as CSSProperties} />
    <rect data-part="px" x="4" y="42" width="9" height="9" rx="1.5" fill="currentColor" style={{ "--i": 3 } as CSSProperties} />
    <path data-part="shell" d="M37 12 58 24V47L37 59 17 47V24L37 12Z" fill="currentColor" fillOpacity=".08" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
    <path data-part="edges" d="m17 24 20 12 21-12M37 36v23" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
    <path data-part="top" d="m37 12 21 12-21 12-20-12 20-12Z" fill="currentColor" fillOpacity=".18" />
    <path data-part="side" d="M17 32v15l12 7V40L17 32Z" fill="currentColor" fillOpacity=".48" />
  </svg>;
}
