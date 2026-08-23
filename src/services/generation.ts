import { lambdaClient } from '@/libs/trpc/client';

class GenerationService {
  async getImageGallery(limit: number = 80) {
    return lambdaClient.generation.getImageGallery.query({ limit });
  }

  async getGenerationStatus(generationId: string, asyncTaskId: string) {
    return lambdaClient.generation.getGenerationStatus.query({ asyncTaskId, generationId });
  }

  /**
   * Delete a single generation
   */
  async deleteGeneration(generationId: string) {
    return lambdaClient.generation.deleteGeneration.mutate({ generationId });
  }
}

export const generationService = new GenerationService();
