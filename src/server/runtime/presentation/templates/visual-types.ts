import { z } from 'zod';

export const templateBoxSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .refine(
    (box) => box.x + box.width <= 1.001 && box.y + box.height <= 1.001,
    'Region must fit inside the reference page',
  );

export const templateVisualAnalysisSchema = z.object({
  summary: z.string().min(1).max(1800),
  families: z
    .array(
      z.object({
        id: z.string().min(1).max(60),
        name: z.string().min(1).max(100),
        pages: z.array(z.number().int().positive()).min(1).max(20),
        palette: z.array(z.string().regex(/^#[a-f\d]{6}$/i)).max(10),
        typography: z.string().max(1200),
        composition: z.string().max(1800),
        artwork: z.string().max(1800),
        preserve: z.array(z.string().max(500)).max(10),
      }),
    )
    .min(1)
    .max(6),
  components: z
    .array(
      z.object({
        id: z.string().regex(/^[\w-]{1,80}$/),
        name: z.string().min(1).max(100),
        page: z.number().int().positive(),
        familyId: z.string().max(60),
        box: templateBoxSchema,
        role: z.enum(['background', 'decoration', 'artwork', 'frame', 'heading']),
        containsText: z.boolean(),
        treatment: z.enum(['reuse', 'crop', 'removeBackground', 'redraw', 'native']),
        rationale: z.string().max(1200),
        generationPrompt: z.string().max(3000).optional(),
      }),
    )
    .max(24),
  guidance: z.string().min(1).max(2500),
});
export interface TemplateRenderedPage {
  height: number;
  nativeTextCount: number;
  page: number;
  ref: string;
  width: number;
}
export type TemplateVisualAnalysis = z.infer<typeof templateVisualAnalysisSchema>;
export type TemplateVisualProfile = TemplateVisualAnalysis & {
  schemaVersion: 1;
  templateId: string;
  versionId: string;
  model: string;
  analyzedAt: string;
  pages: TemplateRenderedPage[];
};
