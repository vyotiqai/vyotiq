import { describe, expect, it } from 'vitest'
import { PROVIDER_DEFAULTS, seedModelsFor } from '@shared/domain/providers'

describe('seedModelsFor', () => {
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
