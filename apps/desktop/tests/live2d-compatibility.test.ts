import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { enrichLive2DModel, readMotionWithoutOutfitCurves } from '../src/main/services/pet-asset-service'
import { createCubismMaskBufferPlan } from '../src/shared/live2d-mask-buffer'
import { resolveLive2DAction } from '../src/shared/live2d-action-tag'

describe('Live2D compatibility', () => {
  it('reads Cubism mask metadata from drawable-indexed arrays', () => {
    const maskCounts = new Uint32Array(70).fill(1)
    const masks = Array.from({ length: 70 }, (_, index) => new Uint32Array([index]))
    const plan = createCubismMaskBufferPlan({
      getDrawableCount: () => 70,
      getDrawableMaskCounts: () => maskCounts,
      getDrawableMasks: () => masks
    })

    expect(plan).toEqual({
      maskedDrawableCount: 70,
      uniqueClipGroupCount: 70,
      requiredRenderTextureCount: 3
    })
  })

  it('registers adjacent actions and strips outfit curves from click motions', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'aimaid-live2d-actions-'))
    try {
      const modelPath = join(root, 'model.model3.json')
      const motionPath = join(root, 'tixie.motion3.json')
      writeFileSync(modelPath, JSON.stringify({
        Version: 3,
        FileReferences: { Moc: 'model.moc3', Textures: [] }
      }))
      writeFileSync(join(root, 'xie.exp3.json'), JSON.stringify({
        Type: 'Live2D Expression',
        Parameters: [{ Id: 'Param31', Value: 1, Blend: 'Overwrite' }]
      }))
      writeFileSync(join(root, 'smile.exp3.json'), JSON.stringify({
        Type: 'Live2D Expression',
        Parameters: [{ Id: 'ParamMouthForm', Value: 1, Blend: 'Add' }]
      }))
      writeFileSync(motionPath, JSON.stringify({
        Meta: { CurveCount: 2 },
        Curves: [
          { Target: 'Parameter', Id: 'Param31', Segments: [] },
          { Target: 'Parameter', Id: 'ParamAngleX', Segments: [] }
        ]
      }))
      writeFileSync(join(root, 'model.vtube.json'), JSON.stringify({
        Hotkeys: [{
          Name: '脱鞋动作',
          Action: 'TriggerAnimation',
          File: 'tixie.motion3.json',
          IsActive: true,
          Triggers: { Trigger1: 'N1', Trigger2: '', Trigger3: '' }
        }]
      }))

      const enriched = await enrichLive2DModel(modelPath)
      const model = JSON.parse(enriched.data.toString('utf8')) as {
        FileReferences: { Expressions: Array<{ File: string }>; Motions: Record<string, Array<{ File: string }>> }
        AIMaidHotkeys: Array<{ action: string; file: string; triggers: string[] }>
      }
      expect(model.FileReferences.Expressions.map((item) => item.File)).toEqual(['smile.exp3.json', 'xie.exp3.json'])
      expect(model.FileReferences.Motions.TapLeg).toEqual([{ File: 'tixie.motion3.json' }])
      expect(model.AIMaidHotkeys).toEqual([{
        name: '脱鞋动作', action: 'TriggerAnimation', file: 'tixie.motion3.json', triggers: ['N1']
      }])

      const protectedIds = enriched.motionOutfitParameterIds.get(normalizePath(motionPath))
      expect(protectedIds).toEqual(new Set(['Param31']))
      const filtered = await readMotionWithoutOutfitCurves(motionPath, protectedIds)
      const motion = JSON.parse(filtered.data.toString('utf8')) as {
        Meta: { CurveCount: number }
        Curves: Array<{ Id: string }>
      }
      expect(filtered.removedCurveCount).toBe(1)
      expect(motion.Meta.CurveCount).toBe(1)
      expect(motion.Curves.map((curve) => curve.Id)).toEqual(['ParamAngleX'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves automatic head and body actions against the loaded model', () => {
    const map = {
      idle: { motionGroups: [], expressions: ['normal'], fallback: 'idle' },
      smile: { motionGroups: [], expressions: ['smile'], fallback: 'idle' },
      touch_head: { motionGroups: ['TapHead', 'TapBody'], expressions: ['happy'], fallback: 'smile' },
      touch_body: { motionGroups: ['TapBody'], expressions: ['annoyed'], fallback: 'smile' }
    }

    expect(resolveLive2DAction(map, 'touch_head', ['taphead'], ['Happy'])).toEqual({
      requestedTag: 'touch_head', resolvedTag: 'touch_head', motionGroup: 'taphead', expression: 'Happy'
    })
    expect(resolveLive2DAction(map, 'touch_body', ['TapLeg', 'TapBody'], [], ['TapLeg'])).toEqual({
      requestedTag: 'touch_body', resolvedTag: 'touch_body', motionGroup: 'TapLeg', expression: null
    })
  })
})

function normalizePath(value: string): string {
  return resolve(value).replaceAll('\\', '/').toLowerCase()
}
