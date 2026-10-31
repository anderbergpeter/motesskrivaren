import { localProvider } from '../local/localProvider';
import { deepgramProvider } from './deepgram';
import { elevenLabsProvider } from './elevenlabs';
import { mockProvider } from './mock';
import { openAiProvider } from './openai';
import { selfHostedProvider } from './selfhosted';
import { sonioxProvider } from './soniox';
import { speechmaticsProvider } from './speechmatics';
import { webSpeechProvider } from './webspeech';
import type { Provider } from './types';

export const providers: Provider[] = [
  localProvider,
  webSpeechProvider,
  speechmaticsProvider,
  sonioxProvider,
  deepgramProvider,
  elevenLabsProvider,
  openAiProvider,
  selfHostedProvider,
  mockProvider,
];

export function getProvider(id: string): Provider {
  return providers.find((p) => p.id === id) ?? localProvider;
}

export type { Provider, BatchProvider, StreamProvider, ProviderSettings, RawSegment } from './types';
