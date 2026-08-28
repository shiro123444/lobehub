import type {
  ArtifactSnapshot,
  ExportResult,
  PluginDescriptor,
  PluginRuntimeState,
  PresentationExportFormat,
  PresentationJob,
  PresentationJobInput,
  ResumeRunInput,
  RunSnapshot,
  RuntimeEvent,
  StartRunInput,
} from '../../../packages/runtime-contracts/src/index';

const RUNTIME_ENDPOINTS = {
  cancelRun: (runId: string) => `/api/runtime/v1/runs/${encodeURIComponent(runId)}/cancel`,
  mountPlugin: (id: string) => `/api/runtime/v1/plugins/${encodeURIComponent(id)}/mount`,
  plugins: '/api/runtime/v1/plugins',
  presentationArtifact: (artifactId: string) =>
    `/api/runtime/presentation/artifacts/${encodeURIComponent(artifactId)}`,
  presentationExport: '/api/runtime/presentation/artifacts/export',
  presentationJob: (jobId: string) => `/api/runtime/presentation/jobs/${encodeURIComponent(jobId)}`,
  presentationJobCancel: (jobId: string) =>
    `/api/runtime/presentation/jobs/${encodeURIComponent(jobId)}/cancel`,
  presentationJobRetry: (jobId: string) =>
    `/api/runtime/presentation/jobs/${encodeURIComponent(jobId)}/retry`,
  presentationJobs: '/api/runtime/presentation/jobs',
  reloadPlugin: (id: string) => `/api/runtime/v1/plugins/${encodeURIComponent(id)}/reload`,
  resumeRun: (runId: string) => `/api/runtime/v1/runs/${encodeURIComponent(runId)}/resume`,
  run: (runId: string) => `/api/runtime/v1/runs/${encodeURIComponent(runId)}`,
  runEvents: (runId: string, afterSeq?: number) => {
    const base = `/api/runtime/v1/runs/${encodeURIComponent(runId)}/events`;
    const query = typeof afterSeq === 'number' ? `?after_seq=${afterSeq}` : '';
    return `${base}${query}`;
  },
  runs: '/api/runtime/v1/runs',
  unmountPlugin: (id: string) => `/api/runtime/v1/plugins/${encodeURIComponent(id)}/unmount`,
};

export interface RuntimeClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  getHeaders?: () => HeadersInit | Promise<HeadersInit>;
}

export interface SubscribeOptions {
  deduplicate?: boolean;
  onSeqReceived?: (seq: number) => void;
  signal?: AbortSignal;
}

