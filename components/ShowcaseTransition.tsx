'use client';

/** Layered shutters reuse the live scene underneath; no screenshots or extra renderer. */
export default function ShowcaseTransition({ direction }: { direction: 'enter' | 'return' | null }) {
  if (!direction) return null;
  return <div key={direction} className={`showcase-transition is-${direction}`} aria-hidden="true">
    {[0, 1, 2, 3, 4].map(index => <div className="showcase-shutter" key={index} style={{ top: `${index * 20}%`, animationDelay: `${index * 36}ms` }}><span /></div>)}
  </div>;
}
