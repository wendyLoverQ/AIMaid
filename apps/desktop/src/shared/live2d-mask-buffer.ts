export type CubismMaskBufferPlan = {
  maskedDrawableCount: number
  uniqueClipGroupCount: number
  requiredRenderTextureCount: number
}

type CubismMaskModel = {
  getDrawableCount?: () => number
  getDrawableMaskCounts?: () => ArrayLike<number>
  getDrawableMasks?: () => ArrayLike<ArrayLike<number>>
}

/**
 * Cubism returns mask counts and mask index lists as drawable-indexed arrays.
 * One render texture can hold at most 36 clip groups; every additional texture
 * adds 32 groups in the Cubism Web renderer layout.
 */
export function createCubismMaskBufferPlan(coreModel: CubismMaskModel): CubismMaskBufferPlan {
  const drawableCount = coreModel.getDrawableCount?.() ?? 0
  if (drawableCount <= 0) {
    return { maskedDrawableCount: 0, uniqueClipGroupCount: 0, requiredRenderTextureCount: 1 }
  }

  const maskCounts = coreModel.getDrawableMaskCounts?.()
  const drawableMasks = coreModel.getDrawableMasks?.()
  if (maskCounts === undefined || drawableMasks === undefined) {
    throw new Error('Cubism mask metadata is unavailable')
  }

  let maskedDrawableCount = 0
  const clipGroups = new Set<string>()
  for (let drawableIndex = 0; drawableIndex < drawableCount; drawableIndex++) {
    const maskCount = Number(maskCounts[drawableIndex] ?? 0)
    if (!Number.isInteger(maskCount) || maskCount < 0) {
      throw new Error(`Invalid Cubism mask count at drawable ${drawableIndex}: ${maskCount}`)
    }
    if (maskCount === 0) continue

    const masks = drawableMasks[drawableIndex]
    if (masks === undefined || masks.length < maskCount) {
      throw new Error(`Cubism mask indices are incomplete at drawable ${drawableIndex}`)
    }
    const key = Array.from(masks).slice(0, maskCount).sort((a, b) => a - b).join(',')
    clipGroups.add(key)
    maskedDrawableCount++
  }

  const uniqueClipGroupCount = clipGroups.size
  const requiredRenderTextureCount = uniqueClipGroupCount <= 36
    ? 1
    : Math.ceil((uniqueClipGroupCount - 36) / 32) + 1

  return { maskedDrawableCount, uniqueClipGroupCount, requiredRenderTextureCount }
}
