import { beforeAll, describe, expect, it } from 'vitest'
import { PROVIDER_DEFAULTS, seedModelsFor } from '@shared/domain/providers'
import { loadOpenCodeGoCatalog } from '@shared/domain/opencodeGoCatalog'

describe('seedModelsFor', () => {
  // OpenCode Go seeds are sourced live from the models.dev registry; warm it first.
  beforeAll(async () => {
    await loadOpenCodeGoCatalog()
  })

  it('marks every seed model as a placeholder so the UI can flag offline fallbacks', () => {
    for (const { id } of PROVIDER_DEFAULTS) {
      const models = seedModelsFor(id)
      expect(models.length).toBeGreaterThan(0)
      for (const model of models) {
        expect(model.isPlaceholder).toBe(true)
      }
    }
  })
})
