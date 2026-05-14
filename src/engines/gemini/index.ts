import type { BotConfigBase } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import type { Engine } from '../types.js';
import { StreamProcessor } from '../claude/stream-processor.js';
import { GeminiExecutor } from './executor.js';

export class GeminiEngine implements Engine {
  readonly name = 'gemini' as const;

  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}

  createExecutor(): GeminiExecutor {
    return new GeminiExecutor(this.config, this.logger);
  }

  createStreamProcessor(userPrompt: string): StreamProcessor {
    return new StreamProcessor(userPrompt);
  }
}

export { GeminiExecutor } from './executor.js';
export {
  createGeminiTranslatorState,
  translateGeminiJsonEvent,
} from './jsonl-translator.js';
export type { GeminiJsonEvent, GeminiTranslatorState } from './jsonl-translator.js';
