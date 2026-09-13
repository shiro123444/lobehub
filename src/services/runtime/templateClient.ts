import type { PresentationJob } from '../../../packages/runtime-contracts/src';

/** The template library's UI projection; layouts stay on the server. */
export interface PresentationTemplateSummary {
  constraints?: { palette: string[] };
  layoutCount?: number;
  name: string;
  source?: { kind: string };
  templateId: string;
  versionId: string;
  warnings?: string[];
}

interface TemplateResponse extends PresentationTemplateSummary {
  layouts?: unknown[];
}

const endpoint = '/api/runtime/presentation/templates';

const request = async <T>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, { ...options, credentials: 'same-origin' });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `Template request failed (${response.status})`);
  }
  return body as T;
};

const summary = ({ layouts, ...profile }: TemplateResponse): PresentationTemplateSummary => ({
  ...profile,
  layoutCount: profile.layoutCount ?? layouts?.length,
});

export const presentationTemplateClient = {
  listNativeOutputs: (template: PresentationTemplateSummary, signal?: AbortSignal) =>
    request<{ outputs: { artifactId: string; uri?: string; updatedAt?: string }[] }>(
      '/api/runtime/presentation/tools/presentation.template.listNativeOutputs',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ templateId: template.templateId, versionId: template.versionId }),
        signal,
      },
    ),
  fillNative: (template: PresentationTemplateSummary, instruction: string, requestId: string) =>
    request<{ summary: string; result: { artifactId?: string; uri?: string } }>(
      '/api/runtime/presentation/tools/skills.autorun',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instruction: `请保留原生 PPTX 的复杂结构，只修改用户指定内容，返回修改后的文件。${instruction}`,
          requestId,
          resources: { templateId: template.templateId, versionId: template.versionId },
        }),
      },
    ),
  apply: (
    jobId: string,
    input: { requestId: string; templateId: string; versionId?: string },
  ): Promise<PresentationJob> =>
    request(`/api/runtime/presentation/jobs/${encodeURIComponent(jobId)}/template`, {
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
  importPptx: async (file: File, name: string): Promise<PresentationTemplateSummary> => {
    const body = new FormData();
    body.append('file', file);
    body.append('name', name);
    return summary(await request<TemplateResponse>(`${endpoint}/import`, { body, method: 'POST' }));
  },
  learn: async (jobId: string, name: string): Promise<PresentationTemplateSummary> =>
    summary(
      await request<TemplateResponse>(endpoint, {
        body: JSON.stringify({ jobId, name }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    ),
  list: async (signal?: AbortSignal): Promise<PresentationTemplateSummary[]> => {
    const result = await request<{ templates: TemplateResponse[] }>(endpoint, { signal });
    return result.templates.map(summary);
  },
};
