import { ModelProvider, nexus } from 'model-bank';

import { AiProviderSourceEnum, type EnabledProviderWithModels } from '@/types/aiProvider';

export const NEXUS_IMAGE_PROVIDER = ModelProvider.Nexus;
export const NEXUS_IMAGE_MODEL = 'gpt-image-2';

const nexusImageModel = nexus.find((model) => model.id === NEXUS_IMAGE_MODEL);

export const getNexusImageModelList = (
  enabledImageModelList: EnabledProviderWithModels[],
): EnabledProviderWithModels[] => {
  const runtimeNexusProvider = enabledImageModelList.find(
    (provider) => provider.id === NEXUS_IMAGE_PROVIDER,
  );

  if (runtimeNexusProvider) {
    const children = runtimeNexusProvider.children.filter(
      (model) => model.id === NEXUS_IMAGE_MODEL,
    );

    if (children.length > 0) {
      return [{ ...runtimeNexusProvider, children }];
    }
  }

  if (!nexusImageModel) return [];

  return [
    {
      children: [
        {
          abilities: {},
          approximatePricePerImage: nexusImageModel.pricing?.approximatePricePerImage,
          description: nexusImageModel.description,
          displayName: nexusImageModel.displayName ?? NEXUS_IMAGE_MODEL,
          id: NEXUS_IMAGE_MODEL,
          parameters: (nexusImageModel as any).parameters,
          pricing: nexusImageModel.pricing,
          releasedAt: nexusImageModel.releasedAt,
        },
      ],
      id: NEXUS_IMAGE_PROVIDER,
      name: 'NEXUS',
      source: AiProviderSourceEnum.Builtin,
    },
  ];
};
