export type Slide = { title: string; body: string; notes?: string };
export type SlideDeck = { title: string; slides: Slide[] };
export const SLIDES_LIMITS: Readonly<{ slides: number; title: number; body: number; notes: number; content: number }>;
export class SlidesValidationError extends Error { status: number; code: string; }
export const SLIDES_PARAMETERS_SCHEMA: Readonly<Record<string, unknown>>;
export function validateSlides(value: unknown): SlideDeck;
export function parseSlidesContent(content: string): SlideDeck;
export function serializeSlides(value: unknown): string;
export function buildSlidesHtml(input: string | SlideDeck): string;
export const SLIDES_NAVIGATION_SCRIPT: string;
export const SLIDES_SCRIPT_HASH: string;
export const SLIDES_CSP: string;
