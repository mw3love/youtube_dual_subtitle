export type BackendId = 'chrome-builtin' | 'google-free' | 'gemini';

export interface TranslatorBackend {
  id: BackendId;
  translateBatch(texts: string[], src: string, tgt: string): Promise<string[]>;
}
