interface Job<T> {
  key: string;
  priority: number;
  generation: number;
  run: () => Promise<T>;
  promise: Promise<T>;
  resolve: (result: T) => void;
  reject: (error: unknown) => void;
  controller: AbortController;
}

export class ViewportScheduler<T> {
  private queue: Job<T>[] = [];
  private readonly jobs = new Map<string, Job<T>>();
  private readonly active = new Set<Job<T>>();
  private paused = false;
  private generation = 0;

  constructor(private readonly concurrency = 2) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be positive.');
  }

  enqueue(key: string, priority: number, run: () => Promise<T>): Promise<T> {
    const existing = this.jobs.get(key);
    if (existing) {
      existing.priority = Math.min(priority, existing.priority);
      this.sort();
      return existing.promise;
    }
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    const job: Job<T> = { key, priority, generation: this.generation, run, promise, resolve, reject, controller: new AbortController() };
    this.jobs.set(key, job);
    this.queue.push(job);
    this.sort();
    queueMicrotask(() => this.drain());
    return promise;
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; this.drain(); }

  reset(): void {
    this.generation++;
    for (const job of this.jobs.values()) {
      job.controller.abort();
      job.reject(new Error('Translation work was superseded by a new document.'));
    }
    this.queue = [];
    this.jobs.clear();
  }

  get pending(): number { return this.queue.length + this.active.size; }

  private sort(): void { this.queue.sort((a, b) => a.priority - b.priority); }

  private drain(): void {
    while (!this.paused && this.active.size < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.active.add(job);
      Promise.resolve().then(job.run).then(result => {
        if (job.generation === this.generation) job.resolve(result);
      }, job.reject).finally(() => {
        this.active.delete(job);
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
        this.drain();
      });
    }
  }
}
