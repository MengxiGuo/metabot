import type { BotConfigBase } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import type { Engine } from '../types.js';
import { StreamProcessor } from '../claude/stream-processor.js';
import { AntigravityExecutor } from './executor.js';

export class AntigravityEngine implements Engine {
  readonly name = 'antigravity' as const;

  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}

  createExecutor(): AntigravityExecutor {
    return new AntigravityExecutor(this.config, this.logger);
  }

  createStreamProcessor(userPrompt: string): StreamProcessor {
    return new StreamProcessor(userPrompt);
  }
}

export { AntigravityExecutor, buildAntigravityArgs, classifyAntigravityFailure } from './executor.js';
export {
  createAntigravityTranslatorState,
  sanitizeAntigravityError,
  translateAntigravityJsonEvent,
} from './jsonl-translator.js';
export type { AntigravityJsonEvent, AntigravityTranslatorState } from './jsonl-translator.js';
export { AntigravityModelCatalogError, fetchAntigravityModels, parseAntigravityModelList } from './model-catalog.js';
export type { AntigravityModelOption } from './model-catalog.js';
