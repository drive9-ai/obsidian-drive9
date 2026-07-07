// Obsidian-compatible subset of mem9-ai/drive9 clients/drive9-js@0.1.3.

export class Semaphore {
  private permits: number;
  private waiters: (() => void)[] = [];

  constructor(n: number) {
    this.permits = n;
  }

  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}
