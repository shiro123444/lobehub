import { useSyncExternalStore } from 'react';

import { pluginSlotRegistry, type SlotRegistration } from './registry';

export const usePluginSlot = (slotId: string): SlotRegistration | undefined => {
  return useSyncExternalStore(
    pluginSlotRegistry.subscribe.bind(pluginSlotRegistry),
    () => pluginSlotRegistry.get(slotId),
    () => pluginSlotRegistry.get(slotId),
  );
};

export const useAllPluginSlots = (): SlotRegistration[] => {
  return useSyncExternalStore(
    pluginSlotRegistry.subscribe.bind(pluginSlotRegistry),
    () => pluginSlotRegistry.list(),
    () => pluginSlotRegistry.list(),
  );
};
