# Live2D renderer module

Live2D 直接属于 Electron renderer，负责模型加载、动画、口型、透明命中测试和窗口拖动交互。
角色与动作来源是 `character.changed`、`character.presentation`、`tts.audio_ready` 等业务事件；
本模块不与 C# 建立独立管道。
