import { Application, Container, Matrix, Point, RenderTexture, Ticker } from 'pixi.js';
import '@pixi/unsafe-eval';
import type { Live2DModel as Live2DModelType } from 'pixi-live2d-display-lipsyncpatch/cubism4';
import { assertModelJson } from './modelLoader';
import { loadLive2DActionTagMap, resolveLive2DAction } from '../../../shared/live2d-action-tag';
import type { Live2DActionTagMap } from '../../../shared/live2d-action-tag';
import { createCubismMaskBufferPlan } from '../../../shared/live2d-mask-buffer';
import { buildOuterAlphaContour } from '../../../shared/alpha-contour';
import type { AlphaContour } from '../../../shared/alpha-contour';
import { PET_BASE_WINDOW_HEIGHT, PET_BASE_WINDOW_WIDTH, PET_ITEM_PADDING } from '../../../shared/pet-geometry';
import type { PetLipSyncFrame, PetLipSyncSource } from '../../../shared/pet';

let Live2DModel: typeof Live2DModelType | null = null;

export type BodyPart = 'head' | 'face' | 'hair' | 'body' | 'hand' | 'leg' | 'other';

type OutfitRegion = BodyPart | 'whole';

type OutfitParameter = {
  id: string;
  value: number;
  blend: 'Add' | 'Multiply' | 'Overwrite';
};

type OutfitOption = {
  name: string;
  region: OutfitRegion;
  parameters: OutfitParameter[];
};

type ModelHotkey = {
  name: string;
  action: 'ToggleExpression' | 'TriggerAnimation' | 'RemoveAllExpressions';
  file: string;
  triggers: string[];
};

type LoadedLive2DModel = Container & {
  width: number;
  height: number;
  x: number;
  y: number;
  scale: { set: (x: number, y?: number) => void; x: number; y: number };
  anchor: { set: (x: number, y: number) => void };
  children: unknown[];
  getBounds: () => { x: number; y: number; width: number; height: number };
  destroy: (options?: { children?: boolean }) => void;
  internalModel?: {
    width?: number;
    height?: number;
    originalWidth?: number;
    originalHeight?: number;
  };
  motion: (group: string, index?: number) => Promise<unknown>;
  expression: (name: string | number) => void;
};

