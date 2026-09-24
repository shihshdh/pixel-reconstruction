// Stroke icons on a 24-unit grid, drawn for Pixel Reconstruction (round caps and joins).
// Pairs that morph into each other with Morphicons: sun ↔ moon, play ↔ pause, copy ↔ check.
// Keep them module-level constants: MorphIcon animates when the reference changes.

export const ICON = {
  sun: "M12 7.6a4.4 4.4 0 1 1 0 8.8a4.4 4.4 0 1 1 0-8.8Z M12 2.6v1.9 M12 19.5v1.9 M2.6 12h1.9 M19.5 12h1.9 M5.35 5.35l1.35 1.35 M17.3 17.3l1.35 1.35 M5.35 18.65l1.35-1.35 M17.3 6.7l1.35-1.35",
  moon: "M12.6 3.4a6.4 6.4 0 0 0 8 8a8.7 8.7 0 1 1-8-8Z",
  play: "M8.2 5.6v12.8l10.2-6.4Z",
  pause: "M9 6v12 M15 6v12",
  // The author card's copy glyph, redrawn from its 20-unit original at 1.2×.
  copy: "M10.8 8.4h6a2.4 2.4 0 0 1 2.4 2.4v7.2a2.4 2.4 0 0 1-2.4 2.4h-6a2.4 2.4 0 0 1-2.4-2.4v-7.2a2.4 2.4 0 0 1 2.4-2.4Z M14.4 8.4V6a2.4 2.4 0 0 0-2.4-2.4H6A2.4 2.4 0 0 0 3.6 6v7.2A2.4 2.4 0 0 0 6 15.6h2.4",
  check: "M4.8 12.4l4.6 4.6 9.8-9.8",
} as const;
