/** Process-local ownership of live consensus runs. Never cancel by a chat prefix. */
export class ConsensusControl {
  private runs = new Map<string, {
    chatId?: string;
    bots: Set<string>;
    controller: AbortController;
    onStop?: () => void;
  }>();

  register(id: string, chatId: string | undefined, bots: string[], onStop?: () => void): AbortSignal {
    if (this.runs.has(id)) throw new Error('Consensus task already registered');
    const controller = new AbortController();
    this.runs.set(id, { chatId, bots: new Set(bots), controller, onStop });
    return controller.signal;
  }

  stop(id: string): boolean {
    const run = this.runs.get(id);
    if (!run) return false;
    if (!run.controller.signal.aborted) {
      run.controller.abort();
      run.onStop?.();
    }
    return true;
  }

  stopForChat(chatId: string, botName: string): string[] {
    const ids: string[] = [];
    for (const [id, run] of this.runs) {
      if (run.chatId === chatId && run.bots.has(botName)) {
        this.stop(id);
        ids.push(id);
      }
    }
    return ids;
  }

  finish(id: string): void { this.runs.delete(id); }
}

export const consensusControl = new ConsensusControl();