const MIN_USER_SCALE = 0.2;
export class Live2DPlayer {
  private app: Application;
  private model: LoadedLive2DModel | null = null;
  private live2dModel: Live2DModelType | null = null;
  private userScale = 1;
  private baseFitScale = 1;
  private cubismCoreLoaded = false;
  private pixiInitialized = false;
  private lastPlacementLogAt = 0;
  private baseFitCalculated = false;
  private canvasWidth = 0;
  private canvasHeight = 0;
  private placementX: number | null = null;
  private placementY: number | null = null;
  private motionGroupCounts = new Map<string, number>();
  private motionGroupFiles = new Map<string, string[]>();
  private expressionNames: string[] = [];
  private expressionFileNames = new Map<string, string>();
  private modelHotkeys: ModelHotkey[] = [];
  private activeHotkeyExpression: string | null = null;
  private actionTagMap: Live2DActionTagMap = {};
  private partDisplayNames = new Map<string, string>();
  private outfitOptions: OutfitOption[] = [];
  private outfitSelections = new Map<string, number>();
  private outfitControlledParameterIds = new Set<string>();
  private contourRenderTexture: RenderTexture | null = null;
  private lipSyncFrames = new Map<PetLipSyncSource, PetLipSyncFrame>();
  private mouthWasAudioDriven = false;
  private missingMouthParameterLogged = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.app = null as unknown as Application;
  }

  get currentModel(): LoadedLive2DModel | null {
    return this.model;
  }

  get currentScale(): number {
    return this.userScale;
  }

  containsClientPoint(clientX: number, clientY: number): boolean {
    return this.containsPoint(clientX, clientY);
  }

  /**
   * Compute the current model geometry in window-relative DIP coordinates
   * (Pixi stage coords == window DIP coords because autoDensity + resolution
   * = devicePixelRatio). Main process adds window bounds to convert these
   * to screenDip before sending to AI_maid.
   *
   * Returns null if no model is loaded or bounds are unavailable.
   */
  getModelGeometry(): {
    modelBounds: { x: number; y: number; width: number; height: number };
    anchors: {
      modelCenter: { x: number; y: number };
      headTop: { x: number; y: number };
      faceCenter: { x: number; y: number };
      bodyCenter: { x: number; y: number };
      feetCenter: { x: number; y: number };
    };
    parts: Array<{
      id: string;
      name: string;
      visible: boolean;
      bounds: { x: number; y: number; width: number; height: number };
      anchor: { x: number; y: number };
    }>;
    scale: number;
  } | null {
    if (!this.model) {
      return null;
    }

    let bounds: { x: number; y: number; width: number; height: number };
    try {
      bounds = this.model.getBounds();
    } catch {
      return null;
    }

    if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) ||
        bounds.width <= 0 || bounds.height <= 0) {
      return null;
    }

    const centerX = bounds.x + bounds.width / 2;
    const topY = bounds.y;
    const bottomY = bounds.y + bounds.height;

    const anchors = {
      modelCenter: { x: centerX, y: bounds.y + bounds.height / 2 },
      headTop: { x: centerX, y: topY },
      faceCenter: { x: centerX, y: bounds.y + bounds.height * 0.15 },
      bodyCenter: { x: centerX, y: bounds.y + bounds.height * 0.5 },
      feetCenter: { x: centerX, y: bottomY }
    };

    // Body part regions based on the existing resolveBodyPart normalizedY
    // thresholds (head < 0.28, face < 0.45, body < 0.75, leg otherwise).
    // Live has no explicit body part config — derive from model bounds.
    const headEnd = bounds.y + bounds.height * 0.28;
    const faceEnd = bounds.y + bounds.height * 0.45;
    const bodyEnd = bounds.y + bounds.height * 0.75;

    const makePart = (
      id: string,
      name: string,
      yStart: number,
      yEnd: number
    ) => {
      const partBounds = {
        x: bounds.x,
        y: yStart,
        width: bounds.width,
        height: yEnd - yStart
      };
      return {
        id,
        name,
        visible: true,
        bounds: partBounds,
        anchor: { x: centerX, y: yStart + (yEnd - yStart) / 2 }
      };
    };

    const parts = [
      makePart('head', '头部', topY, headEnd),
      makePart('face', '脸部', headEnd, faceEnd),
      makePart('body', '身体', faceEnd, bodyEnd),
      makePart('leg', '腿部', bodyEnd, bottomY)
    ];

    return {
      modelBounds: bounds,
      anchors,
      parts,
      scale: this.userScale
    };
  }

  clientToPixiPoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const screenWidth = this.canvasWidth || window.innerWidth || this.canvas.clientWidth;
    const screenHeight = this.canvasHeight || window.innerHeight || this.canvas.clientHeight;
    return {
      x: (clientX - rect.left) * (screenWidth / rect.width),
      y: (clientY - rect.top) * (screenHeight / rect.height)
    };
  }

  async loadModel(modelUrl: string, cubismCoreUrl: string): Promise<void> {
    console.info('[Live2D] ' + JSON.stringify({
      event: 'loadModel_start',
      modelUrl,
      cubismCoreUrl
    }));

    await this.ensureCubismCore(cubismCoreUrl);
    await this.initializePixi();

    const modelJsonResponse = await fetch(modelUrl);
    const modelJson = await modelJsonResponse.json();
    this.actionTagMap = await loadLive2DActionTagMap();

    this.motionGroupCounts = new Map(
      Object.entries(modelJson.FileReferences?.Motions ?? {}).map(([group, definitions]) => [
        group,
        Array.isArray(definitions) ? definitions.length : 0
      ])
    );
    this.motionGroupFiles = new Map(
      Object.entries(modelJson.FileReferences?.Motions ?? {}).map(([group, definitions]) => [
        group,
        Array.isArray(definitions)
          ? definitions
            .map((definition: { File?: unknown }) => definition?.File)
            .filter((file: unknown): file is string => typeof file === 'string' && file.length > 0)
          : []
      ])
    );
    this.expressionNames = Array.isArray(modelJson.FileReferences?.Expressions)
      ? modelJson.FileReferences.Expressions
        .map((definition: { Name?: unknown }) => definition?.Name)
        .filter((name: unknown): name is string => typeof name === 'string' && name.length > 0)
      : [];
    this.expressionFileNames = new Map(
      (Array.isArray(modelJson.FileReferences?.Expressions) ? modelJson.FileReferences.Expressions : [])
        .flatMap((definition: { Name?: unknown; File?: unknown }) =>
          typeof definition.Name === 'string' && typeof definition.File === 'string'
            ? [[normalizeModelAssetPath(definition.File), definition.Name] as const]
            : [])
    );
    this.modelHotkeys = Array.isArray(modelJson.AIMaidHotkeys)
      ? modelJson.AIMaidHotkeys.filter(isModelHotkey)
      : [];
    this.activeHotkeyExpression = null;
    this.partDisplayNames = await this.loadPartDisplayNames(modelJson, modelUrl);
    this.outfitOptions = await this.loadOutfitOptions(modelJson, modelUrl);
    this.outfitControlledParameterIds = new Set(
      this.outfitOptions.flatMap((option) => option.parameters.map((parameter) => parameter.id))
    );
    this.outfitSelections.clear();

    console.info('[Live2D] Version info: ' + JSON.stringify({
      pixiVersion: (Application as any).VERSION || (window as any).PIXI?.VERSION || 'unknown',
      engine: 'pixi-live2d-display-lipsyncpatch',
      cubismCoreVersion: (window as any).Live2DCubismCore?.Version?.csmGetVersion?.() ?? 'unknown',
      modelJsonVersion: modelJson.Version,
      modelUrl,
      mocFile: modelJson.FileReferences?.Moc,
      textureFiles: modelJson.FileReferences?.Textures,
      physicsFile: modelJson.FileReferences?.Physics,
      poseFile: modelJson.FileReferences?.Pose
    }));

    await assertModelJson(modelUrl);

    if (this.model) {
      this.app.stage.removeChild(this.model);
      this.model.destroy({ children: true });
      this.model = null;
      this.live2dModel = null;
    }

    this.baseFitCalculated = false;

    const live2dModel = await Live2DModel!.from(modelUrl, {
      ticker: this.app.ticker
    });

    this.live2dModel = live2dModel;
    this.missingMouthParameterLogged = false;
    this.mouthWasAudioDriven = false;
    this.app.stage.addChild(live2dModel);

    const anyLive2dModel = live2dModel as any;
    const internalModel = anyLive2dModel.internalModel;
    // Establish persistent outfit values before motion/expression evaluation.
    // Motions must be allowed to animate the same parameters afterwards.
    internalModel?.on?.('beforeMotionUpdate', () => this.applyOutfitOverrides());
    internalModel?.on?.('beforeModelUpdate', () => this.applyLipSync());

    console.info('[Live2D] Model loaded: ' + JSON.stringify({
      hasInternalModel: !!internalModel,
      hasCoreModel: !!internalModel?.coreModel,
      textureCount: (live2dModel as any).textures?.length ?? 0,
      texturesValid: (live2dModel as any).textures?.map((t: any) => t?.valid ?? false),
      cubismCoreVersion: (window as any).Live2DCubismCore?.Version?.csmGetVersion?.() ?? 'unknown'
    }));

    this.ensureEnoughMaskRenderTextures(internalModel);

    const originalWidth = (live2dModel as any).internalModel?.width || live2dModel.width || 0;
    const originalHeight = (live2dModel as any).internalModel?.height || live2dModel.height || 0;

    console.info('[Live2D] Model state after load: ' + JSON.stringify({
      modelWidth: live2dModel.width,
      modelHeight: live2dModel.height,
      modelX: live2dModel.x,
      modelY: live2dModel.y,
      modelScaleX: live2dModel.scale.x,
      modelScaleY: live2dModel.scale.y,
      modelVisible: live2dModel.visible,
      modelAlpha: live2dModel.alpha,
      internalWidth: originalWidth,
      internalHeight: originalHeight,
      bounds: live2dModel.getBounds()
    }));

    const wrappedModel = this.wrapModel(live2dModel, originalWidth, originalHeight);
    this.model = wrappedModel;

    this.dumpModelInfo(modelJson, originalWidth, originalHeight);
    this.calcBaseFit(originalWidth, originalHeight);
    this.applyTransform('loadModel');
  }

  async playClickMotion(bodyPart: 'head' | 'face' | 'hair' | 'body' | 'hand' | 'leg' | 'other'): Promise<boolean> {
    const head = bodyPart === 'head' || bodyPart === 'face' || bodyPart === 'hair';
    const preferredGroups = head ? ['TapHead', 'TapBody'] : bodyPart === 'leg' ? ['TapLeg', 'TapBody'] : ['TapBody'];
    return this.applyActionTag(head ? 'touch_head' : 'touch_body', preferredGroups);
  }

  setLipSyncFrame(frame: PetLipSyncFrame): void {
    if (frame.active) this.lipSyncFrames.set(frame.source, frame);
    else this.lipSyncFrames.delete(frame.source);
  }

  async applyActionTag(tag: string, preferredMotionGroups: readonly string[] = []): Promise<boolean> {
    if (!this.model) return false;
    const resolved = resolveLive2DAction(
      this.actionTagMap,
      tag,
      this.motionGroupCounts.keys(),
      this.expressionNames,
      preferredMotionGroups
    );
    if (resolved === null) {
      console.info('[ActionTag] no supported model action ' + JSON.stringify({ tag }));
      return false;
    }

    let motionIndex: number | null = null;
    let motionFile: string | undefined;
    if (resolved.motionGroup !== null) {
      const count = this.motionGroupCounts.get(resolved.motionGroup) ?? 0;
      if (count <= 0) throw new Error(`Resolved Live2D motion group is empty: ${resolved.motionGroup}`);
      motionIndex = Math.floor(Math.random() * count);
      motionFile = this.motionGroupFiles.get(resolved.motionGroup)?.[motionIndex];
      await this.model.motion(resolved.motionGroup, motionIndex);
    }
    if (resolved.expression !== null) {
      this.model.expression(resolved.expression);
      this.activeHotkeyExpression = resolved.expression;
    }

    console.info('[ActionTag] model action completed ' + JSON.stringify({
      ...resolved,
      motionIndex,
      motionFile
    }));
    return true;
  }

  async handleModelHotkey(event: KeyboardEvent): Promise<boolean> {
    if (!this.model || event.repeat) return false;
    const hotkey = this.modelHotkeys.find((candidate) => matchesModelHotkey(candidate.triggers, event));
    if (!hotkey) return false;

    console.info('[Hotkey] Live2D model shortcut requested ' + JSON.stringify({
      name: hotkey.name,
      action: hotkey.action,
      file: hotkey.file,
      triggers: hotkey.triggers
    }));

    if (hotkey.action === 'RemoveAllExpressions') {
      this.resetExpression();
    } else if (hotkey.action === 'ToggleExpression') {
      const expressionName = this.expressionFileNames.get(normalizeModelAssetPath(hotkey.file));
      if (!expressionName) throw new Error(`Live2D hotkey expression is not registered: ${hotkey.file}`);
      if (this.activeHotkeyExpression === expressionName) {
        this.resetExpression();
      } else {
        this.model.expression(expressionName);
        this.activeHotkeyExpression = expressionName;
      }
    } else {
      const normalizedFile = normalizeModelAssetPath(hotkey.file);
      const motion = [...this.motionGroupFiles].flatMap(([group, files]) =>
        files.map((file, index) => ({ group, index, file: normalizeModelAssetPath(file) })))
        .find((candidate) => candidate.file === normalizedFile);
      if (!motion) throw new Error(`Live2D hotkey motion is not registered: ${hotkey.file}`);
      await this.model.motion(motion.group, motion.index);
    }

    console.info('[Hotkey] Live2D model shortcut completed ' + JSON.stringify({
      name: hotkey.name,
      action: hotkey.action,
      file: hotkey.file,
      triggers: hotkey.triggers
    }));
    return true;
  }

  hasModelHotkey(event: KeyboardEvent): boolean {
    return !event.repeat && this.modelHotkeys.some((candidate) => matchesModelHotkey(candidate.triggers, event));
  }

  cycleOutfit(bodyPart: BodyPart): { name: string; region: string } | null {
    if (!this.live2dModel || this.outfitOptions.length === 0) return null;

    const requestedRegions: OutfitRegion[] = bodyPart === 'head' || bodyPart === 'face' || bodyPart === 'hair'
      ? ['hair', 'head', 'face']
      : [bodyPart];
    let options = this.outfitOptions.filter((option) => requestedRegions.includes(option.region));
    let selectionKey = requestedRegions.join('+');

    if (options.length === 0) {
      options = this.outfitOptions.filter((option) => option.region === 'whole');
      selectionKey = 'whole';
    }
    if (options.length === 0) return null;

    if (selectionKey === 'whole') {
      this.outfitSelections.clear();
    } else {
      this.outfitSelections.delete('whole');
    }

    const current = this.outfitSelections.get(selectionKey) ?? -1;
    const next = current >= options.length - 1 ? -1 : current + 1;
    if (next < 0) {
      this.outfitSelections.delete(selectionKey);
      console.info('[Outfit] restored default', { region: selectionKey });
      return { name: 'default', region: selectionKey };
    }

    this.outfitSelections.set(selectionKey, next);
    const option = options[next]!;
    console.info('[Outfit] changed', { region: selectionKey, option: option.name });
    return { name: option.name, region: selectionKey };
  }

  resetOutfit(): boolean {
    const hadSelections = this.outfitSelections.size > 0;
    this.outfitSelections.clear();
    console.info('[Outfit] restored all defaults');
    return hadSelections;
  }

  getOutfitState(): Record<string, string> {
    const state: Record<string, string> = {};
    for (const [selectionKey, selectedIndex] of this.outfitSelections) {
      const regions = selectionKey === 'whole' ? ['whole'] : selectionKey.split('+');
      const options = this.outfitOptions.filter((option) => regions.includes(option.region));
      if (options[selectedIndex]) state[selectionKey] = options[selectedIndex].name;
    }
    return state;
  }

  restoreOutfitState(state: Record<string, string> | null | undefined): void {
    this.outfitSelections.clear();
    if (!state || typeof state !== 'object') return;
    for (const [selectionKey, optionName] of Object.entries(state)) {
      if (typeof optionName !== 'string') continue;
      const regions = selectionKey === 'whole' ? ['whole'] : selectionKey.split('+');
      const options = this.outfitOptions.filter((option) => regions.includes(option.region));
      const selectedIndex = options.findIndex((option) => option.name === optionName);
      if (selectedIndex >= 0) this.outfitSelections.set(selectionKey, selectedIndex);
    }
    console.info('[Outfit] restored persisted state', this.getOutfitState());
  }

  applyVoiceStyleExpression(style: 'normal' | 'soft' | 'lively' | 'close'): string | null {
    if (!this.model) return null;
    if (style === 'normal') {
      return null;
    }

    const patterns: Record<'soft' | 'lively' | 'close', RegExp[]> = {
      soft: [/害羞|shy|shyness|脸红|lianhong|blush/i, /悲|sad|泪|tear|cry/i],
      lively: [/星星|xingxing|star|惊讶|surprise/i, /爱心|aixin|love|heart|happy|smile/i],
      close: [/爱心|aixin|love|heart/i, /害羞|shy|shyness|脸红|lianhong|blush/i]
    };
    const name = patterns[style]
      .map((pattern) => this.expressionNames.find((candidate) => pattern.test(candidate)))
      .find((candidate): candidate is string => typeof candidate === 'string');
    if (!name) return null;
    this.model.expression(name);
    return name;
  }

  resetExpression(): void {
    const expressionManager = (this.live2dModel as any)?.internalModel?.motionManager?.expressionManager;
    if (typeof expressionManager?.resetExpression === 'function') {
      expressionManager.resetExpression();
    }
    this.activeHotkeyExpression = null;
  }

  setUserScale(scale: number): number {
    this.userScale = Number.isFinite(scale) ? Math.max(MIN_USER_SCALE, scale) : this.userScale;
    this.applyTransform('setUserScale');
    return this.userScale;
  }

  handleWindowResize(): void {
    if (!this.model || !this.app.renderer) {
      return;
    }

    const { width: newWidth, height: newHeight } = this.readViewportSize();

    if (Math.abs(newWidth - this.canvasWidth) < 1 && Math.abs(newHeight - this.canvasHeight) < 1) {
      return;
    }

    this.canvasWidth = newWidth;
    this.canvasHeight = newHeight;
    this.app.renderer.resize(newWidth, newHeight);
    this.applyTransform('handleWindowResize');
  }

  suspend(): void {
    if (this.pixiInitialized) this.app.stop();
  }

  resume(): void {
    if (this.pixiInitialized) this.app.start();
  }

  dispose(): void {
    this.lipSyncFrames.clear();
    this.mouthWasAudioDriven = false;
    this.contourRenderTexture?.destroy(true);
    this.contourRenderTexture = null;
    if (this.model) {
      this.app.stage.removeChild(this.model);
      this.model.destroy({ children: true });
      this.model = null;
      this.live2dModel = null;
    }
    if (this.pixiInitialized) {
      this.app.stop();
      this.app.destroy(false, { children: true, texture: true, baseTexture: true });
      this.pixiInitialized = false;
    }
  }

  getRenderMetrics(): { canvasWidth: number; canvasHeight: number; backingWidth: number; backingHeight: number; renderPixelRatio: number } {
    return {
      canvasWidth: this.canvas.clientWidth,
      canvasHeight: this.canvas.clientHeight,
      backingWidth: this.canvas.width,
      backingHeight: this.canvas.height,
      renderPixelRatio: this.canvas.clientWidth > 0 ? this.canvas.width / this.canvas.clientWidth : 1
    };
  }

  containsPoint(clientX: number, clientY: number): boolean {
    if (!this.model) return false;
    return this.hitTest(clientX, clientY).length > 0 || this.resolveAutoHitArea(clientX, clientY) !== null;
  }

  /**
   * Returns the names of hit areas that contain the given client-space point.
   * Returns an empty array if the model has no hit areas or hit testing fails.
   * Uses the underlying pixi-live2d-display hitTest API (model-local coords).
   */
  hitTest(clientX: number, clientY: number): string[] {
    if (!this.live2dModel) {
      return [];
    }

    try {
      const point = this.clientToPixiPoint(clientX, clientY);
      // pixi-live2d-display hitTest expects model-local coordinates,
      // which are the same as Pixi stage coordinates since the model is on the stage.
      const hitFn = (this.live2dModel as any).hitTest;
      if (typeof hitFn !== 'function') {
        return [];
      }
      const result = hitFn.call(this.live2dModel, point.x, point.y);
      return Array.isArray(result) ? result.filter((n: unknown) => typeof n === 'string') : [];
    } catch (e) {
      console.warn('[Live2DPlayer] hitTest failed', e);
      return [];
    }
  }

  /**
   * Resolve a click to a semantic body part without requiring model3.json
   * HitAreas. The current frame's deformed drawable triangles are tested from
   * front to back, then their parent Part hierarchy is classified using CDI
   * display names. Geometry is used only as a final fallback.
   */
  resolveAutoHitArea(clientX: number, clientY: number): BodyPart | null {
    if (!this.live2dModel) return null;

    try {
      const stagePoint = this.clientToPixiPoint(clientX, clientY);
      const modelPoint = (this.live2dModel as any).toModelPosition(new Point(stagePoint.x, stagePoint.y)) as Point;
      const internalModel = (this.live2dModel as any).internalModel;
      const coreModel = internalModel?.coreModel;
      if (!coreModel || !internalModel) return null;

      const drawableCount = coreModel.getDrawableCount?.() ?? 0;
      const renderOrders = coreModel.getDrawableRenderOrders?.();
      const drawables = Array.from({ length: drawableCount }, (_, index) => index)
        .sort((a, b) => (renderOrders?.[b] ?? b) - (renderOrders?.[a] ?? a));

      let hitUnknownDrawable = false;
      for (const drawableIndex of drawables) {
        const opacity = coreModel.getDrawableOpacity?.(drawableIndex) ?? 1;
        const visible = coreModel.getDrawableDynamicFlagIsVisible?.(drawableIndex) ?? true;
        if (!visible || opacity <= 0.02) continue;

        const vertices = internalModel.getDrawableVertices(drawableIndex) as Float32Array;
        const indices = coreModel.getDrawableVertexIndices?.(drawableIndex) as Uint16Array | undefined;
        if (!vertices?.length || !indices?.length || !pointInDrawable(modelPoint.x, modelPoint.y, vertices, indices)) {
          continue;
        }

        const part = this.classifyDrawablePart(coreModel, drawableIndex);
        if (part !== 'other') return part;
        hitUnknownDrawable = true;
      }

      if (!hitUnknownDrawable) return null;
      const height = Number(internalModel.height) || 1;
      const yRatio = modelPoint.y / height;
      if (yRatio < 0.28) return 'head';
      if (yRatio < 0.42) return 'face';
      if (yRatio < 0.76) return 'body';
      return 'leg';
    } catch (error) {
      console.warn('[Live2DPlayer] automatic hit-area resolution failed', error);
      return null;
    }
  }

  /**
   * Outfit selection uses the physical area of the character as a guardrail.
   * A long skirt or coat often sits in front of the legs and is labelled as
   * clothing/body, so drawable semantics alone would change the torso outfit
   * when the user visibly clicked the legs.
   */
  resolveOutfitHitArea(clientX: number, clientY: number): BodyPart {
    const semanticPart = this.resolveAutoHitArea(clientX, clientY) ?? 'other';
    if (semanticPart === 'hand') return 'hand';

    try {
      if (this.live2dModel) {
        const stagePoint = this.clientToPixiPoint(clientX, clientY);
        const modelPoint = (this.live2dModel as any).toModelPosition(new Point(stagePoint.x, stagePoint.y)) as Point;
        const height = Number((this.live2dModel as any).internalModel?.height) || 1;
        const yRatio = modelPoint.y / height;
        const hasLegOutfit = this.outfitOptions.some((option) => option.region === 'leg');
        if (hasLegOutfit && yRatio >= 0.6) return 'leg';
        if (yRatio >= 0.35) return 'body';
      }
    } catch (error) {
      console.warn('[Outfit] spatial hit-area guard failed', error);
    }

    return semanticPart === 'hair' || semanticPart === 'face' || semanticPart === 'head'
      ? semanticPart
      : 'head';
  }

  private ensureEnoughMaskRenderTextures(internalModel: any): void {
    const renderer = internalModel?.renderer;
    const coreModel = internalModel?.coreModel;
    if (!renderer || !coreModel) {
      return;
    }

    const plan = createCubismMaskBufferPlan(coreModel);
    const currentCount = renderer.getRenderTextureCount?.() ?? 1;

    console.info('[Live2D] Mask stats: ' + JSON.stringify({
      drawableCount: coreModel.getDrawableCount?.() ?? 0,
      totalMaskedDrawables: plan.maskedDrawableCount,
      uniqueClipGroups: plan.uniqueClipGroupCount,
      currentRenderTextureCount: currentCount,
      neededRenderTextureCount: plan.requiredRenderTextureCount
    }));

    if (plan.requiredRenderTextureCount > currentCount && typeof renderer.initialize === 'function') {
      console.info('[Live2D] Re-initializing renderer with maskBufferCount = ' + plan.requiredRenderTextureCount);
      try {
        const oldTextures = renderer._textures;
        renderer.initialize(coreModel, plan.requiredRenderTextureCount);
        if (oldTextures) {
          for (let i = 0; i < oldTextures.length; i++) {
            if (oldTextures[i]) {
              renderer.bindTexture(i, oldTextures[i]);
            }
          }
        }
        console.info('[Live2D] Renderer re-initialized successfully');
      } catch (e) {
        console.error('[Live2D] Failed to re-initialize renderer:', e);
      }
    }
  }

  private async loadPartDisplayNames(modelJson: any, modelUrl: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const displayInfo = modelJson.FileReferences?.DisplayInfo;
    if (typeof displayInfo !== 'string' || displayInfo.length === 0) return result;
    try {
      const response = await fetch(new URL(displayInfo, modelUrl).toString());
      if (!response.ok) return result;
      const json = await response.json();
      if (!Array.isArray(json?.Parts)) return result;
      for (const part of json.Parts) {
        if (typeof part?.Id === 'string' && typeof part?.Name === 'string') {
          result.set(part.Id, part.Name);
        }
      }
    } catch (error) {
      console.warn('[Live2DPlayer] display info unavailable for automatic hit areas', error);
    }
    return result;
  }

  private async loadOutfitOptions(modelJson: any, modelUrl: string): Promise<OutfitOption[]> {
    const definitions = modelJson.FileReferences?.Expressions;
    if (!Array.isArray(definitions)) return [];

    const options = await Promise.all(definitions.map(async (definition: any): Promise<OutfitOption | null> => {
      if (typeof definition?.Name !== 'string' || typeof definition?.File !== 'string') return null;
      const region = classifyOutfitExpression(`${definition.Name} ${definition.File}`);
      if (!region) return null;
      try {
        const response = await fetch(new URL(definition.File, modelUrl).toString());
        if (!response.ok) return null;
        const expression = await response.json();
        const parameters = Array.isArray(expression?.Parameters)
          ? expression.Parameters.flatMap((parameter: any): OutfitParameter[] => {
            if (typeof parameter?.Id !== 'string' || !Number.isFinite(parameter?.Value)) return [];
            const blend = parameter.Blend === 'Multiply' || parameter.Blend === 'Overwrite'
              ? parameter.Blend
              : 'Add';
            return [{ id: parameter.Id, value: parameter.Value, blend }];
          })
          : [];
        return parameters.length > 0 ? { name: definition.Name, region, parameters } : null;
      } catch (error) {
        console.warn('[Outfit] failed to inspect expression', { name: definition.Name, error });
        return null;
      }
    }));

    const resolved = options.filter((option): option is OutfitOption => option !== null);
    console.info('[Outfit] discovered options', resolved.map(({ name, region }) => ({ name, region })));
    return resolved;
  }

  private applyOutfitOverrides(): void {
    const coreModel = (this.live2dModel as any)?.internalModel?.coreModel;
    if (!coreModel || this.outfitControlledParameterIds.size === 0) return;

    for (const parameterId of this.outfitControlledParameterIds) {
      const parameterIndex = coreModel.getParameterIndex?.(parameterId) ?? -1;
      if (parameterIndex >= 0) {
        const defaultValue = coreModel.getParameterDefaultValue?.(parameterIndex) ?? 0;
        coreModel.setParameterValueByIndex?.(parameterIndex, defaultValue);
      }
    }

    for (const [selectionKey, selectedIndex] of this.outfitSelections) {
      const regions = selectionKey === 'whole'
        ? ['whole']
        : selectionKey.split('+');
      const options = this.outfitOptions.filter((option) => regions.includes(option.region));
      const option = options[selectedIndex];
      if (!option) continue;
      for (const parameter of option.parameters) {
        const parameterIndex = coreModel.getParameterIndex?.(parameter.id) ?? -1;
        if (parameterIndex < 0) continue;
        const defaultValue = coreModel.getParameterDefaultValue?.(parameterIndex) ?? 0;
        const value = parameter.blend === 'Multiply'
          ? defaultValue * parameter.value
          : parameter.blend === 'Overwrite'
            ? parameter.value
            : defaultValue + parameter.value;
        coreModel.setParameterValueByIndex?.(parameterIndex, value);
      }
    }

  }

  setViewportPlacement(x: number, y: number): void {
    this.placementX = Number.isFinite(x) ? x : this.placementX;
    this.placementY = Number.isFinite(y) ? y : this.placementY;
    this.applyTransform('setViewportPlacement');
  }

  private applyLipSync(): void {
    const coreModel = (this.live2dModel as any)?.internalModel?.coreModel;
    if (!coreModel) return;

    const now = Date.now();
    for (const [source, frame] of this.lipSyncFrames) {
      if (now - frame.timestamp > 250) this.lipSyncFrames.delete(source);
    }

    if (this.lipSyncFrames.size === 0 && !this.mouthWasAudioDriven) return;
    const parameterIndex = coreModel.getParameterIndex?.('ParamMouthOpenY') ?? -1;
    if (parameterIndex < 0) {
      if (!this.missingMouthParameterLogged) {
        this.missingMouthParameterLogged = true;
        console.error('[Live2D] Active model does not expose ParamMouthOpenY; audio lip sync cannot run');
      }
      this.mouthWasAudioDriven = false;
      return;
    }

    let level = 0;
    for (const frame of this.lipSyncFrames.values()) level = Math.max(level, frame.level);
    coreModel.setParameterValueByIndex?.(parameterIndex, level);
    this.mouthWasAudioDriven = this.lipSyncFrames.size > 0;
  }

  private classifyDrawablePart(coreModel: any, drawableIndex: number): BodyPart {
    let partIndex = coreModel.getDrawableParentPartIndex?.(drawableIndex) ?? -1;
    const parentIndices = coreModel.getModel?.()?.parts?.parentIndices as Int32Array | undefined;
    const labels: string[] = [];
    const visited = new Set<number>();
    while (partIndex >= 0 && !visited.has(partIndex)) {
      visited.add(partIndex);
      const partId = coreModel.getPartId?.(partIndex);
      if (typeof partId === 'string') {
        labels.push(this.partDisplayNames.get(partId) ?? '', partId);
      }
      partIndex = parentIndices?.[partIndex] ?? -1;
    }
    return classifyBodyPartLabel(labels.join(' '));
  }

  private wrapModel(live2dModel: Live2DModelType, originalWidth: number, originalHeight: number): LoadedLive2DModel {
    const model = live2dModel as unknown as LoadedLive2DModel;

    const originalMotion = (live2dModel as any).motion;
    model.motion = async (group: string, index?: number) => {
      return originalMotion.call(live2dModel, group, index ?? 0, 2);
    };

    const originalExpression = (live2dModel as any).expression;
    model.expression = (name: string | number) => {
      void originalExpression.call(live2dModel, name);
    };

    return model;
  }

  private async initializePixi(): Promise<void> {
    if (this.pixiInitialized) {
      return;
    }

    Live2DModel!.registerTicker(Ticker);

    const viewport = this.readViewportSize();

    this.app = new Application({
      view: this.canvas as HTMLCanvasElement,
      width: viewport.width,
      height: viewport.height,
      backgroundAlpha: 0,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      preserveDrawingBuffer: false
    });

    this.canvasWidth = viewport.width;
    this.canvasHeight = viewport.height;
    this.app.renderer.resize(this.canvasWidth, this.canvasHeight);

    this.pixiInitialized = true;
  }

  captureAlphaContour(sampleWidth = 192): AlphaContour | null {
    if (!this.model || !this.pixiInitialized || this.canvas.clientWidth <= 0 || this.canvas.clientHeight <= 0) return null;
    const sampleHeight = Math.max(1, Math.round(sampleWidth * this.canvas.clientHeight / this.canvas.clientWidth));
    if (this.contourRenderTexture === null) {
      this.contourRenderTexture = RenderTexture.create({ width: sampleWidth, height: sampleHeight, resolution: 1 });
    } else if (this.contourRenderTexture.width !== sampleWidth || this.contourRenderTexture.height !== sampleHeight) {
      this.contourRenderTexture.resize(sampleWidth, sampleHeight, true);
    }
    const transform = new Matrix();
    transform.scale(sampleWidth / this.canvas.clientWidth, sampleHeight / this.canvas.clientHeight);
    this.app.renderer.render(this.app.stage, {
      renderTexture: this.contourRenderTexture,
      clear: true,
      transform
    });
    const pixels = this.app.renderer.extract.pixels(this.contourRenderTexture);
    return buildOuterAlphaContour(new Uint8ClampedArray(pixels), sampleWidth, sampleHeight);
  }

  private readViewportSize(): { width: number; height: number } {
    const viewport = this.canvas.parentElement ?? this.canvas;
    return {
      width: Math.max(1, Math.round(viewport.clientWidth)),
      height: Math.max(1, Math.round(viewport.clientHeight))
    };
  }

  private calcBaseFit(originalWidth: number, originalHeight: number): void {
    if (this.baseFitCalculated) {
      return;
    }

    if (this.live2dModel) {
      this.live2dModel.anchor.set(0.5, 0.5);
      this.live2dModel.x = PET_BASE_WINDOW_WIDTH / 2;
      this.live2dModel.y = PET_BASE_WINDOW_HEIGHT / 2;
    }

    const screenWidth = PET_BASE_WINDOW_WIDTH;
    const screenHeight = PET_BASE_WINDOW_HEIGHT;
    const availableHeight = screenHeight;
    if (screenWidth <= 0 || screenHeight <= 0) {
      return;
    }

    if (originalWidth > 0 && originalHeight > 0) {
      const baseScale = Math.min(
        Math.max(1, screenWidth - PET_ITEM_PADDING * 2) / originalWidth,
        Math.max(1, availableHeight - PET_ITEM_PADDING * 2) / originalHeight
      );
      this.baseFitScale = Number.isFinite(baseScale) && baseScale > 0 ? baseScale : 1;
    } else if (this.live2dModel) {
      const bounds = this.live2dModel.getBounds();
      if (bounds) {
        const baseScale = Math.min(
          Math.max(1, screenWidth - PET_ITEM_PADDING * 2) / bounds.width,
          Math.max(1, availableHeight - PET_ITEM_PADDING * 2) / bounds.height
        );
        this.baseFitScale = Number.isFinite(baseScale) && baseScale > 0 ? baseScale : 1;
      }
    }

    if (this.live2dModel) {
      this.live2dModel.scale.set(this.baseFitScale * this.userScale);
    }
    this.baseFitCalculated = true;
  }

  private applyTransform(source: string): void {
    if (!this.live2dModel || !this.app.renderer) {
      return;
    }

    const screenWidth = this.canvasWidth || this.canvas.clientWidth;
    const screenHeight = this.canvasHeight || this.canvas.clientHeight;
    const availableHeight = screenHeight;
    if (screenWidth <= 0 || screenHeight <= 0) {
      return;
    }

    const nextScale = this.baseFitScale * this.userScale;
    this.live2dModel.scale.set(nextScale);
    this.live2dModel.x = this.placementX ?? screenWidth / 2;
    this.live2dModel.y = this.placementY ?? availableHeight / 2;

    this.logModelPlacement(nextScale);
  }

  private async ensureCubismCore(cubismCoreUrl: string): Promise<void> {
    if (this.cubismCoreLoaded || (window as any).Live2DCubismCore) {
      this.cubismCoreLoaded = true;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = cubismCoreUrl;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Cubism Core initialization failed. Missing file: ${cubismCoreUrl}`));
      document.head.appendChild(script);
    });

    if (!(window as any).Live2DCubismCore) {
      throw new Error('Cubism Core initialization failed: Live2DCubismCore global was not found.');
    }

    const module = await import('pixi-live2d-display-lipsyncpatch/cubism4');
    Live2DModel = module.Live2DModel;

    this.cubismCoreLoaded = true;
  }

  private logModelPlacement(nextScale: number): void {
    if (!this.model || !this.app.renderer) {
      return;
    }

    const now = Date.now();
    if (now - this.lastPlacementLogAt < 1500) {
      return;
    }
    this.lastPlacementLogAt = now;

    const bounds = this.model.getBounds();
    console.info('[Live2D] Model placement ' + JSON.stringify({
      rendererWidth: this.app.renderer.width,
      rendererHeight: this.app.renderer.height,
      modelWidth: this.model.width,
      modelHeight: this.model.height,
      internalWidth: this.model.internalModel?.width,
      internalHeight: this.model.internalModel?.height,
      originalWidth: this.model.internalModel?.originalWidth,
      originalHeight: this.model.internalModel?.originalHeight,
      scale: nextScale,
      x: this.model.x,
      y: this.model.y,
      bounds: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height
      }
    }));
  }

  private dumpModelInfo(modelJson: any, originalWidth: number, originalHeight: number): void {
    console.info('[Live2D] Model info: ' + JSON.stringify({
      engine: 'pixi-live2d-display-lipsyncpatch (Cubism 4)',
      modelWidth: originalWidth,
      modelHeight: originalHeight,
      textureCount: modelJson?.FileReferences?.Textures?.length,
      hasPhysics: !!modelJson?.FileReferences?.Physics,
      hasPose: !!modelJson?.FileReferences?.Pose
    }));
  }
}

function pointInDrawable(
  x: number,
  y: number,
  vertices: Float32Array,
  indices: Uint16Array
): boolean {
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i]! * 2;
    const b = indices[i + 1]! * 2;
    const c = indices[i + 2]! * 2;
    if (pointInTriangle(
      x,
      y,
      vertices[a]!, vertices[a + 1]!,
      vertices[b]!, vertices[b + 1]!,
      vertices[c]!, vertices[c + 1]!
    )) {
      return true;
    }
  }
  return false;
}

function pointInTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number
): boolean {
  const ab = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const bc = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const ca = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNegative = ab < -0.0001 || bc < -0.0001 || ca < -0.0001;
  const hasPositive = ab > 0.0001 || bc > 0.0001 || ca > 0.0001;
  return !(hasNegative && hasPositive);
}

function classifyBodyPartLabel(label: string): BodyPart {
  if (!label.trim()) return 'other';
  if (/(hair|bang|fringe|ponytail|头发|髮|刘海|鬓|马尾)/i.test(label)) return 'hair';
  if (/(face|eye|brow|nose|mouth|lip|cheek|forehead|脸|臉|眼|眉|鼻|嘴|唇|腮|额)/i.test(label)) return 'face';
  if (/(hand|arm|finger|wrist|palm|手|臂|指|腕|掌)/i.test(label)) return 'hand';
  if (/(leg|foot|feet|knee|shoe|boot|thigh|calf|sock|lower.?body|hem|腿|脚|腳|膝|鞋|靴|袜|襪|下半身|下摆|下擺)/i.test(label)) return 'leg';
  if (/(head|horn|ear|hat|cap|头|頭|角|耳|帽)/i.test(label)) return 'head';
  if (/(body|chest|breast|belly|waist|hip|torso|neck|shoulder|clothes|outfit|dress|skirt|身体|身體|胸|腹|腰|胯|脖|颈|頸|肩|衣|裙)/i.test(label)) return 'body';
  return 'other';
}

function classifyOutfitExpression(label: string): OutfitRegion | null {
  if (/(outfit|costume|wardrobe|full.?set|skin|dress|clothes|clothing|整套|套装|套裝|衣装|衣裝|服装|服裝|换装|換裝)/i.test(label)) return 'whole';
  if (/(hair|hairstyle|bang|fringe|ponytail|duanfa|panfa|changfa|头发|頭髮|髮型|发型|刘海|劉海|马尾|馬尾)/i.test(label)) return 'hair';
  if (/(glasses|eyeglass|yanjing|眼镜|眼鏡)/i.test(label)) return 'face';
  if (/(horn|hat|headwear|earring|jiao|帽|角|头饰|頭飾|耳饰|耳飾)/i.test(label)) return 'head';
  if (/(microphone|\bmic\b|handheld|prop|huatong|paizi|shanzi|麦克风|麥克風|话筒|話筒|扇子|牌子|手持)/i.test(label)) return 'hand';
  if (/(stocking|sock|shoe|boot|heisi|hexie|\bxie\b|丝袜|絲襪|袜|襪|鞋|靴)/i.test(label)) return 'leg';
  if (/(cape|vest|coat|jacket|shirt|skirt|pijian|majia|披肩|披风|披風|马甲|馬甲|外套|上衣|裙|衣服)/i.test(label)) return 'body';
  return null;
}

function isModelHotkey(value: unknown): value is ModelHotkey {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ModelHotkey>;
  return typeof candidate.name === 'string' &&
    (candidate.action === 'ToggleExpression' || candidate.action === 'TriggerAnimation' || candidate.action === 'RemoveAllExpressions') &&
    typeof candidate.file === 'string' &&
    Array.isArray(candidate.triggers) &&
    candidate.triggers.length > 0 &&
    candidate.triggers.every((trigger) => typeof trigger === 'string');
}

function normalizeModelAssetPath(value: string): string {
  return value.replaceAll('\\', '/').toLowerCase();
}

function matchesModelHotkey(triggers: string[], event: KeyboardEvent): boolean {
  const modifiers = new Set(triggers.filter((trigger) => /^(Left|Right)?(Control|Shift|Alt)$/iu.test(trigger)));
  const requiresControl = [...modifiers].some((trigger) => /control/iu.test(trigger));
  const requiresShift = [...modifiers].some((trigger) => /shift/iu.test(trigger));
  const requiresAlt = [...modifiers].some((trigger) => /alt/iu.test(trigger));
  if (event.ctrlKey !== requiresControl || event.shiftKey !== requiresShift || event.altKey !== requiresAlt || event.metaKey) return false;

  const primaryTriggers = triggers.filter((trigger) => !modifiers.has(trigger));
  return primaryTriggers.length === 1 && keyboardEventMatchesTrigger(event, primaryTriggers[0]!);
}

function keyboardEventMatchesTrigger(event: KeyboardEvent, trigger: string): boolean {
  if (/^N[0-9]$/u.test(trigger)) return event.code === `Digit${trigger.slice(1)}`;
  if (/^Numpad[0-9]$/iu.test(trigger)) return event.code.toLowerCase() === trigger.toLowerCase();
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/iu.test(trigger)) return event.code.toLowerCase() === trigger.toLowerCase();
  if (/^[A-Z]$/iu.test(trigger)) return event.code.toLowerCase() === `key${trigger}`.toLowerCase();
  return false;
}
