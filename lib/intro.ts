// Opening title timing shared by the pre-paint boot script, the CSS timeline and BrandIntro.
// Kept out of the client component so the server layout can import the plain string.

/** Runs in <head> before first paint. The title plays on every full page load (a reload or a new visit);
 *  moving around inside the site never replays it. Add ?nointro to the address to skip it while testing.
 *  The title is armed paused (data-intro-hold) and its clock starts only once the document has been
 *  parsed, the tab is visible and a frame has actually reached the screen. On a slow network or device
 *  the first paint can land seconds after the CSS arrives; a clock started at CSS time would have
 *  played most of the title before anyone could see it. */
export const INTRO_BOOT = `try{if(!/[?&]nointro\\b/.test(location.search)){var h=document.documentElement;h.setAttribute("data-intro","play");h.setAttribute("data-intro-hold","");var go=function(){if(document.visibilityState!=="visible")return;document.removeEventListener("visibilitychange",go);requestAnimationFrame(function(){requestAnimationFrame(function(){h.removeAttribute("data-intro-hold")})})},armed=function(){document.addEventListener("visibilitychange",go);go()};if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",armed);else armed()}}catch(e){}`;

/** Runs first in <head>. Some hosts insert an HTML comment into <head> (Netlify adds a "hosted on
 *  Netlify" note). React's hydration does not expect it, gives up on the server markup and rebuilds the
 *  whole document on the client: the page jumps, and <html> loses data-intro mid-title, so the title
 *  disappears after a second or two. The app never renders comments or text directly in <head>, so drop
 *  them (the note and the line breaks around it) before React looks. */
export const HEAD_CLEAN = `try{for(var n=document.head.firstChild;n;){var next=n.nextSibling;if(n.nodeType===8||n.nodeType===3&&!/\\S/.test(n.nodeValue))n.remove();n=next}}catch(e){}`;

/** Scales the script-side beats and the generated keyframes (outline, pixels, letters). The CSS
 *  module keeps literal times (no CSS variables inside animations, for mobile WebKit), which have
 *  been scaled by hand to this tempo: change both together. */
export const INTRO_TEMPO = 1.35;
const at = (ms: number) => Math.round(ms * INTRO_TEMPO);
const COMPLETE = at(6650), HOLD = 1200;

/** ms from the moment the title starts playing (its first visible frame). */
export const INTRO_TIME = {
  /** Stage has finished sliding the mark aside; the lockup can fly from here. */
  ready: at(5800),
  /** The lockup is complete: the last letter and the SINGLE-IMAGE 3D line have settled. */
  complete: COMPLETE,
  /** The finished lockup holds this long before it hands over to the landing. */
  hold: HOLD,
  /** Hand-over to the landing: completion plus the hold. */
  land: COMPLETE + HOLD,
  /** Reduced motion: the lockup fades in part by part without moving, holds, then cross-fades. */
  reducedLand: 3400,
  /** If scripts never arrive, CSS fades the title out on its own at this point (BrandIntro.module.css). */
  safety: 14500,
  /** Lockup flight into the landing header. */
  flight: 1700,
} as const;

/** The landing's 3D scene waits until this point (or the hand-over, if sooner) before it starts
 *  downloading and building, so the title's first beats run on an idle device. */
export const INTRO_SCENE_START = at(3200);
