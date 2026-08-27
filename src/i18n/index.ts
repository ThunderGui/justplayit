import type { Lang } from '../domain/settings.js';
import { de } from './de.js';
import { en, type Dict } from './en.js';
import { pt } from './pt.js';

const CATALOGUES: Record<Lang, Dict> = { en, de, pt };

export const SUPPORTED_LANGUAGES: Lang[] = ['en', 'de', 'pt'];

export const LANGUAGE_NAMES: Record<Lang, string> = {
  en: 'English',
  de: 'Deutsch',
  pt: 'Português',
};

export function t(lang: Lang): Dict {
  return CATALOGUES[lang] ?? en;
}

export type { Dict };
