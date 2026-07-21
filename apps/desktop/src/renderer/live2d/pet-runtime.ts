export interface PetRuntime {
  state: 'placeholder-ready'
}

export function createPetRuntime(): PetRuntime {
  // Phase 1 reserves the lazy-loaded PetWindow boundary without importing a Live2D SDK.
  return { state: 'placeholder-ready' }
}
