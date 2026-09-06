using Lumio.GameRuntime.Ecs;
using Lumio.Game.ServerGameplay.Bomber.Contracts.Components;

namespace Lumio.Game.ServerGameplay.Bomber.Contracts.EntityTypes;

/// <summary>
/// 玩家实体。位置唯一真值是 <see cref="LogicTransform"/>（契约 §1.1/§1.2），所在格由逻辑位置推导。
/// 属性（血量 / 火力 / 移速 / 手上炸弹数）走 <c>玩家属性 : AttributeComponent</c> 两本账，
/// 与 <c>AbilityComponent</c>（移动 / 放弹两个技能条目）、<c>EffectComponent</c> 随 R-00468 / R-00480 挂上。
/// </summary>
[EntityType(Mode.CS)]
[Has(typeof(ObserverComponent))]
[Has(typeof(LogicTransform))]
[Has(typeof(BomberPlayerState))]
public abstract class BomberPlayerEntity
{
}
