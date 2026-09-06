using Lumio.GameRuntime.Ecs;
using Lumio.Game.ServerGameplay.Bomber.Contracts.Components;

namespace Lumio.Game.ServerGameplay.Bomber.Contracts.EntityTypes;

/// <summary>一颗放置在棋盘上、正在计时的炸弹。design.md §7。位置归 <see cref="LogicTransform"/>。</summary>
[EntityType(Mode.CS)]
[Has(typeof(ObserverComponent))]
[Has(typeof(LogicTransform))]
[Has(typeof(BomberBombState))]
public abstract class BomberBombEntity
{
}