export interface RuntimeClient {
  cancelPresentationJob: (
    jobId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<PresentationJob>;
  cancelRun: (runId: string, options?: { signal?: AbortSignal }) => Promise<void>;
  createPresentationJob: (
    input: PresentationJobInput,
    options?: { signal?: AbortSignal },
  ) => Promise<PresentationJob>;
  exportArtifact: (
    artifactId: string,
    format: PresentationExportFormat,
    options?: { signal?: AbortSignal },
  ) => Promise<ExportResult>;
  getArtifact: (
    artifactId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<ArtifactSnapshot | null>;
  getPresentationJob: (
    jobId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<PresentationJob | null>;
  getRun: (runId: string, options?: { signal?: AbortSignal }) => Promise<RunSnapshot | null>;
  listPlugins: (options?: { signal?: AbortSignal }) => Promise<PluginDescriptor[]>;
  mountPlugin: (
    id: string,
    config?: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<PluginRuntimeState>;
  reloadPlugin: (id: string, options?: { signal?: AbortSignal }) => Promise<PluginRuntimeState>;
  resumeRun: (
    runId: string,
    input: ResumeRunInput,
    options?: { signal?: AbortSignal },
  ) => Promise<RunSnapshot>;
  retryPresentationJob: (
    jobId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<PresentationJob>;
  startRun: (input: StartRunInput, options?: { signal?: AbortSignal }) => Promise<RunSnapshot>;
  subscribe: (
    runId: string,
    afterSeq?: number,
    options?: SubscribeOptions,
  ) => AsyncIterable<RuntimeEvent>;
  unmountPlugin: (id: string, options?: { signal?: AbortSignal }) => Promise<PluginRuntimeState>;
}

export class RuntimeClientImpl implements RuntimeClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly getHeaders?: () => HeadersInit | Promise<HeadersInit>;

  constructor(options: RuntimeClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
    this.getHeaders = options.getHeaders;
  }

  private resolveUrl(path: string): string {
    if (!this.baseUrl) return path;
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}${cleanPath}`;
  }

  private async prepareHeaders(customHeaders?: HeadersInit): Promise<Headers> {
    const headers = new Headers(customHeaders);
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (this.getHeaders) {
      const extra = await this.getHeaders();
      const extraHeaders = new Headers(extra);
      extraHeaders.forEach((value, key) => {
        if (!headers.has(key)) {
          headers.set(key, value);
        }
      });
    }
    return headers;
  }

  async startRun(input: StartRunInput, options?: { signal?: AbortSignal }): Promise<RunSnapshot> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.runs);
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      body: JSON.stringify(input),
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to start run (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    return (await response.json()) as RunSnapshot;
  }

  async getRun(runId: string, options?: { signal?: AbortSignal }): Promise<RunSnapshot | null> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.run(runId));
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      headers,
      method: 'GET',
      signal: options?.signal,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to get run ${runId} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    return (await response.json()) as RunSnapshot;
  }

  async cancelRun(runId: string, options?: { signal?: AbortSignal }): Promise<void> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.cancelRun(runId));
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to cancel run ${runId} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }
  }

  async resumeRun(
    runId: string,
    input: ResumeRunInput,
    options?: { signal?: AbortSignal },
  ): Promise<RunSnapshot> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.resumeRun(runId));
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      body: JSON.stringify(input),
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to resume run ${runId} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    return (await response.json()) as RunSnapshot;
  }

  async listPlugins(options?: { signal?: AbortSignal }): Promise<PluginDescriptor[]> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.plugins);
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      headers,
      method: 'GET',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to list plugins (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    return (await response.json()) as PluginDescriptor[];
  }

  async mountPlugin(
    id: string,
    config?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<PluginRuntimeState> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.mountPlugin(id));
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      body: config !== undefined ? JSON.stringify(config) : undefined,
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to mount plugin ${id} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    const data = await response.json();
    return (data?.state ?? data) as PluginRuntimeState;
  }

  async unmountPlugin(id: string, options?: { signal?: AbortSignal }): Promise<PluginRuntimeState> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.unmountPlugin(id));
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to unmount plugin ${id} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    const data = await response.json();
    return (data?.state ?? data) as PluginRuntimeState;
  }

  async reloadPlugin(id: string, options?: { signal?: AbortSignal }): Promise<PluginRuntimeState> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.reloadPlugin(id));
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to reload plugin ${id} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    const data = await response.json();
    return (data?.state ?? data) as PluginRuntimeState;
  }

  // --- Presentation Client Methods ---

  async createPresentationJob(
    input: PresentationJobInput,
    options?: { signal?: AbortSignal },
  ): Promise<PresentationJob> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.presentationJobs);
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      body: JSON.stringify(input),
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to create presentation job (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    return (await response.json()) as PresentationJob;
  }

  async getPresentationJob(
    jobId: string,
    options?: { signal?: AbortSignal },
  ): Promise<PresentationJob | null> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.presentationJob(jobId));
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      headers,
      method: 'GET',
      signal: options?.signal,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to get presentation job ${jobId} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    return (await response.json()) as PresentationJob;
  }

  async cancelPresentationJob(
    jobId: string,
    options?: { signal?: AbortSignal },
  ): Promise<PresentationJob> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.presentationJobCancel(jobId));
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to cancel presentation job ${jobId} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    return (await response.json()) as PresentationJob;
  }

  async retryPresentationJob(
    jobId: string,
    options?: { signal?: AbortSignal },
  ): Promise<PresentationJob> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.presentationJobRetry(jobId));
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to retry presentation job ${jobId} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    return (await response.json()) as PresentationJob;
  }

  async getArtifact(
    artifactId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ArtifactSnapshot | null> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.presentationArtifact(artifactId));
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      headers,
      method: 'GET',
      signal: options?.signal,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to get artifact ${artifactId} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    return (await response.json()) as ArtifactSnapshot;
  }

  async exportArtifact(
    artifactId: string,
    format: PresentationExportFormat,
    options?: { signal?: AbortSignal },
  ): Promise<ExportResult> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.presentationExport);
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      body: JSON.stringify({ artifactId, format }),
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to export artifact ${artifactId} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    return (await response.json()) as ExportResult;
  }

  // --- SSE Stream Subscription ---

  async *subscribe(
    runId: string,
    afterSeq?: number,
    options?: SubscribeOptions,
  ): AsyncIterable<RuntimeEvent> {
    const deduplicate = options?.deduplicate ?? true;
    const seenSeqs = new Set<number>();
    let maxSeenSeq = typeof afterSeq === 'number' ? afterSeq : -1;

    const url = this.resolveUrl(RUNTIME_ENDPOINTS.runEvents(runId, afterSeq));
    const headers = await this.prepareHeaders({
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });

    const response = await this.fetcher(url, {
      headers,
      method: 'GET',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to subscribe to run ${runId} events (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let eventDataLines: string[] = [];
    let eventIdSeq: number | undefined;

    const processRawEvent = function* (rawData: string, idSeq?: number): Generator<RuntimeEvent> {
      try {
        const parsed = JSON.parse(rawData) as RuntimeEvent;
        if (typeof parsed.seq !== 'number' && typeof idSeq === 'number') {
          parsed.seq = idSeq;
        }
        const seq = parsed.seq;
        if (typeof seq === 'number') {
          if (deduplicate) {
            if (seenSeqs.has(seq) || (typeof afterSeq === 'number' && seq <= afterSeq)) {
              return;
            }
            seenSeqs.add(seq);
          }
          if (seq > maxSeenSeq) {
            maxSeenSeq = seq;
          }
          options?.onSeqReceived?.(seq);
        }
        yield parsed;
      } catch (err) {
        console.warn('[RuntimeClient] Failed to parse SSE event data:', rawData, err);
      }
    };

    try {
      while (true) {
        if (options?.signal?.aborted) {
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r\n|\r|\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.trim() === '') {
            // Dispatch event when empty line encountered
            if (eventDataLines.length > 0) {
              const rawData = eventDataLines.join('\n');
              const currentIdSeq = eventIdSeq;
              eventDataLines = [];
              eventIdSeq = undefined;
              for (const ev of processRawEvent(rawData, currentIdSeq)) {
                yield ev;
              }
            }
          } else if (line.startsWith('data:')) {
            eventDataLines.push(line.slice(5).trimStart());
          } else if (line.startsWith('id:')) {
            const rawId = line.slice(3).trim();
            const parsedSeq = Number.parseInt(rawId, 10);
            if (!Number.isNaN(parsedSeq)) {
              eventIdSeq = parsedSeq;
            }
          } else if (line.startsWith(':')) {
            // SSE comment / ping, ignore
          }
        }
      }

      // Flush remaining buffer if stream closed without trailing newline
      if (buffer.trim() !== '' && buffer.startsWith('data:')) {
        eventDataLines.push(buffer.slice(5).trimStart());
      }
      if (eventDataLines.length > 0) {
        const rawData = eventDataLines.join('\n');
        const currentIdSeq = eventIdSeq;
        for (const ev of processRawEvent(rawData, currentIdSeq)) {
          yield ev;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export const runtimeClient = new RuntimeClientImpl();
