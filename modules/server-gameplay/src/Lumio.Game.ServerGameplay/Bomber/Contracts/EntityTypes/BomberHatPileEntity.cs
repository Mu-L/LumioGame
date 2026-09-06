using Lumio.GameRuntime.Ecs;
using Lumio.Game.ServerGameplay.Bomber.Contracts.Components;

namespace Lumio.Game.ServerGameplay.Bomber.Contracts.EntityTypes;

/// <summary>死亡或退出散落的帽堆。design.md §9.2。位置归 <see cref="LogicTransform"/>。</summary>
[EntityType(Mode.CS)]
[Has(typeof(ObserverComponent))]
[Has(typeof(LogicTransform))]
[Has(typeof(BomberHatPile))]
public abstract class BomberHatPileEntity
{
}
