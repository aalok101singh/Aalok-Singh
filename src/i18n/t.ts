import { en, hi } from './dict'
import type { DictKey } from './dict'

export type Lang = 'en' | 'hi'
let lang: Lang = 'en'
const merged = { ...en, ...hi } as Record<string, string> // hoisted — rebuilt dict per t() call was wasteful (D19)

export function setLang(l: Lang): void {
  lang = l
  document.documentElement.lang = l === 'hi' ? 'hi' : 'en'
}

export function getLang(): Lang {
  return lang
}

/** t('key') or t('ns.key', 'English default') — inline default never blocks a component (§12). */
export function t(key: string, fallback?: string, vars?: Record<string, string | number>): string {
  let s: string = (lang === 'hi' ? merged : (en as Record<string, string>))[key as DictKey] ?? fallback ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
  }
  return s
}
